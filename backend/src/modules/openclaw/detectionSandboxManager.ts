import { randomBytes, createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { generateDetectionOpenClawConfig, detectionConfigDigest, type DetectionOpenClawConfig } from "./detectionOpenClawConfig";
import { createOpenClawControlClient, type NativeGuardCapability } from "./openclawControlClient";

const REQUIRED_OPENCLAW = [2026, 7, 1] as const;
// Fork identifier: version strings containing "agentguard" are accepted
// at the base version even without the official 2026.7.2+ release.
const FORK_IDENTIFIER = "agentguard";
const RUN_LABEL_KEY = "agent-guard.run-group";
const RUN_ROLE_LABEL_KEY = "agent-guard.role";
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

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
  process?: { kill(signal?: NodeJS.Signals): void; forceKill?: () => void; waitForExit?: () => Promise<void> };
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
  userConfig?: unknown;
  outputRoot?: string;
  commandRunner?: DetectionCommandRunner;
  gatewayLauncher?: DetectionGatewayLauncher;
  signal?: AbortSignal;
  onCleanup?: () => void;
  networkCase?: boolean;
  capabilityProbe?: (input: { cliPath?: string; env: Record<string, string>; isolatedProfile: true }) => Promise<NativeGuardCapability>;
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
  private readonly run: DetectionCommandRunner;
  private readonly abortController = new AbortController();
  private profileRoot?: string;
  private configPath?: string;
  private evidenceRoot?: string;
  private imageId?: string;
  private config?: DetectionOpenClawConfig;
  private gateway?: DetectionGatewayProcess;
  private cleaned = false;
  private cleanupNotified = false;
  private cleanupPromise?: Promise<void>;
  private resolvedOpenClawVersion?: string;
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
    this.options = { ...options, runGroupId: options.runGroupId, image: options.image };
    this.run = options.commandRunner ?? runCommand;
    if (options.signal) {
      const abort = (): void => this.abortController.abort();
      this.externalAbortListener = abort;
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) this.abortController.abort();
    }
  }

  get signal(): AbortSignal { return this.abortController.signal; }

  getCapturedSinkLogs(): string | undefined { return this.sinkLogs; }

  getGatewayCredentials(): { gatewayUrl: string; gatewayToken: string } | undefined {
    return this.gateway ? { gatewayUrl: this.gateway.url, gatewayToken: this.gateway.token } : undefined;
  }

  cancel(): void { this.abortController.abort(); }

  getCleanupErrors(): readonly { operation: string; error: unknown }[] {
    return this.cleanupErrors;
  }

  async preflight(): Promise<DetectionSandboxEvidence> {
    if (this.cleaned) throw new SandboxPreflightError("CLEANED", "Detection sandbox has already been cleaned.");
    if (this.profileRoot && this.imageId) return this.currentEvidence();
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
      const capability = await this.probeOpenClawCapability();
      const version = capability.openclawVersion;
      if (!version || !versionAtLeast(version, REQUIRED_OPENCLAW)) {
        throw new SandboxPreflightError("OPENCLAW_UNSUPPORTED", "OpenClaw detection runtime is unsupported.");
      }
      // Fork builds identify with the "agentguard" marker in the version
      // string. They are accepted at 2026.7.1 base; official builds
      // require 2026.7.2+.
      const isFork = version.toLowerCase().includes(FORK_IDENTIFIER);
      const minVersion = isFork ? REQUIRED_OPENCLAW : ([2026, 7, 2] as const);
      if (!versionAtLeast(version, minVersion)) {
        throw new SandboxPreflightError(
          "OPENCLAW_UNSUPPORTED",
          `OpenClaw ${version} is below the minimum ${isFork ? "2026.7.1 (fork)" : "2026.7.2"}.`,
        );
      }
      if (!capability.supportsNativeGuard || capability.finalizerAssurance !== "isolated_profile") {
        throw new SandboxPreflightError("OPENCLAW_CAPABILITY_UNAVAILABLE", "OpenClaw native guard capability is unavailable.");
      }
      this.resolvedOpenClawVersion = version;
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

  async start(): Promise<DetectionSandboxEvidence> {
    if (this.gateway) return { ...(await this.currentEvidence()), gatewayUrl: this.gateway.url };
    const evidence = this.profileRoot ? await this.currentEvidence() : await this.preflight();
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
    this.gateway = this.options.gatewayLauncher
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
    return { ...evidence, gatewayUrl: this.gateway.url };
  }

  async attestSession(sessionKey: string, phase: "before" | "after" = "after"): Promise<DetectionSandboxEvidence> {
    if (!sessionKey.trim()) throw new SandboxAttestationError("INVALID_SESSION_KEY", "Session key is required.");
    if (!this.profileRoot || !this.config || !this.imageId) {
      throw new SandboxAttestationError("NOT_STARTED", "Detection sandbox has not passed preflight.");
    }
    const env = this.profileEnv();
    const explain = await this.command(this.options.cliPath ?? "openclaw", ["sandbox", "explain", "--session", sessionKey, "--json"], env);
    if (explain.exitCode !== 0 || !matchesSandboxExplain(explain.stdout, this.options.networkCase ? (this.networkName ?? "internal") : "none")) {
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
      await this.attestSession(sessionKey, "before");
      const value = await operation();
      await this.attestSession(sessionKey, "after");
      return value;
    } finally {
      await this.cleanup();
    }
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    if (this.cleanupPromise) return this.cleanupPromise;
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
    await attempt("gateway-terminate", async () => {
      const gatewayProcess = this.gateway?.process;
      gatewayProcess?.kill("SIGTERM");
      if (gatewayProcess?.waitForExit && !await waitForExitBounded(gatewayProcess.waitForExit, 2_000)) {
        gatewayProcess.forceKill?.();
        await waitForExitBounded(gatewayProcess.waitForExit, 1_000);
      }
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `agent-guard-${this.options.runGroupId}-`));
    await fs.chmod(root, 0o700);
    this.profileRoot = root;
    await Promise.all([
      fs.mkdir(path.join(root, "state"), { mode: 0o700 }),
      fs.mkdir(path.join(root, "workspace"), { mode: 0o700 }),
    ]);
    this.config = generateDetectionOpenClawConfig({ userConfig: this.options.userConfig });
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
    if (this.options.capabilityProbe) {
      return this.options.capabilityProbe({ cliPath: this.options.cliPath, env, isolatedProfile: true });
    }
    const client = createOpenClawControlClient({
      gatewayToken: "detection-capability-probe",
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
    const mounts = Array.isArray(record.Mounts) ? record.Mounts : [];
    const allowedTmpfsMounts = new Set(["/tmp", "/var/tmp", "/run"]);
    const mountsSafe = mounts.every((mount) => isRecord(mount) && mount.Type === "tmpfs" && typeof mount.Destination === "string" && allowedTmpfsMounts.has(mount.Destination));
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
      (host.Binds === undefined || host.Binds === null || (Array.isArray(host.Binds) && host.Binds.length === 0)) && mountsSafe &&
      ["/tmp", "/var/tmp", "/run"].every((mount) => Object.prototype.hasOwnProperty.call(tmpfs, mount)) &&
      isRecord(nofile) && Number(nofile.Soft) === 1024 && Number(nofile.Hard) === 1024;
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
    if (this.signal.aborted) throw new SandboxPreflightError("CANCELLED", "Detection sandbox operation was cancelled.");
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

function versionAtLeast(value: string, expected: readonly number[]): boolean {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

function matchesSandboxExplain(raw: string, network: string): boolean {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return false; }
  const sandbox = isRecord(value) && isRecord(value.sandbox)
    ? value.sandbox
    : isRecord(value) && isRecord(value.agents) && isRecord(value.agents.defaults) && isRecord(value.agents.defaults.sandbox)
      ? value.agents.defaults.sandbox
      : value;
  const docker = isRecord(sandbox) && isRecord(sandbox.docker) ? sandbox.docker : sandbox;
  if (!isRecord(sandbox) || !isRecord(docker)) return false;
  const securityOpt = Array.isArray(docker.securityOpt) ? docker.securityOpt.map(String) : [];
  const tmpfs = Array.isArray(docker.tmpfs) ? docker.tmpfs.map(String) : [];
  const ulimits = isRecord(docker.ulimits) ? docker.ulimits : {};
  return sandbox.mode === "all" && sandbox.scope === "session" && sandbox.backend === "docker" &&
    sandbox.workspaceAccess === "ro" && docker.network === network && docker.user === "65532:65532" && docker.readOnlyRoot === true &&
    securityOpt.some((value) => /no-new-privileges(?::true)?/i.test(value)) &&
    ["/tmp", "/var/tmp", "/run"].every((mount) => tmpfs.includes(mount)) && ulimits.nofile === "1024:1024" &&
    Array.isArray(docker.capDrop) && docker.capDrop.length === 1 && docker.capDrop[0] === "ALL" &&
    Array.isArray(docker.binds) && docker.binds.length === 0 &&
    Number(docker.pidsLimit) === 128 && memoryMatches(docker.memory, 536870912) && memoryMatches(docker.memorySwap, 536870912) && Number(docker.cpus) === 1;
}

function memoryMatches(value: unknown, expectedBytes: number): boolean {
  if (typeof value === "number") return value === expectedBytes;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === "512m") return true;
  const match = normalized.match(/^(\d+)\s*(b|k|kb|m|mb|g|gb)$/);
  if (!match) return false;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "b" ? 1 : unit === "k" || unit === "kb" ? 1024 : unit === "m" || unit === "mb" ? 1024 ** 2 : 1024 ** 3;
  return amount * multiplier === expectedBytes;
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

async function launchGateway(input: Parameters<DetectionGatewayLauncher>[0]): Promise<DetectionGatewayProcess> {
  const gatewayUrl = new URL(input.gatewayUrl);
  const port = Number(gatewayUrl.port);
  const child = spawn(input.cliPath, ["gateway", "run", "--bind", "127.0.0.1", "--port", String(port), "--token", input.token], {
    cwd: input.profileRoot, env: input.env, windowsHide: true, shell: process.platform === "win32", detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const onAbort = (): void => { child.kill(); };
  input.signal.addEventListener("abort", onAbort, { once: true });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.once("close", () => input.signal.removeEventListener("abort", onAbort));
  try {
    await waitForGateway(input.gatewayUrl, input.token, child, input.signal);
  } catch (error) {
    child.kill("SIGTERM");
    const graceful = await waitForExitBounded(() => exited, 2_000);
    if (!graceful) {
      terminateGatewayProcessTree(child);
      await waitForExitBounded(() => exited, 1_000);
    }
    throw error;
  }
  return {
    url: input.gatewayUrl,
    token: input.token,
    process: {
      kill: (signal) => { child.kill(signal); },
      forceKill: () => { terminateGatewayProcessTree(child); },
      waitForExit: () => exited,
    },
  };
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
  maxAttempts = 40,
  delayMs = 50,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (signal.aborted || child.exitCode !== null) break;
    const attemptController = new AbortController();
    const attemptTimer = setTimeout(() => attemptController.abort(), 500);
    try {
      // Step 1: Unauthenticated probe — the gateway must reject.
      const unauthed = await fetch(url, {
        method: "GET",
        redirect: "error",
        signal: attemptController.signal,
      });
      const enforcesAuth = unauthed.status === 401 || unauthed.status === 403;
      await cancelBodyBounded(unauthed);
      if (!enforcesAuth) {
        clearTimeout(attemptTimer);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      // Step 2: Authenticated root probe — the gateway must accept.
      const authed = await fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        redirect: "error",
        signal: attemptController.signal,
      });
      const rootOk = authed.status >= 200 && authed.status < 300;
      await cancelBodyBounded(authed);
      if (!rootOk) {
        clearTimeout(attemptTimer);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      // Step 3: Authenticated status endpoint with random nonce challenge.
      const nonce = randomBytes(24).toString("base64url");
      const statusUrl = new URL("/agent-guard/native-guard/v1/status", url).toString();
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
        statusBody = await statusResponse.json();
      } catch {
        await cancelBodyBounded(statusResponse);
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
        typeof statusBody.coverage === "string"
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
async function cancelBodyBounded(response: Response): Promise<void> {
  if (!response.body) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      response.body.cancel(),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 2_000); }),
    ]);
  } catch {
    // Body cancellation is best effort.
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
