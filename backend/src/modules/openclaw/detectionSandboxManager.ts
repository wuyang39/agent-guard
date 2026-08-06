import { createHash, createPublicKey, randomBytes, type KeyObject } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import type { NativeGuardStatus } from "@agent-guard/contracts";
import { resolveOpenClawCliInvocation } from "../agent/openclawAdapter";
import { generateDetectionOpenClawConfig, detectionConfigDigest, type DetectionOpenClawConfig } from "./detectionOpenClawConfig";
import { createOpenClawControlClient, type NativeGuardCapability } from "./openclawControlClient";
import {
  isCompatibleNativeGuardVersion,
  parseNativeGuardGatewayAttestation,
} from "./nativeGuardLiveCapability";

const RUN_LABEL_KEY = "agent-guard.run-group";
const RUN_ROLE_LABEL_KEY = "agent-guard.role";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;
const MAX_GATEWAY_BOOTSTRAP_BYTES = 8 * 1024;
const GATEWAY_BOOTSTRAP_TIMEOUT_MS = 60_000;
const MAX_GATEWAY_READINESS_BYTES = 64 * 1024;
const GATEWAY_READINESS_MAX_ATTEMPTS = 240;
const RESPONSE_CANCEL_TIMEOUT_MS = 25;

export type DetectionCommandInput = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type DetectionCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type DetectionCommandRunner = (input: DetectionCommandInput) => Promise<DetectionCommandResult>;

export type DetectionGatewayProcess = {
  url: string;
  token: string;
  attestationPublicKey: KeyObject;
  process: {
    kill(signal?: NodeJS.Signals): void;
    forceKill?: () => void;
    waitForExit(): Promise<void>;
  };
};

export type DetectionGatewayLauncher = (input: {
  cliPath: string;
  profileRoot: string;
  configPath: string;
  stateDir: string;
  workspaceDir: string;
  token: string;
  gatewayUrl: string;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
}) => Promise<DetectionGatewayProcess>;

export type DetectionSandboxManagerOptions = {
  runGroupId: string;
  image: string;
  cliPath?: string;
  pluginRoot?: string;
  userConfig?: unknown;
  outputRoot?: string;
  commandRunner?: DetectionCommandRunner;
  gatewayLauncher?: DetectionGatewayLauncher;
  signal?: AbortSignal;
  onCleanup?: () => void;
  networkCase?: boolean;
  capabilityProbe?: (input: {
    cliPath?: string;
    env: Record<string, string>;
    isolatedProfile: true;
  }) => Promise<NativeGuardCapability>;
  runtimeStatusProbe?: (input: {
    gatewayUrl: string;
    gatewayToken: string;
  }) => Promise<NativeGuardStatus>;
  gatewayAttestationProbe?: (input: {
    gatewayUrl: string;
    gatewayToken: string;
    challenge: string;
  }) => Promise<unknown>;
  gatewayShutdownTimeoutMs?: {
    graceful: number;
    forced: number;
  };
};

export type DetectionSandboxEvidence = {
  runGroupId: string;
  image: string;
  imageId: string;
  openclawVersion: string;
  profileRoot: string;
  configPath: string;
  configDigest: string;
  gatewayUrl?: string;
  networkMode: "none" | "internal";
  containerId?: string;
  sinkLogs?: string;
  status: "preflight_passed" | "attested" | "cleaned";
};

export class DetectionSandboxError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DetectionSandboxError";
  }
}

export class SandboxPreflightError extends DetectionSandboxError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "SandboxPreflightError";
  }
}

export class SandboxAttestationError extends DetectionSandboxError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "SandboxAttestationError";
  }
}

export class DetectionSandboxManager {
  private readonly options: DetectionSandboxManagerOptions;
  private readonly pluginRoot: string;
  private readonly run: DetectionCommandRunner;
  private readonly abortController = new AbortController();
  private profileRoot?: string;
  private configPath?: string;
  private evidenceRoot?: string;
  private imageId?: string;
  private config?: DetectionOpenClawConfig;
  private gateway?: DetectionGatewayProcess;
  private gatewayGeneration = 0;
  private activeGatewayGeneration?: number;
  private expectedGatewayShutdownGeneration?: number;
  private gatewayLifetimeFailure?: Promise<SandboxPreflightError>;
  private resolveGatewayLifetimeFailure?: (error: SandboxPreflightError) => void;
  private gatewayFailure?: SandboxPreflightError;
  private startPromise?: Promise<DetectionSandboxEvidence>;
  private liveValidated = false;
  private cleaned = false;
  private cleanupNotified = false;
  private cleanupPromise?: Promise<void>;
  private resolvedOpenClawVersion?: string;
  private staticCapability?: NativeGuardCapability;
  private networkName?: string;
  private sinkContainerId?: string;
  private sinkLogs?: string;
  private cleanupErrors: { operation: string; error: unknown }[] = [];
  private externalAbortListener?: () => void;

  constructor(options: DetectionSandboxManagerOptions) {
    if (!options.runGroupId.trim() || !/^[A-Za-z0-9._-]{1,120}$/.test(options.runGroupId)) {
      throw new TypeError("runGroupId is invalid");
    }
    if (!options.image.trim()) throw new TypeError("image is required");
    if (options.pluginRoot !== undefined && !options.pluginRoot.trim()) {
      throw new TypeError("pluginRoot is invalid");
    }
    if (
      options.gatewayShutdownTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.gatewayShutdownTimeoutMs.graceful) ||
        options.gatewayShutdownTimeoutMs.graceful < 1 ||
        !Number.isSafeInteger(options.gatewayShutdownTimeoutMs.forced) ||
        options.gatewayShutdownTimeoutMs.forced < 1)
    ) {
      throw new TypeError("gatewayShutdownTimeoutMs is invalid");
    }
    this.options = { ...options, runGroupId: options.runGroupId, image: options.image };
    this.pluginRoot = path.resolve(
      options.pluginRoot ?? path.resolve(process.cwd(), "plugins", "agent-guard-supervision"),
    );
    this.run = options.commandRunner ?? runCommand;
    if (options.signal) {
      const abort = (): void => this.requestCancellation();
      this.externalAbortListener = abort;
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) this.requestCancellation();
    }
  }

  get signal(): AbortSignal { return this.abortController.signal; }

  getCapturedSinkLogs(): string | undefined { return this.sinkLogs; }

  getGatewayCredentials(): { gatewayUrl: string; gatewayToken: string } | undefined {
    return this.liveValidated && this.gateway && !this.gatewayFailure
      ? { gatewayUrl: this.gateway.url, gatewayToken: this.gateway.token }
      : undefined;
  }

  waitForGatewayFailure(): Promise<SandboxPreflightError> {
    return this.gatewayLifetimeFailure ?? new Promise<SandboxPreflightError>(() => undefined);
  }

  runWhileGatewayAlive<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return this.raceGatewayLifetime(operation, true);
  }

  cancel(): void { this.requestCancellation(); }

  getCleanupErrors(): readonly { operation: string; error: unknown }[] {
    return this.cleanupErrors;
  }

  async preflight(): Promise<DetectionSandboxEvidence> {
    if (this.cleaned) throw new SandboxPreflightError("CLEANED", "Detection sandbox has already been cleaned.");
    if (this.profileRoot && this.imageId && this.staticCapability) return this.currentEvidence();
    this.throwIfAborted();
    let dockerVersion: DetectionCommandResult;
    try {
      dockerVersion = await this.command("docker", ["version", "--format", "{{.Server.Version}}"]);
    } catch (error) {
      if (error instanceof DetectionSandboxError) throw error;
      if (this.signal.aborted) throw new SandboxPreflightError("CANCELLED", "Detection sandbox operation was cancelled.");
      throw new SandboxPreflightError("DOCKER_UNAVAILABLE", "Docker daemon is unavailable.");
    }
    if (dockerVersion.exitCode !== 0) {
      throw new SandboxPreflightError("DOCKER_UNAVAILABLE", "Docker daemon is unavailable.");
    }

    const pinnedImage = this.options.image.match(/@sha256:([0-9a-f]{64})$/i);
    if (!pinnedImage) {
      throw new SandboxPreflightError("IMAGE_NOT_IMMUTABLE", "Detection image reference must be pinned by digest.");
    }
    let imageResult: DetectionCommandResult;
    try {
      imageResult = await this.command("docker", ["image", "inspect", this.options.image, "--format", "{{json .}}"]);
    } catch (error) {
      if (error instanceof DetectionSandboxError) throw error;
      if (this.signal.aborted) throw new SandboxPreflightError("CANCELLED", "Detection sandbox operation was cancelled.");
      throw new SandboxPreflightError("IMAGE_UNAVAILABLE", "Detection image is unavailable.");
    }
    if (imageResult.exitCode !== 0) {
      throw new SandboxPreflightError("IMAGE_UNAVAILABLE", "Detection image is unavailable.");
    }
    let imageRecord: unknown;
    try { imageRecord = JSON.parse(imageResult.stdout); } catch { imageRecord = undefined; }
    if (Array.isArray(imageRecord)) imageRecord = imageRecord[0];
    const imageId = isRecord(imageRecord) && typeof imageRecord.Id === "string" ? imageRecord.Id : "";
    const repoDigests = isRecord(imageRecord) && Array.isArray(imageRecord.RepoDigests) ? imageRecord.RepoDigests : [];
    if (!/^sha256:[0-9a-f]{64}$/i.test(imageId)) {
      throw new SandboxPreflightError("IMAGE_NOT_IMMUTABLE", "Detection image did not resolve to an immutable image id.");
    }
    if (!repoDigests.some((digest) => typeof digest === "string" && digest.toLowerCase() === this.options.image.toLowerCase())) {
      throw new SandboxPreflightError("IMAGE_DIGEST_MISMATCH", "Detection image id did not match the pinned digest.");
    }
    this.imageId = imageId;

    try {
      await this.createProfile();
      const version = await this.probeOpenClawVersion();
      this.resolvedOpenClawVersion = version;
      const capability = await this.probeOpenClawCapability();
      if (
        capability.openclawVersion !== version ||
        !capability.supportsNativeGuard ||
        capability.finalizerAssurance !== "isolated_profile"
      ) {
        throw new SandboxPreflightError(
          "OPENCLAW_CAPABILITY_UNAVAILABLE",
          "OpenClaw static capability inventory does not support isolated native guard activation.",
        );
      }
      this.staticCapability = capability;
      if (this.options.networkCase) await this.createNetworkSink();
      return {
        runGroupId: this.options.runGroupId,
        image: this.options.image,
        imageId,
        openclawVersion: version,
        profileRoot: this.profileRoot!,
        configPath: this.configPath!,
        configDigest: detectionConfigDigest(this.config!),
        networkMode: this.options.networkCase ? "internal" : "none",
        status: "preflight_passed",
      };
    } catch (error) {
      await this.cleanup().catch(() => undefined);
      if (error instanceof SandboxPreflightError) throw error;
      throw new SandboxPreflightError("OPENCLAW_CAPABILITY_UNAVAILABLE", "OpenClaw capability preflight failed.");
    }
  }

  start(): Promise<DetectionSandboxEvidence> {
    if (this.gatewayFailure) return Promise.reject(this.gatewayFailure);
    if (this.liveValidated && this.gateway) {
      this.assertGatewayAlive(this.gateway, this.activeGatewayGeneration, true);
      return this.currentEvidence().then((evidence) => ({
        ...evidence,
        gatewayUrl: this.gateway!.url,
      }));
    }
    if (this.startPromise) return this.startPromise;
    const started = this.startOnce();
    this.startPromise = started;
    const clear = (): void => {
      if (this.startPromise === started) this.startPromise = undefined;
    };
    void started.then(clear, clear);
    return started;
  }

  private async startOnce(): Promise<DetectionSandboxEvidence> {
    const evidence =
      this.profileRoot && this.staticCapability
        ? await this.currentEvidence()
        : await this.preflight();
    this.throwIfAborted();
    const token = randomBytes(32).toString("base64url");
    const port = await ephemeralPort();
    const gatewayUrl = `http://127.0.0.1:${port}`;
    const cliPath = this.options.cliPath ?? "openclaw";
    const env: NodeJS.ProcessEnv = {
      ...strictBaseEnv(),
      OPENCLAW_CONFIG_PATH: this.configPath,
      OPENCLAW_STATE_DIR: path.join(this.profileRoot!, "state"),
      OPENCLAW_WORKSPACE_DIR: path.join(this.profileRoot!, "workspace"),
      OPENCLAW_WORKSPACE: path.join(this.profileRoot!, "workspace"),
      OPENCLAW_HOME: this.profileRoot,
      OPENCLAW_CONFIG_DIR: this.profileRoot,
      OPENCLAW_PLUGIN_DIRS: "",
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_URL: gatewayUrl,
      HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "*",
    };
    try {
      const launchedGateway = this.options.gatewayLauncher
        ? await this.options.gatewayLauncher({
            cliPath, profileRoot: this.profileRoot!, configPath: this.configPath!,
            stateDir: path.join(this.profileRoot!, "state"), workspaceDir: path.join(this.profileRoot!, "workspace"),
            token, gatewayUrl, signal: this.signal, env,
          })
        : await launchGateway({
            cliPath, profileRoot: this.profileRoot!, configPath: this.configPath!,
            stateDir: path.join(this.profileRoot!, "state"), workspaceDir: path.join(this.profileRoot!, "workspace"),
            token, gatewayUrl, signal: this.signal, env,
          });
      this.gateway = launchedGateway;
      const generation = this.armGatewayLifetime(launchedGateway);
      await this.raceGatewayLifetime(async () => {
        const capability = this.staticCapability;
        const runtimeStatus = await this.probeRuntimeStatus();
        if (
          (runtimeStatus.coverage !== "off" && runtimeStatus.coverage !== "ready") ||
          runtimeStatus.activeLeaseCount !== 0
        ) {
          throw new SandboxPreflightError(
            "OPENCLAW_CAPABILITY_UNAVAILABLE",
            "The started OpenClaw Gateway runtime is not ready for isolated native guard activation.",
          );
        }
        const gatewayAttestation = await this.probeGatewayAttestation(
          randomBytes(24).toString("base64url"),
        );
        if (
          !capability ||
          gatewayAttestation.openclawVersion !== this.resolvedOpenClawVersion ||
          capability.openclawVersion !== this.resolvedOpenClawVersion ||
          !capability.supportsNativeGuard ||
          capability.finalizerAssurance !== "isolated_profile"
        ) {
          throw new SandboxPreflightError(
            "OPENCLAW_CAPABILITY_UNAVAILABLE",
            "The started OpenClaw Gateway did not provide the required live native guard capability.",
          );
        }
        this.assertGatewayAlive(launchedGateway, generation, false);
        this.liveValidated = true;
      }, false);
      return { ...evidence, gatewayUrl: this.gateway.url };
    } catch (error) {
      const gatewayStarted = this.gateway !== undefined;
      await this.cleanup();
      if (!gatewayStarted) throw error;
      if (error instanceof DetectionSandboxError) throw error;
      throw new SandboxPreflightError(
        "OPENCLAW_CAPABILITY_UNAVAILABLE",
        "OpenClaw live capability inspection failed after Gateway startup.",
      );
    }
  }

  async attestSession(sessionKey: string, phase: "before" | "after" = "after"): Promise<DetectionSandboxEvidence> {
    return this.runWhileGatewayAlive(
      async () => this.attestSessionWhileAlive(sessionKey, phase),
    );
  }

  private async attestSessionWhileAlive(
    sessionKey: string,
    phase: "before" | "after",
  ): Promise<DetectionSandboxEvidence> {
    if (!sessionKey.trim()) throw new SandboxAttestationError("INVALID_SESSION_KEY", "Session key is required.");
    if (!this.profileRoot || !this.config || !this.imageId) {
      throw new SandboxAttestationError("NOT_STARTED", "Detection sandbox has not passed preflight.");
    }
    const env = this.profileEnv();
    const cli = resolveOpenClawCliInvocation(this.options.cliPath);
    const explain = await this.command(
      cli.command,
      [...cli.argsPrefix, "sandbox", "explain", "--session", sessionKey, "--json"],
      { ...cli.env, ...env },
    );
    if (explain.exitCode !== 0 || !matchesSandboxExplain(explain.stdout)) {
      throw new SandboxAttestationError("SANDBOX_EXPLAIN_MISMATCH", "OpenClaw sandbox explain did not match the detection profile.");
    }
    let containerId: string | undefined;
    if (phase === "after") {
      const inspected = await this.inspectLabeledContainer();
      containerId = inspected.containerId;
      if (!inspected.matches) {
        throw new SandboxAttestationError("CONTAINER_ATTESTATION_MISMATCH", "Labeled detection container did not match the requested limits.");
      }
    }
    const evidence = await this.currentEvidence();
    let sinkLogs: string | undefined;
    if (phase === "after" && this.sinkContainerId) {
      const logs = await this.command("docker", ["logs", "--tail", "8192", this.sinkContainerId]);
      sinkLogs = `${logs.stdout}${logs.stderr}`.slice(0, 65_536);
      this.sinkLogs = sinkLogs;
    }
    return { ...evidence, containerId, ...(sinkLogs !== undefined ? { sinkLogs } : {}), status: "attested" as const };
  }

  async runSession<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
    try {
      await this.start();
      return await this.runWhileGatewayAlive(async () => {
        await this.attestSessionWhileAlive(sessionKey, "before");
        const value = await operation();
        await this.attestSessionWhileAlive(sessionKey, "after");
        return value;
      });
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    if (this.cleanupPromise) return this.cleanupPromise;
    this.liveValidated = false;
    this.staticCapability = undefined;
    this.expectedGatewayShutdownGeneration = this.activeGatewayGeneration;
    this.cleanupPromise = this.performCleanupWithRetry();
    try {
      await this.cleanupPromise;
      this.cleaned = true;
      this.profileRoot = undefined;
      this.configPath = undefined;
      this.config = undefined;
      this.imageId = undefined;
      this.networkName = undefined;
      this.sinkContainerId = undefined;
      this.gateway = undefined;
      this.activeGatewayGeneration = undefined;
      if (this.options.signal && this.externalAbortListener) {
        this.options.signal.removeEventListener("abort", this.externalAbortListener);
        this.externalAbortListener = undefined;
      }
    } finally {
      this.cleanupPromise = undefined;
    }
  }

  private async performCleanupWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.performCleanupOnce();
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Detection cleanup failed.");
  }

  private async performCleanupOnce(): Promise<void> {
    const failureEntries: { operation: string; error: unknown }[] = [];
    const attempt = async (operation: string, fn: () => Promise<void>): Promise<void> => {
      try { await fn(); } catch (error) { failureEntries.push({ operation, error }); }
    };
    await attempt("sink-log-capture", async () => {
      if (!this.sinkContainerId) return;
      const logs = await this.cleanupCommand("docker", ["logs", "--tail", "8192", this.sinkContainerId]);
      this.sinkLogs = `${logs.stdout}${logs.stderr}`.slice(0, 65_536);
    });
    await attempt("gateway-terminate", async () => {
      const gatewayProcess = this.gateway?.process;
      if (!gatewayProcess) return;
      gatewayProcess.kill("SIGTERM");
      if (typeof gatewayProcess.waitForExit !== "function") return;
      const shutdownTimeouts = this.options.gatewayShutdownTimeoutMs ?? {
        graceful: 2_000,
        forced: 1_000,
      };
      if (!await waitForExitBounded(
        gatewayProcess.waitForExit,
        shutdownTimeouts.graceful,
      )) {
        gatewayProcess.forceKill?.();
        if (!await waitForExitBounded(gatewayProcess.waitForExit, shutdownTimeouts.forced)) {
          throw new Error("Detection Gateway did not exit after force termination.");
        }
      }
    });
    await attempt("container-cleanup", async () => {
      const containers = await this.cleanupCommand("docker", ["ps", "-aq", "--filter", `label=${RUN_LABEL_KEY}=${this.options.runGroupId}`]);
      if (containers.exitCode !== 0) throw new Error("Detection container inventory cleanup failed.");
      const ids = new Set(parseDockerIds(containers.stdout, "container"));
      if (!ids.size) return;
      const removed = await this.cleanupCommand("docker", ["rm", "-f", ...ids]);
      if (removed.exitCode !== 0) throw new Error("Detection container cleanup failed.");
    });
    await attempt("network-cleanup", async () => {
      const networks = await this.cleanupCommand("docker", ["network", "ls", "-q", "--filter", `label=${RUN_LABEL_KEY}=${this.options.runGroupId}`]);
      if (networks.exitCode !== 0) throw new Error("Detection network inventory cleanup failed.");
      const networkIds = parseDockerIds(networks.stdout, "network");
      if (!networkIds.length) return;
      const removed = await this.cleanupCommand("docker", ["network", "rm", ...networkIds]);
      if (removed.exitCode !== 0) throw new Error("Detection network cleanup failed.");
    });
    await attempt("profile-remove", async () => {
      if (!this.profileRoot || !isSafeTempRoot(this.profileRoot)) return;
      const stat = await fs.lstat(this.profileRoot).catch(() => undefined);
      if (stat?.isDirectory() && !stat.isSymbolicLink()) await fs.rm(this.profileRoot, { recursive: true, force: true });
    });
    if (failureEntries.length) {
      this.cleanupErrors = [...this.cleanupErrors, ...failureEntries];
      const names = failureEntries.map((f) => f.operation).join(", ");
      throw new Error(`Detection cleanup failed: ${names}`);
    }
    if (!this.cleanupNotified) {
      this.cleanupNotified = true;
      this.options.onCleanup?.();
    }
  }

  private async createProfile(): Promise<void> {
    await this.assertPluginPackageAvailable();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `agent-guard-${this.options.runGroupId}-`));
    await fs.chmod(root, 0o700);
    this.profileRoot = root;
    const markerDir = path.join(root, "agent-guard", "markers");
    const spoolDir = path.join(root, "agent-guard", "spool");
    await Promise.all([
      fs.mkdir(path.join(root, "state"), { mode: 0o700 }),
      fs.mkdir(path.join(root, "workspace"), { mode: 0o700 }),
      fs.mkdir(markerDir, { recursive: true, mode: 0o700 }),
      fs.mkdir(spoolDir, { recursive: true, mode: 0o700 }),
    ]);
    this.config = generateDetectionOpenClawConfig({
      userConfig: this.options.userConfig,
      pluginRoot: this.pluginRoot,
      markerDir,
      spoolDir,
    });
    this.config.agents.defaults.sandbox.docker.image = this.imageId;
    this.config.agents.defaults.sandbox.docker.labels = {
      [RUN_LABEL_KEY]: this.options.runGroupId,
      [RUN_ROLE_LABEL_KEY]: "agent",
    };
    if (this.options.networkCase) {
      this.config.agents.defaults.sandbox.docker.network = "internal";
    }
    this.configPath = path.join(root, "openclaw.json");
    await fs.writeFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
    const outputBase = path.resolve(this.options.outputRoot ?? path.join(process.cwd(), "outputs", "openclaw-detection"));
    await assertNoSymlinkAncestors(outputBase);
    const baseStat = await fs.lstat(outputBase).catch(() => undefined);
    if (baseStat?.isSymbolicLink() || (baseStat && !baseStat.isDirectory())) {
      throw new SandboxPreflightError("INVALID_OUTPUT_ROOT", "Detection evidence root must be a real directory.");
    }
    await fs.mkdir(outputBase, { recursive: true, mode: 0o700 });
    this.evidenceRoot = path.resolve(outputBase, this.options.runGroupId);
    if (!this.evidenceRoot.startsWith(`${outputBase}${path.sep}`)) {
      throw new SandboxPreflightError("INVALID_OUTPUT_ROOT", "Detection evidence path escaped its output root.");
    }
    const existingEvidence = await fs.lstat(this.evidenceRoot).catch(() => undefined);
    if (existingEvidence?.isSymbolicLink() || (existingEvidence && !existingEvidence.isDirectory())) {
      throw new SandboxPreflightError("INVALID_OUTPUT_ROOT", "Detection evidence directory must not be a symlink.");
    }
    await fs.mkdir(this.evidenceRoot, { recursive: true, mode: 0o700 });
    await assertNoSymlinkAncestors(this.evidenceRoot);
    await this.writeEvidence("config.json", this.config);
    await this.writeEvidence("hashes.json", {
      configSha256: createHash("sha256").update(JSON.stringify(this.config), "utf8").digest("hex"),
      imageId: this.imageId,
    });
  }

  private async assertPluginPackageAvailable(): Promise<void> {
    for (const relativePath of ["openclaw.plugin.json", path.join("dist", "index.js")]) {
      const packagePath = path.join(this.pluginRoot, relativePath);
      const stat = await fs.stat(packagePath).catch(() => undefined);
      if (!stat?.isFile()) {
        throw new SandboxPreflightError(
          "OPENCLAW_PLUGIN_UNAVAILABLE",
          `Agent Guard OpenClaw plugin package is incomplete: missing ${relativePath} under ${this.pluginRoot}. Build it with npm run build:openclaw-plugin.`,
        );
      }
    }
  }

  private async createNetworkSink(): Promise<void> {
    this.networkName = `agent-guard-${this.options.runGroupId}`;
    const network = await this.command("docker", ["network", "create", "--internal", "--label", `${RUN_LABEL_KEY}=${this.options.runGroupId}`, this.networkName]);
    if (network.exitCode !== 0) throw new SandboxPreflightError("NETWORK_SINK_UNAVAILABLE", "Could not create the controlled detection network.");
    const sink = await this.command("docker", [
      "run", "-d", "--user", "65532:65532", "--read-only",
      "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", "/run",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "128", "--memory", "512m", "--memory-swap", "512m", "--cpus", "1", "--ulimit", "nofile=1024:1024",
      "--label", `${RUN_LABEL_KEY}=${this.options.runGroupId}`,
      "--label", `${RUN_ROLE_LABEL_KEY}=sink`,
      "--network", this.networkName, "--network-alias", "sink", this.imageId!,
      "python3", "-u", "-m", "http.server", "8080",
    ]);
    if (sink.exitCode !== 0 || !firstLine(sink.stdout)) {
      throw new SandboxPreflightError("NETWORK_SINK_UNAVAILABLE", "Could not start the controlled detection sink.");
    }
    this.sinkContainerId = firstLine(sink.stdout);
    this.config!.agents.defaults.sandbox.docker.network = this.networkName;
    await fs.writeFile(this.configPath!, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 });
    await this.writeEvidence("config.json", this.config);
    await this.writeEvidence("hashes.json", {
      configSha256: createHash("sha256").update(JSON.stringify(this.config), "utf8").digest("hex"),
      imageId: this.imageId,
    });
  }

  private async probeOpenClawCapability(): Promise<NativeGuardCapability> {
    const env = stringEnv(this.profileEnv());
    delete env.OPENCLAW_GATEWAY_TOKEN;
    delete env.OPENCLAW_GATEWAY_URL;
    if (this.options.capabilityProbe) {
      return this.options.capabilityProbe({
        cliPath: this.options.cliPath,
        env,
        isolatedProfile: true,
      });
    }
    const client = createOpenClawControlClient({
      gatewayToken: "detection-capability-probe",
      timeoutMs: COMMAND_TIMEOUT_MS,
      commandRunner: async (input) => this.run({
        command: input.command,
        args: input.args,
        env: input.env,
        timeoutMs: input.timeoutMs,
        signal: this.signal,
      }),
    });
    try {
      return await client.inspectCapabilities({
        cliPath: this.options.cliPath,
        env,
        isolatedProfile: true,
        inheritProcessEnv: false,
        signal: this.signal,
      });
    } catch {
      if (this.signal.aborted) throw new SandboxPreflightError("CANCELLED", "Detection sandbox operation was cancelled.");
      throw new SandboxPreflightError("OPENCLAW_CAPABILITY_UNAVAILABLE", "OpenClaw capability inventory is unavailable.");
    }
  }

  private async probeGatewayAttestation(challenge: string) {
    const gateway = this.gateway;
    if (!gateway) {
      throw new SandboxPreflightError(
        "OPENCLAW_CAPABILITY_UNAVAILABLE",
        "OpenClaw Gateway credentials are unavailable for runtime attestation.",
      );
    }
    const client = createOpenClawControlClient({ gatewayToken: gateway.token });
    try {
      if (this.options.gatewayAttestationProbe) {
        const value = await this.options.gatewayAttestationProbe({
          gatewayUrl: gateway.url,
          gatewayToken: gateway.token,
          challenge,
        });
        const attestation = parseNativeGuardGatewayAttestation(value, {
          gatewayUrl: gateway.url,
          challenge,
          attestationPublicKey: gateway.attestationPublicKey,
        });
        if (!attestation) throw new Error("Invalid injected Gateway attestation.");
        return attestation;
      }
      return await client.attestGateway({
        signal: this.signal,
        gatewayUrl: gateway.url,
        challenge,
        attestationPublicKey: gateway.attestationPublicKey,
      });
    } catch {
      if (this.signal.aborted) {
        throw new SandboxPreflightError("CANCELLED", "Detection sandbox operation was cancelled.");
      }
      throw new SandboxPreflightError(
        "OPENCLAW_CAPABILITY_UNAVAILABLE",
        "OpenClaw Gateway runtime attestation is unavailable.",
      );
    }
  }

  private async probeRuntimeStatus(): Promise<NativeGuardStatus> {
    const gateway = this.gateway;
    if (!gateway) {
      throw new SandboxPreflightError(
        "OPENCLAW_CAPABILITY_UNAVAILABLE",
        "OpenClaw Gateway credentials are unavailable for runtime inspection.",
      );
    }
    if (this.options.runtimeStatusProbe) {
      return this.options.runtimeStatusProbe({
        gatewayUrl: gateway.url,
        gatewayToken: gateway.token,
      });
    }
    const client = createOpenClawControlClient({ gatewayToken: gateway.token });
    try {
      return await client.status(gateway.url);
    } catch {
      throw new SandboxPreflightError(
        "OPENCLAW_CAPABILITY_UNAVAILABLE",
        "OpenClaw Gateway runtime status is unavailable.",
      );
    }
  }

  private async probeOpenClawVersion(): Promise<string> {
    const cli = resolveOpenClawCliInvocation(this.options.cliPath);
    const result = await this.command(
      cli.command,
      [...cli.argsPrefix, "--version"],
      { ...cli.env, ...this.profileEnv() },
    );
    if (result.exitCode !== 0) {
      throw new SandboxPreflightError(
        "OPENCLAW_UNSUPPORTED",
        "OpenClaw detection runtime version is unavailable.",
      );
    }
    const version = result.stdout.match(
      /(?:^|\D)(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/,
    )?.[1];
    if (!version || !isCompatibleNativeGuardVersion(version)) {
      throw new SandboxPreflightError(
        "OPENCLAW_UNSUPPORTED",
        "OpenClaw detection runtime is unsupported.",
      );
    }
    return version;
  }

  private profileEnv(): NodeJS.ProcessEnv {
    return {
      ...strictBaseEnv(),
      OPENCLAW_CONFIG_PATH: this.configPath,
      OPENCLAW_STATE_DIR: path.join(this.profileRoot!, "state"),
      OPENCLAW_WORKSPACE_DIR: path.join(this.profileRoot!, "workspace"),
      OPENCLAW_WORKSPACE: path.join(this.profileRoot!, "workspace"),
      OPENCLAW_HOME: this.profileRoot,
      OPENCLAW_CONFIG_DIR: this.profileRoot,
      OPENCLAW_PLUGIN_DIRS: "",
      ...(this.gateway?.token ? { OPENCLAW_GATEWAY_TOKEN: this.gateway.token } : {}),
      ...(this.gateway?.url ? { OPENCLAW_GATEWAY_URL: this.gateway.url } : {}),
    };
  }

  private async currentEvidence(): Promise<DetectionSandboxEvidence> {
    if (!this.profileRoot || !this.configPath || !this.config || !this.imageId) throw new SandboxPreflightError("NOT_READY", "Detection sandbox is not ready.");
    return {
      runGroupId: this.options.runGroupId, image: this.options.image, imageId: this.imageId,
      openclawVersion: this.resolvedOpenClawVersion ?? "unknown", profileRoot: this.profileRoot,
      configPath: this.configPath, configDigest: detectionConfigDigest(this.config),
      networkMode: this.options.networkCase ? "internal" : "none", status: "preflight_passed",
    };
  }

  private async inspectLabeledContainer(): Promise<{ containerId?: string; matches: boolean }> {
    const listed = await this.command("docker", ["ps", "-aq", "--filter", `label=${RUN_LABEL_KEY}=${this.options.runGroupId}`]);
    if (listed.exitCode !== 0) return { matches: false };
    const ids = parseDockerIds(listed.stdout, "container");
    if (!ids.length) return { matches: false };
    const result = await this.command("docker", ["inspect", "--format", "{{json .}}", ...ids]);
    if (result.exitCode !== 0) return { matches: false };
    const records = parseInspectRecords(result.stdout);
    if (records.length !== ids.length || records.some((record) => {
      const config = isRecord(record.Config) ? record.Config : {};
      const labels = isRecord(config.Labels) ? config.Labels : {};
      return labels[RUN_LABEL_KEY] !== this.options.runGroupId;
    })) return { matches: false };
    const roleOf = (record: Record<string, unknown>): unknown => {
      const config = isRecord(record.Config) ? record.Config : {};
      const labels = isRecord(config.Labels) ? config.Labels : {};
      return labels[RUN_ROLE_LABEL_KEY];
    };
    const agentRecords = records.filter((record) => roleOf(record) === "agent");
    const sinkRecords = records.filter((record) => roleOf(record) === "sink");
    if (
      agentRecords.length !== 1 ||
      records.length !== agentRecords.length + sinkRecords.length ||
      (this.options.networkCase
        ? sinkRecords.length !== 1 || sinkRecords[0].Id !== this.sinkContainerId
        : sinkRecords.length !== 0)
    ) return { matches: false };
    if (this.options.networkCase && !this.sinkMatches(sinkRecords[0])) return { matches: false };
    const matches = agentRecords.every((record) => this.containerMatches(record));
    return { containerId: typeof agentRecords[0].Id === "string" ? agentRecords[0].Id : undefined, matches };
  }

  private containerMatches(record: Record<string, unknown>): boolean {
    const host = isRecord(record.HostConfig) ? record.HostConfig : {};
    const config = isRecord(record.Config) ? record.Config : {};
    const labels = isRecord(config.Labels) ? config.Labels : {};
    const expectedNetwork = this.options.networkCase ? this.networkName : "none";
    const mountsSafe = this.agentMountsMatch(host, record);
    const securityOpt = Array.isArray(host.SecurityOpt) ? host.SecurityOpt.map(String) : [];
    const tmpfs = isRecord(host.Tmpfs) ? host.Tmpfs : {};
    const ulimits = Array.isArray(host.Ulimits) ? host.Ulimits : [];
    const nofile = ulimits.find((entry) => isRecord(entry) && entry.Name === "nofile");
    return labels[RUN_LABEL_KEY] === this.options.runGroupId &&
      labels[RUN_ROLE_LABEL_KEY] === "agent" &&
      record.Image === this.imageId && config.User === "65532:65532" &&
      host.NetworkMode === expectedNetwork && host.ReadonlyRootfs === true && host.Privileged === false &&
      securityOpt.some((value) => /no-new-privileges(?::true)?/i.test(value)) &&
      Array.isArray(host.CapDrop) && host.CapDrop.length === 1 && host.CapDrop[0] === "ALL" &&
      (host.CapAdd === undefined || host.CapAdd === null || (Array.isArray(host.CapAdd) && host.CapAdd.length === 0)) &&
      Number(host.PidsLimit) === 128 && Number(host.Memory) === 536870912 &&
      Number(host.MemorySwap) === 536870912 && Number(host.NanoCpus) === 1_000_000_000 &&
      mountsSafe &&
      ["/tmp", "/var/tmp", "/run"].every((mount) => Object.prototype.hasOwnProperty.call(tmpfs, mount)) &&
      isRecord(nofile) && Number(nofile.Soft) === 1024 && Number(nofile.Hard) === 1024;
  }

  private agentMountsMatch(
    host: Record<string, unknown>,
    record: Record<string, unknown>,
  ): boolean {
    if (!this.profileRoot || !Array.isArray(record.Mounts) || record.Mounts.length !== 2) {
      return false;
    }
    const mounts = record.Mounts;
    if (mounts.some((mount) => !isRecord(mount) || mount.Type !== "bind" || mount.RW !== false)) {
      return false;
    }
    const workspaceMount = mounts.find(
      (mount) => isRecord(mount) && mount.Destination === "/workspace",
    );
    const agentMount = mounts.find(
      (mount) => isRecord(mount) && mount.Destination === "/agent",
    );
    if (
      !isRecord(workspaceMount) ||
      !isRecord(agentMount) ||
      typeof workspaceMount.Source !== "string" ||
      typeof agentMount.Source !== "string"
    ) {
      return false;
    }
    const sandboxParent = path.resolve(this.profileRoot, "state", "sandboxes");
    if (
      !isDirectChildPath(workspaceMount.Source, sandboxParent) ||
      !sameHostPath(agentMount.Source, path.resolve(this.profileRoot, "workspace"))
    ) {
      return false;
    }
    if (!Array.isArray(host.Binds) || host.Binds.length !== mounts.length) return false;
    const structuredSources = new Map([
      ["/workspace", workspaceMount.Source],
      ["/agent", agentMount.Source],
    ]);
    const bindDestinations = new Set<string>();
    for (const bind of host.Binds) {
      const parsed = parseReadOnlyDockerBind(bind);
      const structuredSource = parsed && structuredSources.get(parsed.destination);
      if (
        !parsed ||
        !structuredSource ||
        bindDestinations.has(parsed.destination) ||
        !sameHostPath(parsed.source, structuredSource)
      ) {
        return false;
      }
      bindDestinations.add(parsed.destination);
    }
    return bindDestinations.size === structuredSources.size;
  }

  private sinkMatches(record: Record<string, unknown>): boolean {
    const host = isRecord(record.HostConfig) ? record.HostConfig : {};
    const config = isRecord(record.Config) ? record.Config : {};
    const labels = isRecord(config.Labels) ? config.Labels : {};
    const securityOpt = Array.isArray(host.SecurityOpt) ? host.SecurityOpt.map(String) : [];
    const tmpfs = isRecord(host.Tmpfs) ? host.Tmpfs : {};
    const ulimits = Array.isArray(host.Ulimits) ? host.Ulimits : [];
    const nofile = ulimits.find((entry) => isRecord(entry) && entry.Name === "nofile");
    const mounts = Array.isArray(record.Mounts) ? record.Mounts : [];
    const allowedTmpfsMounts = new Set(["/tmp", "/var/tmp", "/run"]);
    const mountsSafe = mounts.every((mount) => isRecord(mount) && mount.Type === "tmpfs" && typeof mount.Destination === "string" && allowedTmpfsMounts.has(mount.Destination));
    const command = Array.isArray(config.Cmd) ? config.Cmd.map(String) : [];
    const entrypoint = config.Entrypoint;
    const networks = isRecord(record.NetworkSettings) && isRecord(record.NetworkSettings.Networks) ? record.NetworkSettings.Networks : {};
    const aliases = Object.values(networks).flatMap((network) => isRecord(network) && Array.isArray(network.Aliases) ? network.Aliases.map(String) : []);
    return record.Image === this.imageId && config.User === "65532:65532" && host.NetworkMode === this.networkName &&
      labels[RUN_LABEL_KEY] === this.options.runGroupId && labels[RUN_ROLE_LABEL_KEY] === "sink" &&
      command.length === 5 && command.join("\u0000") === ["python3", "-u", "-m", "http.server", "8080"].join("\u0000") &&
      (entrypoint === undefined || entrypoint === null || (Array.isArray(entrypoint) && entrypoint.length === 0)) &&
      aliases.includes("sink") &&
      host.ReadonlyRootfs === true && host.Privileged === false && securityOpt.some((value) => /no-new-privileges(?::true)?/i.test(value)) &&
      Array.isArray(host.CapDrop) && host.CapDrop.length === 1 && host.CapDrop[0] === "ALL" &&
      (host.CapAdd === undefined || host.CapAdd === null || (Array.isArray(host.CapAdd) && host.CapAdd.length === 0)) &&
      Number(host.PidsLimit) === 128 && Number(host.Memory) === 536870912 && Number(host.MemorySwap) === 536870912 && Number(host.NanoCpus) === 1_000_000_000 &&
      (host.Binds === undefined || host.Binds === null || (Array.isArray(host.Binds) && host.Binds.length === 0)) && mountsSafe &&
      (host.Devices === undefined || host.Devices === null || (Array.isArray(host.Devices) && host.Devices.length === 0)) &&
      (host.DeviceRequests === undefined || host.DeviceRequests === null || (Array.isArray(host.DeviceRequests) && host.DeviceRequests.length === 0)) &&
      (config.Volumes === undefined || config.Volumes === null || (isRecord(config.Volumes) && Object.keys(config.Volumes).length === 0)) &&
      ["/tmp", "/var/tmp", "/run"].every((mount) => Object.prototype.hasOwnProperty.call(tmpfs, mount)) &&
      isRecord(nofile) && Number(nofile.Soft) === 1024 && Number(nofile.Hard) === 1024;
  }

  private async writeEvidence(name: string, value: unknown): Promise<void> {
    if (!this.evidenceRoot) return;
    const destination = path.join(this.evidenceRoot, name);
    const resolved = path.resolve(destination);
    if (!resolved.startsWith(`${this.evidenceRoot}${path.sep}`)) throw new Error("Invalid evidence path");
    await assertNoSymlinkAncestors(this.evidenceRoot);
    const existing = await fs.lstat(destination).catch(() => undefined);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) throw new Error("Evidence destination has an invalid file type.");
    const temporary = `${destination}.tmp-${randomBytes(8).toString("hex")}`;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      await assertNoSymlinkAncestors(this.evidenceRoot);
      const beforeRename = await fs.lstat(destination).catch(() => undefined);
      if (beforeRename?.isSymbolicLink()) throw new Error("Evidence destination became a symlink.");
      await fs.rename(temporary, destination);
      await assertNoSymlinkAncestors(this.evidenceRoot);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async command(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<DetectionCommandResult> {
    this.throwIfAborted();
    const result = await this.run({ command, args, env, signal: this.signal, timeoutMs: COMMAND_TIMEOUT_MS });
    this.throwIfAborted();
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES || Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
      throw new SandboxPreflightError("COMMAND_OUTPUT_TOO_LARGE", "Detection command output exceeded the size limit.");
    }
    return result;
  }

  private async cleanupCommand(command: string, args: string[]): Promise<DetectionCommandResult> {
    const result = await this.run({ command, args, signal: undefined, timeoutMs: COMMAND_TIMEOUT_MS });
    if (Buffer.byteLength(result.stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES || Buffer.byteLength(result.stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
      throw new Error("Detection cleanup command output exceeded the size limit.");
    }
    return result;
  }

  private throwIfAborted(): void {
    if (this.gatewayFailure) throw this.gatewayFailure;
    if (this.signal.aborted) throw new SandboxPreflightError("CANCELLED", "Detection sandbox operation was cancelled.");
  }

  private requestCancellation(): void {
    if (this.activeGatewayGeneration !== undefined) {
      this.expectedGatewayShutdownGeneration = this.activeGatewayGeneration;
    }
    this.abortController.abort();
  }

  private armGatewayLifetime(gateway: DetectionGatewayProcess): number {
    const processHandle = gateway.process;
    if (
      !processHandle ||
      typeof processHandle.kill !== "function" ||
      typeof processHandle.waitForExit !== "function"
    ) {
      throw new SandboxPreflightError(
        "GATEWAY_LIFETIME_UNAVAILABLE",
        "Detection Gateway process lifetime is unavailable.",
      );
    }
    let exit: Promise<void>;
    try {
      exit = processHandle.waitForExit();
      if (!exit || typeof exit.then !== "function") throw new Error("Invalid exit promise.");
    } catch {
      throw new SandboxPreflightError(
        "GATEWAY_LIFETIME_UNAVAILABLE",
        "Detection Gateway process lifetime is unavailable.",
      );
    }

    const generation = ++this.gatewayGeneration;
    this.activeGatewayGeneration = generation;
    this.expectedGatewayShutdownGeneration = undefined;
    this.gatewayFailure = undefined;
    this.gatewayLifetimeFailure = new Promise<SandboxPreflightError>((resolve) => {
      this.resolveGatewayLifetimeFailure = resolve;
    });
    void exit.then(
      () => this.handleGatewayExit(gateway, generation),
      () => this.handleGatewayExit(gateway, generation),
    );
    return generation;
  }

  private handleGatewayExit(
    gateway: DetectionGatewayProcess,
    generation: number,
  ): void {
    if (
      this.gateway !== gateway ||
      this.activeGatewayGeneration !== generation ||
      this.expectedGatewayShutdownGeneration === generation
    ) {
      return;
    }
    const error = new SandboxPreflightError(
      "GATEWAY_EXITED",
      "Detection Gateway exited unexpectedly.",
    );
    this.gatewayFailure = error;
    this.liveValidated = false;
    this.gateway = undefined;
    this.resolveGatewayLifetimeFailure?.(error);
    this.resolveGatewayLifetimeFailure = undefined;
    this.abortController.abort();
  }

  private assertGatewayAlive(
    gateway: DetectionGatewayProcess | undefined,
    generation: number | undefined,
    requireValidated: boolean,
  ): void {
    if (this.gatewayFailure) throw this.gatewayFailure;
    if (
      !gateway ||
      this.gateway !== gateway ||
      generation === undefined ||
      this.activeGatewayGeneration !== generation ||
      (requireValidated && !this.liveValidated)
    ) {
      throw new SandboxPreflightError(
        "GATEWAY_LIFETIME_UNAVAILABLE",
        "Detection Gateway process lifetime is unavailable.",
      );
    }
  }

  private async raceGatewayLifetime<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    requireValidated: boolean,
  ): Promise<T> {
    const gateway = this.gateway;
    const generation = this.activeGatewayGeneration;
    const failure = this.gatewayLifetimeFailure;
    this.assertGatewayAlive(gateway, generation, requireValidated);
    if (!failure) {
      throw new SandboxPreflightError(
        "GATEWAY_LIFETIME_UNAVAILABLE",
        "Detection Gateway process lifetime is unavailable.",
      );
    }
    const operationPromise = Promise.resolve().then(() => operation(this.signal));
    const operationOutcome = operationPromise.then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "operation_error" as const, error }),
    );
    const outcome = await Promise.race([
      operationOutcome,
      failure.then((error) => ({ kind: "gateway_error" as const, error })),
    ]);
    if (outcome.kind === "gateway_error") {
      await operationOutcome;
      throw outcome.error;
    }
    if (outcome.kind === "operation_error") {
      if (this.gatewayFailure) throw this.gatewayFailure;
      if (this.signal.aborted) {
        throw new SandboxPreflightError(
          "CANCELLED",
          "Detection sandbox operation was cancelled.",
        );
      }
      throw outcome.error;
    }
    this.throwIfAborted();
    this.assertGatewayAlive(gateway, generation, requireValidated);
    return outcome.value;
  }
}

export function createDetectionSandboxManager(options: DetectionSandboxManagerOptions): DetectionSandboxManager {
  return new DetectionSandboxManager(options);
}

function firstLine(value: string): string { return value.trim().split(/\r?\n/, 1)[0] ?? ""; }

function parseDockerIds(raw: string, kind: "container" | "network"): string[] {
  if (!raw.trim()) return [];
  const ids = raw.split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
  if (ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id))) {
    throw new Error(`Invalid labeled Docker ${kind} id output.`);
  }
  return ids;
}

function parseInspectRecords(raw: string): Record<string, unknown>[] {
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.every(isRecord) ? values : [];
  } catch {
    const values: unknown[] = [];
    for (const line of raw.split(/\r?\n/).filter((entry) => entry.trim())) {
      try { values.push(JSON.parse(line) as unknown); } catch { return []; }
    }
    return values.every(isRecord) ? values : [];
  }
}

function parseReadOnlyDockerBind(value: unknown): {
  source: string;
  destination: "/workspace" | "/agent";
} | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(.+):(\/(?:workspace|agent)):([^:]+)$/.exec(value);
  if (!match) return undefined;
  const options = match[3].split(",");
  if (!options.includes("ro") || options.includes("rw")) return undefined;
  return {
    source: match[1],
    destination: match[2] as "/workspace" | "/agent",
  };
}

function sameHostPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return left.length > 0 && right.length > 0 && normalize(left) === normalize(right);
}

function isDirectChildPath(candidate: string, parent: string): boolean {
  if (!candidate.length) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.length > 0 &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    path.dirname(relative) === ".";
}

function matchesSandboxExplain(raw: string): boolean {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return false; }
  const sandbox = isRecord(value) && isRecord(value.sandbox)
    ? value.sandbox
    : isRecord(value) && isRecord(value.agents) && isRecord(value.agents.defaults) && isRecord(value.agents.defaults.sandbox)
      ? value.agents.defaults.sandbox
      : value;
  if (!isRecord(sandbox) || !Array.isArray(sandbox.workspaceMounts)) return false;
  const mounts = sandbox.workspaceMounts;
  const mountsAreReadOnly = mounts.every(
    (mount) => isRecord(mount) && mount.writable === false,
  );
  const hasReadOnlyMount = (source: string, containerRoot: string): boolean =>
    mounts.some(
      (mount) =>
        isRecord(mount) &&
        mount.source === source &&
        mount.containerRoot === containerRoot &&
        mount.writable === false,
    );
  return sandbox.mode === "all" && sandbox.scope === "session" && sandbox.backend === "docker" &&
    sandbox.workspaceAccess === "ro" && sandbox.sessionIsSandboxed === true &&
    sandbox.runtimeWorkdir === "/workspace" && mountsAreReadOnly &&
    hasReadOnlyMount("workspace", "/workspace") && hasReadOnlyMount("agent", "/agent");
}

function isSafeTempRoot(root: string): boolean {
  const resolved = path.resolve(root);
  const temp = path.resolve(os.tmpdir());
  return resolved.startsWith(`${temp}${path.sep}`) && path.basename(resolved).startsWith("agent-guard-");
}

async function assertNoSymlinkAncestors(target: string): Promise<void> {
  let current = path.resolve(target);
  const root = path.parse(current).root;
  while (current.length >= root.length) {
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new SandboxPreflightError("INVALID_OUTPUT_ROOT", "Detection evidence path contains a symlink.");
    if (current === root) break;
    current = path.dirname(current);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "LANG", "LC_ALL", "TZ"] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export async function readGatewayBootstrap(
  stream: Readable,
  options: {
    signal: AbortSignal;
    childExit: Promise<void>;
    timeoutMs?: number;
  },
): Promise<KeyObject> {
  const timeoutMs = options.timeoutMs ?? GATEWAY_BOOTSTRAP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > GATEWAY_BOOTSTRAP_TIMEOUT_MS) {
    throw new TypeError("Gateway bootstrap timeout is invalid.");
  }

  return new Promise<KeyObject>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let ended = false;
    const timer = setTimeout(
      () => fail("Gateway bootstrap timed out."),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      stream.removeListener("close", onClose);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      stream.destroy();
      reject(new SandboxPreflightError("GATEWAY_BOOTSTRAP_INVALID", message));
    };
    const succeed = (key: KeyObject): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(key);
    };
    const onAbort = (): void => fail("Gateway bootstrap was cancelled.");
    const onError = (): void => fail("Gateway bootstrap pipe failed.");
    const onClose = (): void => {
      if (!ended) fail("Gateway bootstrap pipe closed before EOF.");
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > MAX_GATEWAY_BOOTSTRAP_BYTES - size) {
        fail("Gateway bootstrap exceeded the size limit.");
        return;
      }
      size += bytes.length;
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      ended = true;
      try {
        succeed(parseGatewayBootstrap(Buffer.concat(chunks, size)));
      } catch {
        fail("Gateway bootstrap was invalid.");
      }
    };

    options.signal.addEventListener("abort", onAbort, { once: true });
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);
    void options.childExit.then(
      () => fail("Gateway exited before bootstrap completed."),
      (error: unknown) => {
        if (error instanceof DetectionSandboxError) {
          if (settled) return;
          settled = true;
          cleanup();
          stream.destroy();
          reject(error);
          return;
        }
        fail("Gateway exited before bootstrap completed.");
      },
    );
    if (options.signal.aborted) onAbort();
  });
}

function parseGatewayBootstrap(bytes: Buffer): KeyObject {
  if (
    bytes.length === 0 ||
    bytes[bytes.length - 1] !== 0x0a ||
    bytes.subarray(0, bytes.length - 1).includes(0x0a) ||
    bytes.subarray(0, bytes.length - 1).includes(0x0d)
  ) {
    throw new Error("Invalid bootstrap framing.");
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, bytes.length - 1),
  );
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "contractVersion") ||
    !Object.hasOwn(value, "attestationPublicKey") ||
    value.contractVersion !== "native-guard-bootstrap-1" ||
    typeof value.attestationPublicKey !== "string"
  ) {
    throw new Error("Invalid bootstrap schema.");
  }
  const encoded = value.attestationPublicKey;
  const der = Buffer.from(encoded, "base64");
  if (der.length === 0 || der.toString("base64") !== encoded) {
    throw new Error("Invalid bootstrap public key encoding.");
  }
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (
    key.type !== "public" ||
    key.asymmetricKeyType !== "ed25519" ||
    key.export({ format: "der", type: "spki" }).toString("base64") !== encoded
  ) {
    throw new Error("Invalid bootstrap public key.");
  }
  return key;
}

async function launchGateway(input: Parameters<DetectionGatewayLauncher>[0]): Promise<DetectionGatewayProcess> {
  const gatewayUrl = new URL(input.gatewayUrl);
  const port = Number(gatewayUrl.port);
  const cli = resolveOpenClawCliInvocation(input.cliPath);
  let child: ChildProcess;
  try {
    child = spawn(cli.command, [...cli.argsPrefix, "gateway", "run", "--bind", "loopback", "--port", String(port), "--token", input.token], {
      cwd: input.profileRoot,
      env: {
        ...cli.env,
        ...input.env,
        OPENCLAW_NATIVE_GUARD_BOOTSTRAP_FD: "3",
        OPENCLAW_NATIVE_GUARD_BOOTSTRAP_CONTRACT: "native-guard-bootstrap-1",
      },
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "pipe"],
    });
  } catch {
    throw gatewayStartFailed();
  }
  type ChildCompletion = { kind: "close" } | { kind: "error" };
  const completion = new Promise<ChildCompletion>((resolve) => {
    let settled = false;
    const finish = (result: ChildCompletion): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", () => finish({ kind: "error" }));
    child.once("close", () => finish({ kind: "close" }));
  });
  const onAbort = (): void => { child.kill(); };
  input.signal.addEventListener("abort", onAbort, { once: true });
  const exited = completion.then(() => undefined);
  const startupExit = completion.then((result) => {
    if (result.kind === "error") throw gatewayStartFailed();
  });
  void completion.then(() => input.signal.removeEventListener("abort", onAbort));
  try {
    const bootstrapStream = child.stdio[3] as Readable | null;
    if (!bootstrapStream) {
      throw new SandboxPreflightError(
        "GATEWAY_BOOTSTRAP_INVALID",
        "Gateway bootstrap pipe was unavailable.",
      );
    }
    const attestationPublicKey = await readGatewayBootstrap(bootstrapStream, {
      signal: input.signal,
      childExit: startupExit,
    });
    const readinessExit = completion.then((result) => {
      if (input.signal.aborted) {
        throw new SandboxPreflightError(
          "CANCELLED",
          "Detection sandbox operation was cancelled.",
        );
      }
      if (result.kind === "error") throw gatewayStartFailed();
      throw new SandboxPreflightError(
        "GATEWAY_START_FAILED",
        "Detection Gateway exited before readiness.",
      );
    });
    await Promise.race([
      waitForGateway(input.gatewayUrl, input.token, child, input.signal),
      readinessExit,
    ]);
    return {
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey,
      process: {
        kill: (signal) => { child.kill(signal); },
        forceKill: () => { terminateGatewayProcessTree(child); },
        waitForExit: () => exited,
      },
    };
  } catch (error) {
    child.kill("SIGTERM");
    const graceful = await waitForExitBounded(() => exited, 2_000);
    if (!graceful) {
      terminateGatewayProcessTree(child);
      await waitForExitBounded(() => exited, 1_000);
    }
    throw error;
  }
}

function gatewayStartFailed(): SandboxPreflightError {
  return new SandboxPreflightError(
    "GATEWAY_START_FAILED",
    "Detection Gateway could not be started.",
  );
}

function terminateGatewayProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const systemRoot = process.env.SystemRoot;
    const taskkillPath = systemRoot && path.win32.isAbsolute(systemRoot)
      ? path.win32.join(systemRoot, "System32", "taskkill.exe")
      : "C:\\Windows\\System32\\taskkill.exe";
    try { spawnSync(taskkillPath, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false, stdio: "ignore", timeout: 2_000 }); } catch { /* fallback below */ }
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group may be gone */ }
  }
  try { child.kill("SIGKILL"); } catch { /* already exited */ }
}

async function waitForExitBounded(waitForExit: () => Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  try {
    await Promise.race([
      waitForExit().then(() => { exited = true; }),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return exited;
}

export async function waitForGateway(
  url: string,
  token: string,
  child: { exitCode: number | null; kill(): void },
  signal: AbortSignal,
  maxAttempts = GATEWAY_READINESS_MAX_ATTEMPTS,
  delayMs = 50,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal.aborted || child.exitCode !== null) break;
    const attemptController = new AbortController();
    const attemptTimer = setTimeout(() => attemptController.abort(), 500);
    try {
      const statusUrl = new URL("/agent-guard/native-guard/v1/status", url).toString();
      // Step 1: The protected status route must reject an unauthenticated probe.
      const unauthed = await fetch(statusUrl, {
        method: "GET",
        redirect: "error",
        signal: attemptController.signal,
      });
      const enforcesAuth = unauthed.status === 401 || unauthed.status === 403;
      await cancelResponseBodyBounded(unauthed);
      if (!enforcesAuth) {
        clearTimeout(attemptTimer);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      // Step 2: Authenticate to the same route with a random nonce challenge.
      const nonce = randomBytes(24).toString("base64url");
      const statusResponse = await fetch(statusUrl, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "x-agent-guard-ready-nonce": nonce,
        },
        redirect: "error",
        signal: attemptController.signal,
      });
      let statusBody: unknown;
      try {
        statusBody = await readBoundedJsonResponse(
          statusResponse,
          attemptController.signal,
        );
      } catch {
        await cancelResponseBodyBounded(statusResponse);
        clearTimeout(attemptTimer);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      clearTimeout(attemptTimer);
      if (
        statusResponse.status === 200 &&
        isRecord(statusBody) &&
        typeof statusBody._readyNonce === "string" &&
        statusBody._readyNonce === nonce &&
        (statusBody.coverage === "off" || statusBody.coverage === "ready") &&
        statusBody.activeLeaseCount === 0
      ) {
        return;
      }
    } catch {
      clearTimeout(attemptTimer);
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  child.kill();
  throw new SandboxPreflightError("GATEWAY_START_FAILED", "Isolated OpenClaw Gateway did not become ready on loopback.");
}

/**
 * Cancel a response body with a bounded deadline — body cancellation must never
 * hang the readiness poll, even when a malicious server never closes the stream.
 */
export async function cancelResponseBodyBounded(response: Response): Promise<void> {
  const body = response.body;
  if (!body) return;
  await cancelOperationBounded(() => body.cancel());
}

export async function readBoundedJsonResponse(
  response: Response,
  signal: AbortSignal,
  maxBytes = MAX_GATEWAY_READINESS_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("JSON response size limit is invalid.");
  }
  if (response.headers.get("content-encoding") !== null) {
    await cancelResponseBodyBounded(response);
    throw new Error("Encoded Gateway readiness responses are not accepted.");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    await cancelResponseBodyBounded(response);
    throw new Error("Gateway readiness response was not JSON.");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > maxBytes
    ) {
      await cancelResponseBodyBounded(response);
      throw new Error("Gateway readiness response exceeded the size limit.");
    }
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await readBoundedResponseChunk(reader, signal);
      if (done) break;
      if (value.byteLength > maxBytes - size) {
        await cancelOperationBounded(() => reader.cancel());
        throw new Error("Gateway readiness response exceeded the size limit.");
      }
      size += value.byteLength;
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

async function readBoundedResponseChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new Error("Gateway readiness attempt was cancelled.");
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      void cancelOperationBounded(() => reader.cancel());
      reject(new Error("Gateway readiness attempt was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function cancelOperationBounded(operation: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(operation).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, RESPONSE_CANCEL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function runCommand(input: DetectionCommandInput): Promise<DetectionCommandResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(input.command, input.args, {
      cwd: input.cwd, env: input.env ?? process.env, shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: DetectionCommandResult): void => { if (!settled) { settled = true; cleanup(); resolve(result); } };
    const fail = (error: Error): void => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const timer = setTimeout(() => { child.kill(); fail(new Error("Detection command timed out.")); }, input.timeoutMs ?? COMMAND_TIMEOUT_MS);
    const abort = (): void => { child.kill(); fail(new Error("Detection command aborted.")); };
    const cleanup = (): void => { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); };
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        fail(new Error("Detection command output exceeded the size limit."));
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        fail(new Error("Detection command error output exceeded the size limit."));
      }
    });
    child.on("error", fail);
    child.on("close", (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
  });
}
