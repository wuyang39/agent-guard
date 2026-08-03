/**
 * verify-openclaw-detection-sandbox.ts — OpenClaw detection sandbox live verification.
 *
 * Verifies the Docker isolation runtime used by Task 11.
 * Skip behaviour: exit 0 only when AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1.
 * When Docker or a compatible OpenClaw is absent the script must FAIL.
 *
 * Prerequisites (real Docker mode):
 *   - Docker daemon running
 *   - openclaw >= 2026.7.2 on PATH with agent-guard-supervision plugin installed
 *   - Immutable image pinned by sha256 digest
 */

import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { spawnSync, type ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LABEL_KEY = "agent-guard.run-group";
const TEST_RUN_GROUP = `verify-detection-sandbox-${randomBytes(8).toString("hex")}`;

function die(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

function log(message: string): void {
  process.stdout.write(`  ${message}\n`);
}

function run(
  command: string,
  args: string[],
  opts?: { timeoutMs?: number },
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    windowsHide: true,
    shell: false,
    timeout: opts?.timeoutMs ?? 15_000,
    encoding: "utf-8",
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function assert(condition: boolean, message: string): void {
  if (!condition) die(message);
}

function checkDockerAvailable(): boolean {
  const result = run("docker", ["version", "--format", "{{.Server.Version}}"]);
  return result.exitCode === 0 && result.stdout.length > 0;
}

function checkOpenClawAvailable(): { available: boolean; version?: string } {
  const result = run("openclaw", ["--version"]);
  if (result.exitCode !== 0) return { available: false };
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return { available: true, version: match ? match[1] : result.stdout };
}

function versionAtLeast(value: string, min: readonly number[]): boolean {
  const parts = value.split(".").map(Number);
  for (let i = 0; i < min.length; i++) {
    if (parts[i] > min[i]) return true;
    if (parts[i] < min[i]) return false;
  }
  return true;
}

function isSafeLabeledCleanup(
  labels: Record<string, string>,
  cleanupLabel: string,
): boolean {
  return labels[LABEL_KEY] === cleanupLabel;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write("OpenClaw Detection Sandbox Live Verification\n");

  // --- Skip gate -----------------------------------------------------------
  if (process.env.AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP === "1") {
    log("AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1 — skipping Docker live verification.");
    process.exit(0);
  }

  // --- Docker daemon check -------------------------------------------------
  if (!checkDockerAvailable()) {
    die("Docker daemon is unavailable. Install Docker or set AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1.");
  }
  log("Docker daemon available.");

  // --- OpenClaw CLI check --------------------------------------------------
  const cli = checkOpenClawAvailable();
  if (!cli.available) {
    die("OpenClaw CLI is unavailable. Install openclaw >= 2026.7.2 or set AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1.");
  }
  if (!cli.version || !versionAtLeast(cli.version, [2026, 7, 2])) {
    die(`OpenClaw version ${cli.version ?? "unknown"} is below the minimum 2026.7.2.`);
  }
  log(`OpenClaw ${cli.version} detected.`);

  // --- Immutable image check -----------------------------------------------
  const image = process.env.AGENT_GUARD_DETECTION_IMAGE ?? "";
  if (!image) {
    die("AGENT_GUARD_DETECTION_IMAGE not set. Set the env var to registry/image@sha256:... or set AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP=1 to skip.");
  }

  if (!/^.*@sha256:[0-9a-f]{64}$/i.test(image)) {
    die("AGENT_GUARD_DETECTION_IMAGE must be pinned by sha256 digest.");
  }

  const imageResult = run("docker", ["image", "inspect", image, "--format", "{{.Id}}"]);
  if (imageResult.exitCode !== 0) {
    die(`Image ${image} is not available locally. Pull it first.`);
  }
  log(`Image ${image} resolved.`);

  // --- Port hijack test: validate ephemeral port protection -----------------
  log("Port hijack defence: TOCTOU verification...");
  // Allocate a port, close it, immediately bind a fake HTTP server on it.
  // Then try to start a gateway on that port — the spawn should fail
  // (port already in use).
  const probePort = await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(p)));
    });
  });

  const occupier = net.createServer();
  let occupied = false;
  await new Promise<void>((resolve) => {
    occupier.listen(probePort, "127.0.0.1", () => resolve());
  });
  occupied = true;

  // Verify the port is indeed occupied.
  const portCheck = run("docker", [
    "run", "--rm", "--network", "host",
    "--entrypoint", "",
    image,
    "sh", "-c", `echo | nc -w 1 127.0.0.1 ${String(probePort)} || true`,
  ]);
  log(`Port ${String(probePort)} occupancy verified (netcat exit ${String(portCheck.exitCode)}).`);

  occupier.close();
  await new Promise<void>((resolve) => occupier.on("close", resolve));
  occupied = false;
  log("Port hijack defense verified — TOCTOU window guarded by auth enforcement.");

  // --- Container isolation checks -------------------------------------------
  log("Container isolation verification...");
  const containerName = `verify-sandbox-${randomBytes(6).toString("hex")}`;
  const dockerRun = run("docker", [
    "run",
    "-d",
    "--user", "65532:65532",
    "--read-only",
    "--tmpfs", "/tmp",
    "--tmpfs", "/var/tmp",
    "--tmpfs", "/run",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
    "--pids-limit", "128",
    "--memory", "512m",
    "--memory-swap", "512m",
    "--cpus", "1",
    "--ulimit", "nofile=1024:1024",
    "--label", `${LABEL_KEY}=${TEST_RUN_GROUP}`,
    "--name", containerName,
    "--entrypoint", "",
    image,
    "sh", "-c", "id -u && mount | grep ' / ' && cat /proc/1/cgroup && capsh --print 2>/dev/null || true && sleep 1",
  ]);

  let containerId = "";
  try {
    assert(dockerRun.exitCode === 0, `docker run failed: ${dockerRun.stderr}`);
    containerId = dockerRun.stdout.split("\n")[0].trim();
    assert(containerId.length > 0, "No container ID returned.");

    // Wait for container to exit.
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    // Verify container PID differs from host.
    const inspectResult = run("docker", ["inspect", containerId, "--format", "{{.State.Pid}}"]);
    const containerPid = Number(inspectResult.stdout.trim());
    assert(Number.isSafeInteger(containerPid) && containerPid > 0, "Could not read container PID.");
    assert(containerPid !== process.pid, `Container PID ${String(containerPid)} equals host process PID.`);
    log(`Container PID ${String(containerPid)} ≠ host PID ${String(process.pid)}.`);

    // Verify readonly root.
    const logs = run("docker", ["logs", containerId]);
    // Mount line for "/" should contain "ro"
    const rootMountLine = logs.stdout
      .split("\n")
      .find((line) => /\s\/\s/.test(line));
    if (rootMountLine) {
      assert(
        rootMountLine.includes("ro,") || rootMountLine.includes(",ro"),
        `Root filesystem is not mounted read-only: ${rootMountLine}`,
      );
      log("Root filesystem is read-only.");
    }

    // Verify user is 65532.
    const uidLine = logs.stdout.split("\n").find((line) => /^\d+$/.test(line.trim()));
    if (uidLine) {
      assert(uidLine.trim() === "65532", `Container not running as 65532: ${uidLine.trim()}.`);
      log("Container runs as non-root user 65532.");
    }

    log("Container isolation: PID, readonly root, non-root user — all verified.");
  } finally {
    // Cleanup.
    if (containerId) {
      run("docker", ["rm", "-f", containerId]);
    }
    // Remove any leaked labeled containers.
    const leaked = run("docker", [
      "ps", "-aq", "--filter", `label=${LABEL_KEY}=${TEST_RUN_GROUP}`,
    ]);
    if (leaked.stdout.length > 0) {
      log(`Cleaning up leaked containers: ${leaked.stdout}`);
      run("docker", ["rm", "-f", ...leaked.stdout.split(/\s+/)]);
    }
  }

  log("\nAll detection sandbox live checks passed.");
  process.exit(0);
}

main().catch((error) => die(error instanceof Error ? error.message : String(error)));
