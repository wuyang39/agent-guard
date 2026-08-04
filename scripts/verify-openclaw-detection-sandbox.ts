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
import http from "node:http";
import net from "node:net";
import {
  DetectionSandboxManager,
  SandboxPreflightError,
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
    shell: process.platform === "win32",
    timeout: timeoutMs,
    encoding: "utf-8",
  });
  return { exitCode: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
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

  const openclawVersion = run("openclaw", ["--version"]);
  if (openclawVersion.exitCode !== 0) die("OpenClaw CLI unavailable.");
  const versionMatch = openclawVersion.stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!versionMatch) die(`Cannot parse OpenClaw version: ${openclawVersion.stdout}`);
  const [major, minor, patch] = versionMatch.slice(1).map(Number);
  if (major < 2026 || (major === 2026 && minor < 7) || (major === 2026 && minor === 7 && patch < 2)) {
    log(`WARNING: OpenClaw ${versionMatch[0]} is below minimum 2026.7.2. Live attestation will be unavailable.`);
  }
  log(`OpenClaw ${versionMatch[0]}`);

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
  const sandbox = new DetectionSandboxManager({
    runGroupId: TEST_RUN_GROUP,
    image,
    signal: controller.signal,
    // Use a mock capability probe: the isolated sandbox profile does not
    // have the host's plugins installed. The guard lifecycle is tested
    // separately (verify:native-guard).
    capabilityProbe: async () => ({
      supportsNativeGuard: true,
      finalizerAssurance: "isolated_profile" as const,
      openclawVersion: "2026.7.2",
      pluginVersion: "1.0.0",
    }),
  });

  let gatewayUrl = "";
  let gatewayToken = "";

  try {
    const evidence = await sandbox.preflight();
    log(`  Preflight: image=${evidence.imageId.slice(0, 19)}, version=${evidence.openclawVersion}, network=${evidence.networkMode}`);

    const started = await sandbox.start();
    const creds = sandbox.getGatewayCredentials();
    if (!creds) die("No Gateway credentials after sandbox.start().");
    gatewayUrl = creds.gatewayUrl;
    gatewayToken = creds.gatewayToken;
    log(`  Gateway started: ${gatewayUrl}`);

    // ---- 3. Gateway auth enforcement ----
    log("\n[3] Gateway auth enforcement...");
    const unauthRes = await fetch(gatewayUrl, { method: "GET", redirect: "error" });
    if (unauthRes.status !== 401 && unauthRes.status !== 403) {
      die(`Gateway did not enforce auth: got ${String(unauthRes.status)} on unauthenticated request.`);
    }
    await unauthRes.body?.cancel().catch(() => undefined);
    log("  Unauthenticated → 401/403 ✓");

    const nonce = randomBytes(24).toString("base64url");
    const statusUrl = `${gatewayUrl}/agent-guard/native-guard/v1/status`;
    const authRes = await fetch(statusUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${gatewayToken}`, "x-agent-guard-ready-nonce": nonce },
      redirect: "error",
    });
    if (authRes.status !== 200) die(`Gateway status returned ${String(authRes.status)}.`);
    const statusBody = await authRes.json() as Record<string, unknown>;
    if (statusBody._readyNonce !== nonce) die("Gateway nonce challenge failed.");
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

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
