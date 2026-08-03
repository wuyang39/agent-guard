import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import {
  DetectionSandboxManager,
  SandboxAttestationError,
  SandboxPreflightError,
  waitForGateway,
  type DetectionCommandResult,
} from "./detectionSandboxManager";

test("cleanup keeps per-operation errors queryable and tries every operation", async () => {
  const { runner, calls } = runnerFor();
  let networkLsCalled = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-cleanup-ops", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      // Fail container removal
      if (input.args[0] === "rm" && input.args[1] === "-f") return { exitCode: 1, stdout: "", stderr: "container busy" };
      // Return a network id on ls, then fail its removal
      if (input.command === "docker" && input.args[0] === "network" && input.args[1] === "ls") {
        networkLsCalled = true;
        return { exitCode: 0, stdout: "net-1\n", stderr: "" };
      }
      if (input.args[0] === "network" && input.args[1] === "rm") return { exitCode: 1, stdout: "", stderr: "network busy" };
      return runner(input);
    },
  });
  await manager.preflight();
  await assert.rejects(
    manager.cleanup(),
    (error: unknown) => error instanceof Error && /cleanup failed/.test(error.message),
  );
  // getCleanupErrors must return structured per-operation records.
  const errors = manager.getCleanupErrors();
  // container-cleanup fails on all 3 retries and appears in the final attempt record.
  assert.ok(errors.some((e: { operation: string }) => e.operation === "container-cleanup"));
  // network-cleanup must also appear if it was attempted.
  if (networkLsCalled) {
    assert.ok(errors.some((e: { operation: string }) => e.operation === "network-cleanup"),
      "expected network-cleanup in cleanup errors");
  }
});



function runnerFor(result: Partial<DetectionCommandResult> = {}) {
  const calls: { command: string; args: string[] }[] = [];
  const runner = async (input: { command: string; args: string[] }) => {
    calls.push({ command: input.command, args: input.args });
    const command = `${input.command} ${input.args.join(" ")}`;
    if (command.includes("docker version")) return { exitCode: 0, stdout: "27.0.0", stderr: "" };
    if (command.includes("plugins list")) return { exitCode: 0, stdout: JSON.stringify({ plugins: [{ id: "agent-guard-supervision", enabled: true, status: "loaded", hookNames: ["before_tool_call", "after_tool_call"], services: ["agent-guard-runtime"], manifest: { contracts: { trustedToolPolicies: ["agent-guard-admission"] } } }], diagnostics: [] }), stderr: "" };
    if (command.includes("--version")) return { exitCode: 0, stdout: "openclaw 2026.7.2", stderr: "" };
    if (command.includes("docker image inspect")) return { exitCode: 0, stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [`openclaw@sha256:${"a".repeat(64)}`] }), stderr: "" };
    if (command.includes("sandbox explain")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          sandbox: {
            mode: "all", scope: "session", backend: "docker", workspaceAccess: "ro",
            docker: { network: "none", user: "65532:65532", readOnlyRoot: true, capDrop: ["ALL"], binds: [],
              pidsLimit: 128, memory: "512m", memorySwap: "512m", cpus: 1,
              securityOpt: ["no-new-privileges:true"], tmpfs: ["/tmp", "/var/tmp", "/run"],
              ulimits: { nofile: "1024:1024" } },
          },
        }),
        stderr: "",
      };
    }
    if (command.includes("docker ps")) return { exitCode: 0, stdout: "container-1\n", stderr: "" };
    if (command.includes("docker inspect")) {
      return { exitCode: 0, stdout: JSON.stringify([{ Id: "container-1", Image: `sha256:${"a".repeat(64)}`, Config: { User: "65532:65532", Labels: { "agent-guard.run-group": "run-1", "agent-guard.role": "agent" } }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapDrop: ["ALL"], PidsLimit: 128, Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, Binds: [], SecurityOpt: ["no-new-privileges:true"], Tmpfs: { "/tmp": "", "/var/tmp": "", "/run": "" }, Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }] }, Mounts: [] }]), stderr: "" };
    }
    if (command.includes("docker rm") || command.includes("docker network rm")) return { exitCode: 0, stdout: "", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "", ...result };
  };
  return { runner, calls };
}

test("fails preflight when Docker is unavailable", async () => {
  const manager = new DetectionSandboxManager({
    runGroupId: "run-1", image: "openclaw:latest",
    commandRunner: async () => ({ exitCode: 1, stdout: "", stderr: "docker unavailable" }),
  });
  await assert.rejects(manager.preflight(), (error: unknown) => error instanceof SandboxPreflightError && error.code === "DOCKER_UNAVAILABLE");
});

test("does not treat unauthorized or server-error Gateway responses as ready", async () => {
  const server = http.createServer((_request, response) => {
    response.statusCode = 401;
    response.end("unauthorized");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  await assert.rejects(waitForGateway(url, "token", child, new AbortController().signal, 1, 1), /ready|Gateway/i);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("rejects a fake HTTP server that returns 200 regardless of authentication", async () => {
  // A local impostor that responds 200 to everything must not pass readiness.
  const server = http.createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  await assert.rejects(
    waitForGateway(url, "token", child, new AbortController().signal, 2, 1),
    /ready|Gateway/i,
  );
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("rejects a gateway that authenticates but fails nonce echo challenge", async () => {
  // A gateway that enforces auth but cannot echo the correct nonce must not pass readiness.
  const server = http.createServer((request, response) => {
    const authed = request.headers.authorization === "Bearer token";
    if (!authed) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    // Always return the wrong nonce — must fail readiness.
    response.end(JSON.stringify({ coverage: "active", _readyNonce: "wrong-nonce" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  await assert.rejects(
    waitForGateway(url, "token", child, new AbortController().signal, 2, 1),
    /ready|Gateway/i,
  );
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("accepts a gateway that completes all three readiness checks", async () => {
  // Simulate a full OpenClaw gateway: 401 on unauth, 200 authed root, correct nonce on status.
  const server = http.createServer((request, response) => {
    const authed = request.headers.authorization === "Bearer token";
    if (!authed) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    // Must echo back the nonce from the request header.
    const nonce = request.headers["x-agent-guard-ready-nonce"] as string | undefined;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      coverage: "active",
      finalizerAssurance: "isolated_profile",
      ...(nonce ? { _readyNonce: nonce } : {}),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  // Should NOT reject — gateway is valid.
  await waitForGateway(url, "token", child, new AbortController().signal, 2, 1);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("fails preflight when image cannot be resolved to an immutable id", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-1", image: "openclaw:latest",
    commandRunner: async (input) => input.args.includes("inspect") && input.args.includes("image")
      ? { exitCode: 0, stdout: "openclaw:latest", stderr: "" }
      : runner(input),
  });
  await assert.rejects(manager.preflight(), (error: unknown) => error instanceof SandboxPreflightError && error.code === "IMAGE_NOT_IMMUTABLE");
});

test("rejects a mutable image tag even when Docker returns an id", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-tag", image: "openclaw:latest", commandRunner: runner,
  });
  await assert.rejects(manager.preflight(), (error: unknown) => error instanceof SandboxPreflightError && error.code === "IMAGE_NOT_IMMUTABLE");
});

test("requires the Agent Guard plugin capability before detection", async () => {
  const { runner } = runnerFor();
  const previous = process.env.OPENCLAW_GATEWAY_TOKEN;
  process.env.OPENCLAW_GATEWAY_TOKEN = "host-secret-must-not-pass";
  let observedEnv: NodeJS.ProcessEnv | undefined;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-capability", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      if (input.args.includes("plugins")) observedEnv = input.env;
      return input.args.includes("plugins")
        ? { exitCode: 0, stdout: JSON.stringify({ plugins: [], diagnostics: [] }), stderr: "" }
        : runner(input);
    },
  });
  await assert.rejects(manager.preflight(), (error: unknown) => error instanceof SandboxPreflightError && error.code === "OPENCLAW_CAPABILITY_UNAVAILABLE");
  assert.equal(observedEnv?.OPENCLAW_GATEWAY_TOKEN, undefined);
  if (previous === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
  else process.env.OPENCLAW_GATEWAY_TOKEN = previous;
});

test("fails preflight for unsupported OpenClaw capability", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-1", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => input.args.includes("--version")
      ? { exitCode: 0, stdout: "openclaw 2026.6.1", stderr: "" }
      : runner(input),
  });
  await assert.rejects(manager.preflight(), (error: unknown) => error instanceof SandboxPreflightError && error.code === "OPENCLAW_UNSUPPORTED");
});

test("rejects a sandbox explain mismatch and cleans only labeled objects", async () => {
  const { runner, calls } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-1", image: `openclaw@sha256:${"a".repeat(64)}`, commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain")) {
        return { ...result, stdout: JSON.stringify({ sandbox: { backend: "host" } }) };
      }
      return result;
    },
  });
  await manager.preflight();
  await assert.rejects(manager.attestSession("session-1", "before"), (error: unknown) => error instanceof SandboxAttestationError && error.code === "SANDBOX_EXPLAIN_MISMATCH");
  await manager.cleanup();
  assert.ok(calls.some((call) => call.command === "docker" && call.args.includes("rm")));
});

test("cancellation aborts command execution and cleanup is idempotent", async () => {
  const controller = new AbortController();
  let cleaned = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-1", image: `openclaw@sha256:${"a".repeat(64)}`,
    signal: controller.signal,
    commandRunner: async (input) => {
      input.signal?.addEventListener("abort", () => undefined);
      if (input.args.includes("version")) controller.abort();
      return { exitCode: 0, stdout: "27.0.0", stderr: "" };
    },
    onCleanup: () => { cleaned += 1; },
  });
  await assert.rejects(manager.preflight(), /aborted|cancel/i);
  await manager.cleanup();
  await manager.cleanup();
  assert.equal(cleaned, 1);
});

test("cleans a partial start when the gateway launcher fails", async () => {
  const { runner } = runnerFor();
  let cleaned = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-partial", image: `openclaw@sha256:${"a".repeat(64)}`, commandRunner: runner,
    gatewayLauncher: async () => { throw new Error("gateway failed"); }, onCleanup: () => { cleaned += 1; },
  });
  await assert.rejects(manager.runSession("session-1", async () => undefined), /gateway failed/);
  assert.equal(cleaned, 1);
});

test("retains the resolved OpenClaw version and starts an isolated gateway", async () => {
  const { runner } = runnerFor();
  let launchEnv: NodeJS.ProcessEnv | undefined;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-version", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => { launchEnv = input.env; return { url: input.gatewayUrl, token: input.token }; },
  });
  const evidence = await manager.start();
  assert.equal(evidence.openclawVersion, "2026.7.2");
  assert.match(evidence.gatewayUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal("gatewayToken" in evidence, false);
  assert.ok(manager.getGatewayCredentials()?.gatewayToken);
  assert.equal(launchEnv?.OPENCLAW_CONFIG_PATH, evidence.configPath);
  assert.equal(launchEnv?.OPENCLAW_WORKSPACE_DIR, path.join(evidence.profileRoot, "workspace"));
  assert.equal(launchEnv?.OPENCLAW_PLUGIN_DIRS, "");
  assert.equal(launchEnv?.OPENCLAW_GATEWAY_URL, evidence.gatewayUrl);
  assert.deepEqual((await fs.readdir(evidence.profileRoot ? `${process.cwd()}/outputs/openclaw-detection/run-version` : "")).sort(), ["config.json", "hashes.json"]);
  const persisted = JSON.parse(await fs.readFile(`${process.cwd()}/outputs/openclaw-detection/run-version/config.json`, "utf8"));
  assert.deepEqual(persisted.agents.defaults.sandbox.docker.labels, { "agent-guard.run-group": "run-version", "agent-guard.role": "agent" });
  await manager.cleanup();
});

test("network cases create a labeled internal sink and remove it during cleanup", async () => {
  const { calls, runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-network", image: `openclaw@sha256:${"a".repeat(64)}`,
    networkCase: true,
    commandRunner: async (input) => {
      calls.push({ command: input.command, args: input.args });
      if (input.args[0] === "network" && input.args[1] === "create") return { exitCode: 0, stdout: "network-1\n", stderr: "" };
      if (input.args[0] === "network" && input.args[1] === "ls") return { exitCode: 0, stdout: "network-1\n", stderr: "" };
      if (input.args[0] === "run") return { exitCode: 0, stdout: "sink-1\n", stderr: "" };
      return runner(input);
    },
  });
  await manager.preflight();
  await manager.cleanup();
  assert.ok(calls.some((call) => call.args[0] === "network" && call.args[1] === "create" && call.args.includes("--internal")));
  assert.ok(calls.some((call) => call.args[0] === "run" && call.args.includes("http.server")));
  assert.ok(calls.some((call) => call.args[0] === "rm"));
  assert.ok(calls.some((call) => call.args[0] === "network" && call.args[1] === "rm"));
});

test("fails after-run attestation when Docker resource limits do not match", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-resource", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "inspect") {
        return { ...result, stdout: JSON.stringify([{ Id: "container-1", Config: { Labels: { "agent-guard.run-group": "run-resource" } }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], PidsLimit: 1, Memory: 1, MemorySwap: 1, NanoCpus: 1, Binds: [] } }]) };
      }
      return result;
    },
  });
  await manager.preflight();
  await assert.rejects(manager.attestSession("session-1", "after"), (error: unknown) => error instanceof SandboxAttestationError && error.code === "CONTAINER_ATTESTATION_MISMATCH");
  await manager.cleanup();
});

test("fails closed when the inspected agent is privileged or missing privilege evidence", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-privileged", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "inspect") {
        return { ...result, stdout: JSON.stringify([{ Id: "agent-1", Image: `sha256:${"a".repeat(64)}`, Config: { User: "65532:65532", Labels: { "agent-guard.run-group": "run-privileged", "agent-guard.role": "agent" } }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: true, CapDrop: ["ALL"], PidsLimit: 128, Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, Binds: [], SecurityOpt: ["no-new-privileges:true"], Tmpfs: { "/tmp": "", "/var/tmp": "", "/run": "" }, Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }] }, Mounts: [] }]) };
      }
      return result;
    },
  });
  await manager.preflight();
  await assert.rejects(manager.attestSession("session-1", "after"), (error: unknown) => error instanceof SandboxAttestationError && error.code === "CONTAINER_ATTESTATION_MISMATCH");
  await manager.cleanup();
});

test("fails closed when Docker adds a capability despite capDrop ALL", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-capadd", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "inspect") {
        return { ...result, stdout: JSON.stringify([{ Id: "agent-1", Image: `sha256:${"a".repeat(64)}`, Config: { User: "65532:65532", Labels: { "agent-guard.run-group": "run-capadd", "agent-guard.role": "agent" } }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapAdd: ["SYS_ADMIN"], CapDrop: ["ALL"], PidsLimit: 128, Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, Binds: [], SecurityOpt: ["no-new-privileges:true"], Tmpfs: { "/tmp": "", "/var/tmp": "", "/run": "" }, Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }] }, Mounts: [] }]) };
      }
      return result;
    },
  });
  await manager.preflight();
  await assert.rejects(manager.attestSession("session-1", "after"), (error: unknown) => error instanceof SandboxAttestationError && error.code === "CONTAINER_ATTESTATION_MISMATCH");
  await manager.cleanup();
});

test("cleanup automatically retries a transient Docker removal failure", async () => {
  const { runner } = runnerFor();
  let removeAttempts = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-retry", image: `openclaw@sha256:${"a".repeat(64)}`, commandRunner: async (input) => {
      if (input.args[0] === "rm" && input.args[1] === "-f" && removeAttempts++ === 0) return { exitCode: 1, stdout: "", stderr: "busy" };
      return runner(input);
    },
  });
  await manager.preflight();
  await manager.cleanup();
  assert.equal(removeAttempts, 2);
});

test("maps a command-runner abort to CANCELLED instead of Docker unavailable", async () => {
  const controller = new AbortController();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-abort-runner", image: `openclaw@sha256:${"a".repeat(64)}`, signal: controller.signal,
    commandRunner: async (input) => {
      if (input.args[0] === "version") {
        controller.abort();
        throw new Error("runner aborted");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(manager.preflight(), (error: unknown) => error instanceof SandboxPreflightError && error.code === "CANCELLED");
});
