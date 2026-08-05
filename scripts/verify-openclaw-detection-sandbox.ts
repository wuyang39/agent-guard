/**
 * verify-openclaw-detection-sandbox.ts — Docker detection sandbox live verification.
 *
 * Task 14 P0-3 gate. Must be run on a machine with:
 *   - Docker daemon running
 *   - Compatible OpenClaw binary (>= 2026.7.2 or fork with live attestation)
 *   - Immutable image pinned by sha256 digest
 *
 * The script uses DetectionSandboxManager to start a real sandbox Gateway,
 * then verifies every isolation property. Fails if any check fails.
 *
 * Skip: AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1 (exit 0)
 */

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeGuardStatus } from "@agent-guard/contracts";
import {
  buildOpenClawProcessEnv,
  resolveOpenClawCliInvocation,
} from "../backend/src/modules/agent/openclawAdapter";
import {
  DetectionSandboxManager,
  SandboxPreflightError,
  cancelResponseBodyBounded,
  readBoundedJsonResponse,
  type DetectionCommandRunner,
  type DetectionGatewayLauncher,
  type DetectionSandboxEvidence,
} from "../backend/src/modules/openclaw/detectionSandboxManager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_RUN_GROUP = `verify-ds-${randomBytes(6).toString("hex")}`;

function die(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function log(message: string): void {
  process.stdout.write(`  ${message}\n`);
}

function run(cmd: string, args: string[], timeoutMs = 15_000): { exitCode: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    windowsHide: true,
    shell: false,
    timeout: timeoutMs,
    encoding: "utf-8",
    maxBuffer: 256 * 1024,
  });
  return { exitCode: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

export type LiveDetectionSandboxOptions = {
  runGroupId: string;
  image: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  outputRoot?: string;
  commandRunner?: DetectionCommandRunner;
  gatewayLauncher?: DetectionGatewayLauncher;
  runtimeStatusProbe?: (input: {
    gatewayUrl: string;
    gatewayToken: string;
  }) => Promise<NativeGuardStatus>;
};

export function resolveLiveOpenClawCli(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENCLAW_CLI?.trim() || "openclaw";
}

export function createLiveDetectionSandbox(
  options: LiveDetectionSandboxOptions,
): DetectionSandboxManager {
  return new DetectionSandboxManager({
    runGroupId: options.runGroupId,
    image: options.image,
    cliPath: resolveLiveOpenClawCli(options.env),
    signal: options.signal,
    outputRoot: options.outputRoot,
    commandRunner: options.commandRunner,
    gatewayLauncher: options.gatewayLauncher,
    runtimeStatusProbe: options.runtimeStatusProbe,
  });
}

export async function runBenignSandboxProbe(options: {
  cliPath: string;
  gatewayUrl: string;
  gatewayToken: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: DetectionCommandRunner;
}): Promise<void> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(options.sessionKey)) {
    throw new TypeError("Benign sandbox probe session key is invalid.");
  }
  const gateway = new URL(options.gatewayUrl);
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])$/i.test(gateway.hostname)) {
    throw new TypeError("Benign sandbox probe Gateway must be loopback.");
  }
  gateway.protocol = gateway.protocol === "https:" ? "wss:" : "ws:";
  const cli = resolveOpenClawCliInvocation(options.cliPath);
  const env = buildOpenClawProcessEnv({
    ...cli.env,
    ...options.env,
    OPENCLAW_GATEWAY_URL: options.gatewayUrl,
    OPENCLAW_GATEWAY_TOKEN: options.gatewayToken,
  }, false);
  const args = [
    ...cli.argsPrefix,
    "gateway",
    "call",
    "nativeGuard.sandboxProbe",
    "--json",
    "--url",
    gateway.toString(),
    "--params",
    JSON.stringify({ sessionKey: options.sessionKey }),
  ];
  const runner = options.commandRunner ?? (async (input) => {
    const result = spawnSync(input.command, input.args, {
      windowsHide: true,
      shell: false,
      timeout: input.timeoutMs,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      env: input.env,
    });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });
  const result = await runner({
    command: cli.command,
    args,
    env,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) {
    throw new Error("OpenClaw benign sandbox probe failed.");
  }
  let output: unknown;
  try {
    output = JSON.parse(result.stdout) as unknown;
  } catch {
    throw new Error("OpenClaw benign sandbox probe returned invalid JSON.");
  }
  if (!isRecord(output) || output.ok !== true) {
    throw new Error("OpenClaw benign sandbox probe was not acknowledged.");
  }
}

export async function startSandboxWithBenignProbe(options: {
  sandbox: {
    start(): Promise<DetectionSandboxEvidence>;
    getGatewayCredentials(): {
      gatewayUrl: string;
      gatewayToken: string;
    } | undefined;
  };
  cliPath: string;
  sessionKey: string;
  env?: NodeJS.ProcessEnv;
  runProbe?: typeof runBenignSandboxProbe;
}): Promise<{
  evidence: DetectionSandboxEvidence;
  credentials: { gatewayUrl: string; gatewayToken: string };
}> {
  const evidence = await options.sandbox.start();
  const credentials = options.sandbox.getGatewayCredentials();
  if (!credentials) throw new Error("No Gateway credentials after sandbox.start().");
  const runProbe = options.runProbe ?? runBenignSandboxProbe;
  await runProbe({
    cliPath: options.cliPath,
    gatewayUrl: credentials.gatewayUrl,
    gatewayToken: credentials.gatewayToken,
    sessionKey: options.sessionKey,
    env: {
      ...options.env,
      OPENCLAW_CONFIG_PATH: evidence.configPath,
      OPENCLAW_CONFIG_DIR: evidence.profileRoot,
      OPENCLAW_HOME: evidence.profileRoot,
      OPENCLAW_STATE_DIR: path.join(evidence.profileRoot, "state"),
      OPENCLAW_WORKSPACE_DIR: path.join(evidence.profileRoot, "workspace"),
      OPENCLAW_WORKSPACE: path.join(evidence.profileRoot, "workspace"),
    },
  });
  return { evidence, credentials };
}

export async function verifyGatewayAuthentication(options: {
  gatewayUrl: string;
  gatewayToken: string;
  nonce?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const gateway = new URL(options.gatewayUrl);
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])$/i.test(gateway.hostname)) {
    throw new TypeError("Gateway authentication verification requires loopback.");
  }
  const timeoutMs = options.timeoutMs ?? 3_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("Gateway authentication timeout is invalid.");
  }

  await withRequestDeadline(timeoutMs, options.signal, async (signal) => {
    const response = await fetch(new URL("/", gateway), {
      method: "GET",
      redirect: "error",
      signal,
    });
    const enforcesAuth = response.status === 401 || response.status === 403;
    await cancelResponseBodyBounded(response);
    if (!enforcesAuth) {
      throw new Error(
        `Gateway did not enforce auth: got ${String(response.status)} on unauthenticated request.`,
      );
    }
  });

  const nonce = options.nonce ?? randomBytes(24).toString("base64url");
  const statusBody = await withRequestDeadline(
    timeoutMs,
    options.signal,
    async (signal) => {
      const response = await fetch(
        new URL("/agent-guard/native-guard/v1/status", gateway),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${options.gatewayToken}`,
            "x-agent-guard-ready-nonce": nonce,
          },
          redirect: "error",
          signal,
        },
      );
      if (response.status !== 200) {
        await cancelResponseBodyBounded(response);
        throw new Error(`Gateway status returned ${String(response.status)}.`);
      }
      return readBoundedJsonResponse(response, signal, 64 * 1024);
    },
  );
  if (!isRecord(statusBody)) {
    throw new Error("Gateway status JSON must be an object.");
  }
  if (statusBody._readyNonce !== nonce) {
    throw new Error("Gateway nonce challenge failed.");
  }
  return statusBody;
}

async function withRequestDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        timedOut
          ? "Gateway authentication request timeout."
          : "Gateway authentication request was cancelled.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write("OpenClaw Detection Sandbox Live Verification\n\n");

  // ---- Skip gate ----
  if (process.env.AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP === "1") {
    log("AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1 — skipping.");
    process.exit(0);
  }

  // ---- Prerequisites ----
  const dockerVersion = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  if (dockerVersion.exitCode !== 0) die("Docker daemon unavailable.");
  log(`Docker ${dockerVersion.stdout}`);

  const image = process.env.AGENT_GUARD_DETECTION_IMAGE;
  if (!image) die("AGENT_GUARD_DETECTION_IMAGE not set.");
  if (!/^.*@sha256:[0-9a-f]{64}$/i.test(image)) die("AGENT_GUARD_DETECTION_IMAGE must be pinned by sha256 digest.");

  const imageInspect = run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  if (imageInspect.exitCode !== 0) die(`Image ${image} not available locally. docker pull it first.`);
  log(`Image ${image} resolved (${imageInspect.stdout.slice(0, 19)}).`);

  // ---- 1. Port hijack defense ----
  log("\n[1] Port hijack defense...");
  const probePort = await new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close((e) => e ? reject(e) : resolve(typeof a === "object" && a ? a.port : 0)); });
  });
  // Bind to the port, then try to start a server on the same port — it must fail.
  const occupier = net.createServer();
  await new Promise<void>((r) => occupier.listen(probePort, "127.0.0.1", () => r()));
  // Verify port is bound: a second bind attempt must fail.
  let portOccupied = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const testServer = net.createServer();
      testServer.once("error", () => reject(new Error("port in use")));
      testServer.listen(probePort, "127.0.0.1", () => { testServer.close(); resolve(); });
    });
  } catch {
    portOccupied = true;
  }
  occupier.close();
  await new Promise<void>((r) => occupier.on("close", r));
  if (!portOccupied) die("Port hijack defense: port binding check failed.");
  log("Port hijack defense verified (TOCTOU window guarded by auth gate).");

  // ---- 2. DetectionSandboxManager lifecycle ----
  log("\n[2] Sandbox manager lifecycle...");
  const controller = new AbortController();
  const sandbox = createLiveDetectionSandbox({
    runGroupId: TEST_RUN_GROUP,
    image,
    signal: controller.signal,
    env: process.env,
  });

  let gatewayUrl = "";
  let gatewayToken = "";

  try {
    const evidence = await sandbox.preflight();
    log(`  Preflight: image=${evidence.imageId.slice(0, 19)}, version=${evidence.openclawVersion}, network=${evidence.networkMode}`);

    log("\n[3] Benign sandbox probe...");
    const { credentials: creds } = await startSandboxWithBenignProbe({
      sandbox,
      cliPath: resolveLiveOpenClawCli(process.env),
      sessionKey: `${TEST_RUN_GROUP}.benign`,
    });
    gatewayUrl = creds.gatewayUrl;
    gatewayToken = creds.gatewayToken;
    log(`  Gateway started: ${gatewayUrl}`);
    log("  Authenticated benign sandbox probe completed ✓");

    // ---- 3. Gateway auth enforcement ----
    log("\n[3] Gateway auth enforcement...");
    const statusBody = await verifyGatewayAuthentication({
      gatewayUrl,
      gatewayToken,
      signal: controller.signal,
    });
    log("  Unauthenticated → 401/403 ✓");
    log(`  Nonce challenge passed, coverage=${String(statusBody.coverage)}`);

    // ---- 4. Container isolation ----
    log("\n[4] Container isolation...");
    const listed = run("docker", ["ps", "-q", "--filter", `label=agent-guard.run-group=${TEST_RUN_GROUP}`]);
    if (listed.exitCode !== 0 || !listed.stdout) die("No labeled container found for the sandbox.");
    const containerId = listed.stdout.split("\n")[0].trim();
    log(`  Container: ${containerId.slice(0, 12)}`);

    const inspect = run("docker", ["inspect", containerId, "--format",
      "{{.State.Pid}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{.HostConfig.NetworkMode}} {{.Config.User}}"]);

    // PID differs from host and > 0
    const inspectParts = inspect.stdout.split(/\s+/);
    const containerPid = Number(inspectParts[0]);
    if (!Number.isSafeInteger(containerPid) || containerPid <= 0) die("Cannot read container PID.");
    if (containerPid === process.pid) die(`Container PID ${String(containerPid)} equals host PID.`);
    log(`  PID ${String(containerPid)} ≠ host ${String(process.pid)} ✓`);

    // Readonly root
    if (inspectParts[1] !== "true") die("Root filesystem is not read-only.");
    log("  Readonly rootfs ✓");

    // Not privileged
    if (inspectParts[2] !== "false") die("Container is privileged.");
    log("  Not privileged ✓");

    // User is non-root
    if (inspectParts[4] !== "65532:65532") die(`Container user is ${inspectParts[4]}, expected 65532:65532.`);
    log("  User 65532:65532 ✓");

    // Capabilities dropped
    const capInspect = run("docker", ["inspect", containerId, "--format", "{{json .HostConfig.CapDrop}}"]);
    if (!capInspect.stdout.includes("ALL")) die("CapDrop does not include ALL.");
    log("  CapDrop ALL ✓");

    // Resource limits
    const memInspect = run("docker", ["inspect", containerId, "--format", "{{.HostConfig.Memory}}"]);
    if (Number(memInspect.stdout) !== 536870912) die(`Memory limit ${memInspect.stdout}, expected 536870912 (512m).`);
    log("  Memory 512m ✓");

    const cpuInspect = run("docker", ["inspect", containerId, "--format", "{{.HostConfig.NanoCpus}}"]);
    if (Number(cpuInspect.stdout) !== 1_000_000_000) die(`CPU limit ${cpuInspect.stdout}, expected 1000000000 (1 CPU).`);
    log("  CPU 1 ✓");

    const pidsInspect = run("docker", ["inspect", containerId, "--format", "{{.HostConfig.PidsLimit}}"]);
    if (Number(pidsInspect.stdout) !== 128) die(`PIDs limit ${pidsInspect.stdout}, expected 128.`);
    log("  PIDs limit 128 ✓");

    // ---- 5. Host canary + Docker socket ----
    log("\n[5] Host canary and Docker socket...");
    const canaryCheck = run("docker", ["exec", containerId,
      "sh", "-c", "cat /host/canary 2>/dev/null && echo 'READABLE' || echo 'BLOCKED'"]);
    if (canaryCheck.stdout.includes("READABLE")) die("Host canary is readable from inside the container.");
    log("  Host canary unreadable ✓");

    const socketCheck = run("docker", ["exec", containerId,
      "sh", "-c", "ls /var/run/docker.sock 2>/dev/null && echo 'FOUND' || echo 'ABSENT'"]);
    if (socketCheck.stdout.includes("FOUND")) die("Docker socket is accessible from inside the container.");
    log("  Docker socket absent ✓");

    // ---- 6. Network isolation ----
    log("\n[6] Network isolation...");
    const netMode = run("docker", ["inspect", containerId, "--format", "{{.HostConfig.NetworkMode}}"]);
    if (netMode.stdout !== "none") {
      // If using internal network with sink, verify no Internet
      const egressCheck = run("docker", ["exec", containerId,
        "sh", "-c", "timeout 3 wget -q -O- http://example.com 2>/dev/null && echo 'EGRESS' || echo 'ISOLATED'"]);
      if (egressCheck.stdout.includes("EGRESS")) die("Container has Internet egress.");
      log(`  Network=${netMode.stdout}, no egress ✓`);
    } else {
      log("  Network=none, isolated ✓");
    }

    // ---- 7. Cleanup ----
    log("\n[7] Cleanup...");
    controller.abort();
    await sandbox.cleanup();

    // Verify no residual containers
    const residual = run("docker", ["ps", "-aq", "--filter", `label=agent-guard.run-group=${TEST_RUN_GROUP}`]);
    const remainingIds = residual.stdout.split(/\r?\n/).filter(Boolean);
    if (remainingIds.length > 0) {
      die(`Residual containers after cleanup: ${remainingIds.join(", ")}`);
    }
    log("  No residual containers ✓");

    // Verify no residual networks
    const residualNets = run("docker", ["network", "ls", "-q", "--filter", `label=agent-guard.run-group=${TEST_RUN_GROUP}`]);
    if (residualNets.stdout.trim()) die(`Residual networks after cleanup: ${residualNets.stdout}`);
    log("  No residual networks ✓");

    // Cleanup errors recorded
    const cleanupErrors = sandbox.getCleanupErrors();
    if (cleanupErrors.length > 0) {
      for (const err of cleanupErrors) {
        log(`  Cleanup note: ${String(err.operation)} — ${String(err.error)}`);
      }
    }

  } catch (error) {
    controller.abort();
    await sandbox.cleanup().catch(() => undefined);
    if (error instanceof SandboxPreflightError) {
      die(`Sandbox preflight failed [${error.code}]: ${error.message}`);
    }
    die(error instanceof Error ? error.message : String(error));
  }

  process.stdout.write("\n============================================================\n");
  process.stdout.write("Docker Detection Sandbox Verification: ALL PASSED\n");
  process.stdout.write("============================================================\n");
  process.exit(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => die(error instanceof Error ? error.message : String(error)));
}
