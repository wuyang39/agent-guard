/// <reference path="../../../../plugins/agent-guard-supervision/src/openclaw-sdk.d.ts" />
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { signNativeGuardPayload } from "@agent-guard/native-guard-protocol";
import { registerControlRoutes } from "../../../../plugins/agent-guard-supervision/src/controlRoutes";
import { OpenClawAdapter } from "../agent/openclawAdapter";
import {
  DetectionSandboxManager,
  SandboxAttestationError,
  SandboxPreflightError,
  readGatewayBootstrap,
  waitForGateway,
  type DetectionCommandInput,
  type DetectionCommandResult,
} from "./detectionSandboxManager";

const TEST_GATEWAY_KEYS = generateKeyPairSync("ed25519");

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
  const runner = async (input: DetectionCommandInput) => {
    calls.push({ command: input.command, args: input.args });
    const command = `${input.command} ${input.args.join(" ")}`;
    if (command.includes("docker version")) return { exitCode: 0, stdout: "27.0.0", stderr: "" };
    if (command.includes("plugins list")) return { exitCode: 0, stdout: JSON.stringify(livePluginInventory()), stderr: "" };
    if (command.includes("--version")) return { exitCode: 0, stdout: "openclaw 2026.7.2", stderr: "" };
    if (command.includes("docker image inspect")) return { exitCode: 0, stdout: JSON.stringify({ Id: `sha256:${"a".repeat(64)}`, RepoDigests: [`openclaw@sha256:${"a".repeat(64)}`] }), stderr: "" };
    if (command.includes("sandbox explain")) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(realSandboxExplain()),
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

function realSandboxExplain() {
  return {
    docsUrl: "https://docs.openclaw.ai/sandbox",
    agentId: "main",
    sessionKey: "session-1",
    mainSessionKey: "agent:main:main",
    sandbox: {
      mode: "all",
      scope: "session",
      backend: "docker",
      workspaceAccess: "ro",
      workspaceRoot: "C:\\Temp\\openclaw-sandboxes",
      effectiveHostWorkspaceRoot: "C:\\Temp\\openclaw-sandboxes\\session-1",
      runtimeWorkdir: "/workspace",
      workspaceMounts: [
        {
          hostRoot: "C:\\Temp\\openclaw-sandboxes\\session-1",
          containerRoot: "/workspace",
          writable: false,
          source: "workspace",
        },
        {
          hostRoot: "E:\\Projects\\agent-guard",
          containerRoot: "/agent",
          writable: false,
          source: "agent",
        },
      ],
      workspaceSource: "sandbox",
      sessionIsSandboxed: true,
      tools: {
        allow: ["read"],
        deny: [],
        sources: {},
      },
    },
  };
}

function realAgentContainerInspect(profileRoot: string, runGroupId: string) {
  const sandboxRoot = path.join(profileRoot, "state", "sandboxes", "session-1");
  const agentRoot = path.join(profileRoot, "workspace");
  return {
    Id: "agent-1",
    Image: `sha256:${"a".repeat(64)}`,
    Config: {
      User: "65532:65532",
      Labels: {
        "agent-guard.run-group": runGroupId,
        "agent-guard.role": "agent",
      },
    },
    HostConfig: {
      NetworkMode: "none",
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ["ALL"],
      PidsLimit: 128,
      Memory: 536870912,
      MemorySwap: 536870912,
      NanoCpus: 1000000000,
      Binds: [
        `${sandboxRoot}:/workspace:ro,z`,
        `${agentRoot}:/agent:ro,z`,
      ],
      SecurityOpt: ["no-new-privileges:true"],
      Tmpfs: { "/tmp": "", "/var/tmp": "", "/run": "" },
      Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }],
    },
    Mounts: [
      {
        Type: "bind",
        Source: sandboxRoot,
        Destination: "/workspace",
        Mode: "ro,z",
        RW: false,
        Propagation: "rprivate",
      },
      {
        Type: "bind",
        Source: agentRoot,
        Destination: "/agent",
        Mode: "ro,z",
        RW: false,
        Propagation: "rprivate",
      },
    ],
  };
}

test("writes the canonical isolated plugin profile with run-scoped marker and spool directories", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-plugin-profile-"));
  const pluginRoot = path.join(fixtureRoot, "plugin");
  const outputRoot = path.join(fixtureRoot, "evidence");
  await fs.mkdir(path.join(pluginRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(pluginRoot, "openclaw.plugin.json"), "{}", "utf8");
  await fs.writeFile(path.join(pluginRoot, "dist", "index.js"), "export {};\n", "utf8");
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-plugin-profile",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    pluginRoot,
    outputRoot,
    commandRunner: runner,
  });

  try {
    const evidence = await manager.preflight();
    const config = JSON.parse(await fs.readFile(evidence.configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(config.plugins, {
      enabled: true,
      allow: ["agent-guard-supervision"],
      load: { paths: [path.resolve(pluginRoot)] },
      slots: { memory: "none" },
      entries: {
        "agent-guard-supervision": {
          enabled: true,
          config: {
            markerDir: path.join(evidence.profileRoot, "agent-guard", "markers"),
            spoolDir: path.join(evidence.profileRoot, "agent-guard", "spool"),
          },
        },
      },
    });
    await manager.cleanup();
    assert.equal((await fs.stat(pluginRoot)).isDirectory(), true, "plugin package must remain outside cleanup");
  } finally {
    await manager.cleanup().catch(() => undefined);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails preflight clearly when the configured plugin package is incomplete", async () => {
  for (const missing of ["openclaw.plugin.json", path.join("dist", "index.js")]) {
    const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-plugin-missing-"));
    const pluginRoot = path.join(fixtureRoot, "plugin");
    await fs.mkdir(path.join(pluginRoot, "dist"), { recursive: true });
    if (missing !== "openclaw.plugin.json") {
      await fs.writeFile(path.join(pluginRoot, "openclaw.plugin.json"), "{}", "utf8");
    }
    if (missing !== path.join("dist", "index.js")) {
      await fs.writeFile(path.join(pluginRoot, "dist", "index.js"), "export {};\n", "utf8");
    }
    const { runner } = runnerFor();
    const manager = new DetectionSandboxManager({
      runGroupId: `run-plugin-missing-${path.basename(missing).replace(/\W/g, "-")}`,
      image: `openclaw@sha256:${"a".repeat(64)}`,
      pluginRoot,
      outputRoot: path.join(fixtureRoot, "evidence"),
      commandRunner: runner,
    });

    try {
      await assert.rejects(
        manager.preflight(),
        (error: unknown) =>
          error instanceof SandboxPreflightError &&
          error.code === "OPENCLAW_PLUGIN_UNAVAILABLE" &&
          error.message.includes(missing),
      );
    } finally {
      await manager.cleanup().catch(() => undefined);
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  }
});

test("reads one exact Ed25519 bootstrap record from the dedicated pipe", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const encoded = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const record = JSON.stringify({
    contractVersion: "native-guard-bootstrap-1",
    attestationPublicKey: encoded,
  });

  const parsed = await readGatewayBootstrap(Readable.from([`${record}\n`]), {
    signal: new AbortController().signal,
    childExit: new Promise<void>(() => undefined),
    timeoutMs: 30_000,
  });

  assert.equal(
    parsed.export({ format: "der", type: "spki" }).toString("base64"),
    encoded,
  );
});

test("rejects Gateway bootstrap deadlines above the bounded maximum", async () => {
  await assert.rejects(
    () =>
      readGatewayBootstrap(Readable.from([]), {
        signal: new AbortController().signal,
        childExit: new Promise<void>(() => undefined),
        timeoutMs: 60_001,
      }),
    TypeError,
  );
});

test("rejects malformed, duplicate, oversized, and missing bootstrap records", async (t) => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const encoded = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const valid = JSON.stringify({
    contractVersion: "native-guard-bootstrap-1",
    attestationPublicKey: encoded,
  });
  const cases: Array<[string, string]> = [
    ["missing", ""],
    ["malformed", "{\n"],
    ["duplicate", `${valid}\n${valid}\n`],
    ["extra bytes", `${valid}\nextra`],
    ["oversized", `${"A".repeat(8193)}\n`],
    ["extra key", `${JSON.stringify({ contractVersion: "native-guard-bootstrap-1", attestationPublicKey: encoded, extra: true })}\n`],
    ["invalid key", `${JSON.stringify({ contractVersion: "native-guard-bootstrap-1", attestationPublicKey: "AAAA" })}\n`],
  ];

  for (const [name, raw] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        () => readGatewayBootstrap(Readable.from([raw]), {
          signal: new AbortController().signal,
          childExit: new Promise<void>(() => undefined),
          timeoutMs: 50,
        }),
        /bootstrap/i,
      );
    });
  }
});

test("bounds bootstrap reads by timeout, abort, and child exit", async (t) => {
  const cases: Array<{
    name: string;
    configure: (controller: AbortController, childExit: ReturnType<typeof deferred<void>>) => void;
  }> = [
    { name: "timeout", configure: () => undefined },
    { name: "abort", configure: (controller) => controller.abort() },
    { name: "child exit", configure: (_controller, childExit) => childExit.resolve() },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const stream = new Readable({ read() { /* intentionally stalled */ } });
      const controller = new AbortController();
      const childExit = deferred<void>();
      entry.configure(controller, childExit);
      await assert.rejects(
        () => readGatewayBootstrap(stream, {
          signal: controller.signal,
          childExit: childExit.promise,
          timeoutMs: 15,
        }),
        /bootstrap|cancel|exit/i,
      );
      stream.destroy();
    });
  }
});

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

test("accepts a public Control UI when the protected status route enforces auth", async (t) => {
  let rootRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/") {
      rootRequests += 1;
      response.statusCode = 200;
      response.setHeader("content-type", "text/html");
      response.end("<html>OpenClaw Control UI</html>");
      return;
    }
    if (request.url !== "/agent-guard/native-guard/v1/status") {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
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
      coverage: "ready",
      finalizerAssurance: "isolated_profile",
      activeLeaseCount: 0,
      openclawVersion: "2026.7.2",
      ...(nonce ? { _readyNonce: nonce } : {}),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  await waitForGateway(url, "token", child, new AbortController().signal, 2, 1);
  assert.equal(rootRequests, 0);
});

test("default readiness budget reaches a healthy forty-first attempt", async () => {
  let unauthenticatedAttempts = 0;
  const server = http.createServer((request, response) => {
    const authed = request.headers.authorization === "Bearer token";
    if (!authed) {
      unauthenticatedAttempts += 1;
      response.statusCode = unauthenticatedAttempts <= 40 ? 503 : 401;
      response.end("not ready");
      return;
    }
    const nonce = request.headers["x-agent-guard-ready-nonce"] as string | undefined;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        coverage: "ready",
        finalizerAssurance: "isolated_profile",
        activeLeaseCount: 0,
        openclawVersion: "2026.7.2",
        ...(nonce ? { _readyNonce: nonce } : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };

  try {
    await waitForGateway(url, "token", child, new AbortController().signal, undefined, 0);
    assert.equal(unauthenticatedAttempts, 41);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("readiness rejects encoded, non-JSON, oversized, and stalled status bodies", async (t) => {
  const modes = [
    "wrong-content-type",
    "declared-oversize",
    "streaming-oversize",
    "gzip",
    "identity",
    "stalled",
  ] as const;

  for (const mode of modes) {
    await t.test(mode, async (subtest) => {
      const ready = JSON.stringify({
        coverage: "ready",
        finalizerAssurance: "isolated_profile",
        activeLeaseCount: 0,
        openclawVersion: "2026.7.2",
        _readyNonce: "placeholder",
      });
      const oversized = JSON.stringify({
        coverage: "ready",
        finalizerAssurance: "isolated_profile",
        activeLeaseCount: 0,
        openclawVersion: "2026.7.2",
        _readyNonce: "placeholder",
        padding: "A".repeat(70 * 1024),
      });
      const server = http.createServer((request, response) => {
        const authed = request.headers.authorization === "Bearer token";
        if (!authed) {
          response.statusCode = 401;
          response.end("unauthorized");
          return;
        }
        if (request.url !== "/agent-guard/native-guard/v1/status") {
          response.statusCode = 200;
          response.end("ready");
          return;
        }
        const nonce = request.headers["x-agent-guard-ready-nonce"];
        const withNonce = (body: string) => body.replace("placeholder", String(nonce));
        response.statusCode = 200;
        if (mode === "wrong-content-type") {
          response.setHeader("content-type", "text/plain");
          response.end(withNonce(ready));
        } else if (mode === "declared-oversize") {
          const body = withNonce(oversized);
          response.setHeader("content-type", "application/json");
          response.setHeader("content-length", Buffer.byteLength(body));
          response.end(body);
        } else if (mode === "streaming-oversize") {
          const body = withNonce(oversized);
          response.setHeader("content-type", "application/json");
          response.write(body.slice(0, 40 * 1024));
          response.end(body.slice(40 * 1024));
        } else if (mode === "gzip") {
          response.setHeader("content-type", "application/json");
          response.setHeader("content-encoding", "gzip");
          response.end(gzipSync(withNonce(ready)));
        } else if (mode === "identity") {
          response.setHeader("content-type", "application/json");
          response.setHeader("content-encoding", "identity");
          response.end(withNonce(ready));
        } else {
          response.setHeader("content-type", "application/json");
          response.write("{");
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      subtest.after(() => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const address = server.address();
      const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
      const child = {
        exitCode: null as number | null,
        kill: () => { child.exitCode = 1; },
      };
      const startedAt = Date.now();

      await assert.rejects(
        waitForGateway(url, "token", child, new AbortController().signal, 1, 1),
        /ready|Gateway/i,
      );
      assert.ok(Date.now() - startedAt < 1_500, `${mode} readiness attempt was not bounded`);
    });
  }
});

test("rejects a nonce-correct Gateway whose native guard runtime is unsupported", async (t) => {
  const server = http.createServer((request, response) => {
    const authed = request.headers.authorization === "Bearer token";
    if (!authed) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    const nonce = request.headers["x-agent-guard-ready-nonce"] as string | undefined;
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      coverage: "unsupported",
      finalizerAssurance: "unverified",
      activeLeaseCount: 0,
      openclawVersion: "2026.7.2",
      ...(nonce ? { _readyNonce: nonce } : {}),
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  await assert.rejects(
    waitForGateway(url, "token", child, new AbortController().signal, 2, 1),
    /ready|Gateway/i,
  );
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

test("preflight probes static native guard capability in an isolated profile", async () => {
  const { runner } = runnerFor();
  const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const previousUrl = process.env.OPENCLAW_GATEWAY_URL;
  process.env.OPENCLAW_GATEWAY_TOKEN = "host-secret-must-not-pass";
  process.env.OPENCLAW_GATEWAY_URL = "http://host-gateway.invalid";
  const probeInputs: Array<{
    env: Record<string, string>;
    isolatedProfile: boolean;
  }> = [];
  const manager = new DetectionSandboxManager({
    runGroupId: "run-capability", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async (input) => {
      probeInputs.push(input);
      return readyCapability();
    },
  });
  try {
    await manager.preflight();
    assert.equal(probeInputs.length, 1);
    assert.equal(probeInputs[0]?.isolatedProfile, true);
    assert.equal(probeInputs[0]?.env.OPENCLAW_GATEWAY_TOKEN, undefined);
    assert.equal(probeInputs[0]?.env.OPENCLAW_GATEWAY_URL, undefined);
  } finally {
    if (previousToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
    if (previousUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = previousUrl;
    await manager.cleanup().catch(() => undefined);
  }
});

test("invalid static native guard capability fails before Gateway launch", async () => {
  const { runner } = runnerFor();
  let launches = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-static-capability-invalid",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => ({
      ...readyCapability(),
      supportsNativeGuard: false,
    }),
    gatewayLauncher: async (input) => {
      launches += 1;
      return {
        url: input.gatewayUrl,
        token: input.token,
        attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
        process: gatewayLifetimeProcess(),
      };
    },
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
  });

  await assert.rejects(
    manager.start(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "OPENCLAW_CAPABILITY_UNAVAILABLE",
  );
  assert.equal(launches, 0);
  await manager.cleanup().catch(() => undefined);
});

test("start reuses healthy static capability and still validates the live Gateway", async () => {
  const { runner } = runnerFor();
  let capabilityProbes = 0;
  let launches = 0;
  let runtimeStatusProbes = 0;
  let gatewayAttestations = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-static-capability-cached",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbes += 1;
      return readyCapability();
    },
    gatewayLauncher: async (input) => {
      launches += 1;
      return {
        url: input.gatewayUrl,
        token: input.token,
        attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
        process: gatewayLifetimeProcess(),
      };
    },
    runtimeStatusProbe: async () => {
      runtimeStatusProbes += 1;
      return readyRuntimeStatus();
    },
    gatewayAttestationProbe: async (input) => {
      gatewayAttestations += 1;
      return readyGatewayAttestation(input);
    },
  });

  try {
    await manager.preflight();
    assert.equal(capabilityProbes, 1);
    assert.equal(launches, 0);
    assert.equal(runtimeStatusProbes, 0);
    assert.equal(gatewayAttestations, 0);

    await manager.start();
    assert.equal(capabilityProbes, 1);
    assert.equal(launches, 1);
    assert.equal(runtimeStatusProbes, 1);
    assert.equal(gatewayAttestations, 1);
    assert.ok(manager.getGatewayCredentials());
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("production start binds host identity through direct core HTTP and checks plugin status", async () => {
  const { runner } = runnerFor();
  const hostChallenges: string[] = [];
  let attestationAuthorization: string | undefined;
  let attestationContentType: string | undefined;
  let gatewayServer: http.Server | undefined;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-host-attestation",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => {
      const routes: Array<{
        path: string;
        handler: (request: http.IncomingMessage, response: http.ServerResponse) => unknown;
      }> = [];
      registerControlRoutes({
        registerHttpRoute: (route) => {
          routes.push(route);
          return true;
        },
      }, {
        abortSignal: new AbortController().signal,
        status: async () => ({
          coverage: "off" as const,
          finalizerAssurance: "unverified" as const,
          activeLeaseCount: 0,
        }),
      } as never);
      const statusRoute = routes.find((route) =>
        route.path === "/agent-guard/native-guard/v1/status");
      assert.ok(statusRoute);
      gatewayServer = http.createServer(async (request, response) => {
        if (request.headers.authorization !== `Bearer ${input.token}`) {
          response.statusCode = 401;
          response.end("unauthorized");
          return;
        }
        if (request.url === "/") {
          response.statusCode = 200;
          response.end("ready");
          return;
        }
        if (request.url === statusRoute.path) {
          void Promise.resolve(statusRoute.handler(request, response));
          return;
        }
        if (request.url === "/agent-guard/native-guard/v1/gateway-attestation") {
          attestationAuthorization = request.headers.authorization;
          attestationContentType = request.headers["content-type"];
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            challenge: string;
          };
          hostChallenges.push(body.challenge);
          response.statusCode = 200;
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify(readyGatewayAttestation({
            challenge: body.challenge,
            gatewayUrl: input.gatewayUrl,
          })));
          return;
        }
        response.statusCode = 404;
        response.end("not found");
      });
      const address = new URL(input.gatewayUrl);
      await new Promise<void>((resolve, reject) => {
        gatewayServer!.once("error", reject);
        gatewayServer!.listen(Number(address.port), address.hostname, resolve);
      });
      const exited = new Promise<void>((resolve) => gatewayServer!.once("close", resolve));
      return {
        url: input.gatewayUrl,
        token: input.token,
        attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
        process: {
          kill: () => { gatewayServer?.close(); },
          forceKill: () => { gatewayServer?.closeAllConnections(); gatewayServer?.close(); },
          waitForExit: () => exited,
        },
      };
    },
  });

  try {
    const evidence = await manager.start();
    assert.match(evidence.gatewayUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(hostChallenges.length >= 1);
    assert.ok(hostChallenges.every((challenge) => /^[A-Za-z0-9_-]{32}$/.test(challenge)));
    assert.equal(
      attestationAuthorization,
      `Bearer ${manager.getGatewayCredentials()?.gatewayToken}`,
    );
    assert.equal(attestationContentType, "application/json");
    assert.equal(JSON.stringify(livePluginInventory()).includes("gatewayBinding"), false);
  } finally {
    await manager.cleanup().catch(() => undefined);
    gatewayServer?.closeAllConnections();
    gatewayServer?.close();
  }
});

test("default launcher binds signed Gateway proof to the child fd3 bootstrap key", async (t) => {
  const fixture = await createGatewayCliFixture("valid");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-bootstrap-valid",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    cliPath: fixture.cliPath,
    commandRunner: runner,
  });

  try {
    const evidence = await manager.start();
    assert.match(evidence.gatewayUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("default launcher keeps the bootstrap pipe attached across the OpenClaw compile-cache launcher", async (t) => {
  const fixture = await createGatewayCliFixture("valid");
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const wrapperPath = path.join(fixture.root, "compile-cache-launcher.mjs");
  await fs.writeFile(wrapperPath, `
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = new URL("./gateway-fixture.mjs", import.meta.url);
if (process.env.NODE_DISABLE_COMPILE_CACHE === "1") {
  await import(target.href);
} else {
  const child = spawn(process.execPath, [fileURLToPath(target), ...process.argv.slice(2)], {
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", () => process.exit(1));
  child.once("exit", (code) => process.exit(code ?? 1));
}
`, { encoding: "utf8", mode: 0o700 });
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-bootstrap-compile-cache-launcher",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    cliPath: wrapperPath,
    commandRunner: runner,
  });

  try {
    const evidence = await settleWithin(manager.start(), 3_000);
    assert.match(evidence.gatewayUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("Windows wrapper-local env cannot replace the run-scoped isolated profile", {
  skip: process.platform !== "win32",
}, async (t) => {
  const fixture = await createGatewayCliFixture("valid", {
    wrapperLocalProfile: true,
    recordGatewayEnv: true,
  });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const { runner } = runnerFor();
  const observedCliEnvs: NodeJS.ProcessEnv[] = [];
  const manager = new DetectionSandboxManager({
    runGroupId: "run-wrapper-env-priority",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    cliPath: fixture.cliPath,
    commandRunner: async (input) => {
      if (
        input.command === process.execPath &&
        (input.args.includes("--version") || input.args.includes("plugins"))
      ) {
        observedCliEnvs.push({ ...input.env });
      }
      return runner(input);
    },
  });

  try {
    const evidence = await manager.start();
    assert.ok(observedCliEnvs.length >= 3);
    for (const env of observedCliEnvs) {
      assert.equal(env.OPENCLAW_HOME, evidence.profileRoot);
      assert.equal(env.OPENCLAW_CONFIG_DIR, evidence.profileRoot);
      assert.equal(env.OPENCLAW_CONFIG_PATH, evidence.configPath);
      assert.equal(env.OPENCLAW_STATE_DIR, path.join(evidence.profileRoot, "state"));
      assert.equal(env.OPENCLAW_WORKSPACE_DIR, path.join(evidence.profileRoot, "workspace"));
    }
    assert.ok(fixture.gatewayEnvPath);
    const gatewayEnv = JSON.parse(
      await fs.readFile(fixture.gatewayEnvPath, "utf8"),
    ) as Record<string, string>;
    assert.equal(gatewayEnv.OPENCLAW_HOME, evidence.profileRoot);
    assert.equal(gatewayEnv.OPENCLAW_CONFIG_DIR, evidence.profileRoot);
    assert.equal(gatewayEnv.OPENCLAW_CONFIG_PATH, evidence.configPath);
    assert.equal(gatewayEnv.OPENCLAW_STATE_DIR, path.join(evidence.profileRoot, "state"));
    assert.equal(gatewayEnv.OPENCLAW_WORKSPACE_DIR, path.join(evidence.profileRoot, "workspace"));
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("default launcher fails closed for missing, oversized, or wrong-key bootstrap identity", async (t) => {
  for (const mode of ["missing", "oversize", "wrong-key"] as const) {
    await t.test(mode, async (subtest) => {
      const fixture = await createGatewayCliFixture(mode);
      subtest.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
      const { runner } = runnerFor();
      let sampleRuns = 0;
      const manager = new DetectionSandboxManager({
        runGroupId: `run-bootstrap-${mode}`,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        cliPath: fixture.cliPath,
        commandRunner: runner,
      });

      try {
        await assert.rejects(
          manager.runSession("session-1", async () => { sampleRuns += 1; }),
          (error: unknown) =>
            error instanceof SandboxPreflightError &&
            error.code === (mode === "wrong-key"
              ? "OPENCLAW_CAPABILITY_UNAVAILABLE"
              : "GATEWAY_BOOTSTRAP_INVALID"),
        );
        assert.equal(sampleRuns, 0);
      } finally {
        await manager.cleanup().catch(() => undefined);
      }
    });
  }
});

test("default launcher contains missing and unexecutable CLI spawn errors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-invalid-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missingCli = path.join(root, "missing-secret-openclaw.exe");
  const unexecutableCli = path.join(
    root,
    process.platform === "win32" ? "invalid-secret-openclaw.exe" : "invalid-secret-openclaw",
  );
  await fs.writeFile(unexecutableCli, "not an executable", {
    encoding: "utf8",
    mode: process.platform === "win32" ? 0o700 : 0o600,
  });

  for (const [name, cliPath] of [
    ["missing", missingCli],
    ["unexecutable", unexecutableCli],
  ] as const) {
    await t.test(name, async () => {
      const { runner } = runnerFor();
      const uncaught: unknown[] = [];
      const rejections: unknown[] = [];
      const monitor = (error: unknown): void => { uncaught.push(error); };
      const rejectionMonitor = (error: unknown): void => { rejections.push(error); };
      process.on("uncaughtExceptionMonitor", monitor);
      process.on("unhandledRejection", rejectionMonitor);
      const manager = new DetectionSandboxManager({
        runGroupId: `run-invalid-cli-${name}`,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        cliPath,
        commandRunner: runner,
      });
      try {
        await assert.rejects(
          () => settleWithin(manager.start(), 2_000),
          (error: unknown) => {
            assert.ok(error instanceof SandboxPreflightError);
            assert.equal(error.code, "GATEWAY_START_FAILED");
            assert.equal(error.message, "Detection Gateway could not be started.");
            assert.doesNotMatch(error.stack ?? "", /--token|gateway run|secret-openclaw/i);
            return true;
          },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(uncaught, []);
        assert.deepEqual(rejections, []);
      } finally {
        process.removeListener("uncaughtExceptionMonitor", monitor);
        process.removeListener("unhandledRejection", rejectionMonitor);
        await manager.cleanup().catch(() => undefined);
      }
    });
  }
});

test("Gateway exit after signed attestation invalidates credentials before the first sample", async () => {
  const { runner } = runnerFor();
  const gatewayExit = deferred<void>();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-gateway-exit-before-sample",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: {
        kill: () => gatewayExit.resolve(),
        waitForExit: () => gatewayExit.promise,
      },
    }),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => readyCapability(),
  });

  try {
    await manager.start();
    assert.ok(manager.getGatewayCredentials());
    gatewayExit.resolve();
    const failure = await manager.waitForGatewayFailure();
    assert.equal(failure.code, "GATEWAY_EXITED");
    assert.equal(manager.signal.aborted, true);
    assert.equal(manager.getGatewayCredentials(), undefined);
    let takeoverServerCalls = 0;
    const callTakeoverServer = async () => {
      takeoverServerCalls += 1;
      return { ok: true };
    };
    await assert.rejects(
      () => manager.runWhileGatewayAlive(callTakeoverServer),
      (error: unknown) =>
        error instanceof SandboxPreflightError && error.code === "GATEWAY_EXITED",
    );
    assert.equal(takeoverServerCalls, 0);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("Gateway exit during a sample aborts the operation and still runs cleanup", async () => {
  const { runner } = runnerFor();
  const gatewayExit = deferred<void>();
  const sampleStarted = deferred<void>();
  let cleanupCalls = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-gateway-exit-mid-sample",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: {
        kill: () => gatewayExit.resolve(),
        waitForExit: () => gatewayExit.promise,
      },
    }),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => readyCapability(),
    onCleanup: () => { cleanupCalls += 1; },
  });
  const running = manager.runSession("session-1", async () => {
    sampleStarted.resolve();
    await new Promise<void>((_resolve, reject) => {
      manager.signal.addEventListener(
        "abort",
        () => reject(new Error("sample aborted")),
        { once: true },
      );
    });
  });

  await sampleStarted.promise;
  gatewayExit.resolve();
  await assert.rejects(
    () => settleWithin(running, 750),
    (error: unknown) =>
      error instanceof SandboxPreflightError && error.code === "GATEWAY_EXITED",
  );
  assert.equal(manager.signal.aborted, true);
  assert.equal(cleanupCalls, 1);
});

test("manager cancellation after attestation remains CANCELLED", async () => {
  await assertPostAttestationCancellation("manager");
});

test("external cancellation after attestation remains CANCELLED", async () => {
  await assertPostAttestationCancellation("external");
});

test("Gateway exit aborts a real adapter CLI before lifecycle cleanup", async (t) => {
  const fixture = await createBlockingAgentCliFixture();
  t.after(async () => {
    await terminateFixtureProcess(fixture.pidPath);
    await fs.rm(fixture.root, { recursive: true, force: true });
  });
  const { runner } = runnerFor();
  const gatewayExit = deferred<void>();
  let cleanupCalls = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-gateway-exit-real-adapter",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: {
        kill: () => gatewayExit.resolve(),
        waitForExit: () => gatewayExit.promise,
      },
    }),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => readyCapability(),
    onCleanup: () => { cleanupCalls += 1; },
  });

  const running = manager.runSession("session-real-adapter", async () => {
    const adapter = new OpenClawAdapter({
      cliPath: fixture.cliPath,
      timeoutMs: 60_000,
      env: { OPENCLAW_TEST_PID_PATH: fixture.pidPath },
      signal: manager.signal,
    });
    const session = await adapter.createSession(
      {
        schemaVersion: "mvp-1",
        agentId: "agent.real-adapter",
        name: "Real adapter fixture",
        adapterType: "openclaw",
      } as never,
      {
        schemaVersion: "mvp-1",
        adapterId: "adapter.real-adapter",
        agentId: "agent.real-adapter",
        adapterType: "openclaw",
        timeoutMs: 60_000,
      } as never,
    );
    return session.sendTask(
      {
        taskId: "task.real-adapter",
        caseId: "case.real-adapter",
        instruction: "wait until the Gateway exits",
        promptIds: [],
        resourceIds: [],
      },
      undefined,
      {
        runId: "session-real-adapter",
        caseId: "case.real-adapter",
        agentId: "agent.real-adapter",
      },
    );
  });

  const pid = await waitForFixturePid(fixture.pidPath);
  gatewayExit.resolve();
  await assert.rejects(
    () => settleWithin(running, 2_000),
    (error: unknown) =>
      error instanceof SandboxPreflightError && error.code === "GATEWAY_EXITED",
  );
  assert.equal(manager.signal.aborted, true);
  assert.equal(cleanupCalls, 1);
  assert.equal(await waitForProcessExit(pid, 1_500), true);
});

test("expected Gateway exit during cleanup does not create a lifetime failure", async () => {
  const { runner } = runnerFor();
  const gatewayExit = deferred<void>();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-gateway-expected-exit",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: {
        kill: () => gatewayExit.resolve(),
        waitForExit: () => gatewayExit.promise,
      },
    }),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => readyCapability(),
  });

  await manager.start();
  await manager.cleanup();
  assert.equal(manager.signal.aborted, false);
  assert.equal(
    await Promise.race([
      manager.waitForGatewayFailure().then(() => "failed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 30)),
    ]),
    "quiet",
  );
});

test("missing Gateway lifetime handle fails closed before samples", async () => {
  const { runner } = runnerFor();
  let sampleRuns = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-gateway-missing-lifetime",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: { kill: () => undefined },
    } as never),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => readyCapability(),
  });

  await assert.rejects(
    manager.runSession("session-1", async () => { sampleRuns += 1; }),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "GATEWAY_LIFETIME_UNAVAILABLE",
  );
  assert.equal(sampleRuns, 0);
});

test("failed cleanup cold-reprobes without old Gateway credentials and ignores its late exit", async () => {
  const { runner } = runnerFor();
  const exits = [deferred<void>(), deferred<void>()];
  const capabilityEnvs: Array<Record<string, string>> = [];
  let launches = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-gateway-generation",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayShutdownTimeoutMs: { graceful: 1, forced: 1 },
    gatewayLauncher: async (input) => {
      const index = launches++;
      return {
        url: input.gatewayUrl,
        token: input.token,
        attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
        process: {
          kill: () => {
            if (index === 1) exits[index].resolve();
          },
          forceKill: () => undefined,
          waitForExit: () => exits[index].promise,
        },
      };
    },
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async (input) => {
      capabilityEnvs.push(input.env);
      return readyCapability();
    },
  });

  try {
    await manager.start();
    const firstCredentials = manager.getGatewayCredentials();
    await assert.rejects(manager.cleanup(), /gateway-terminate/);

    await manager.start();
    assert.equal(capabilityEnvs.length, 2);
    assert.equal(capabilityEnvs[1]?.OPENCLAW_GATEWAY_URL, undefined);
    assert.equal(capabilityEnvs[1]?.OPENCLAW_GATEWAY_TOKEN, undefined);
    const replacementCredentials = manager.getGatewayCredentials();
    assert.ok(replacementCredentials);
    assert.notEqual(replacementCredentials?.gatewayToken, firstCredentials?.gatewayToken);

    exits[0].resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(manager.getGatewayCredentials(), replacementCredentials);
    assert.equal(manager.signal.aborted, false);
  } finally {
    exits[1].resolve();
    await manager.cleanup().catch(() => undefined);
  }
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

test("accepts the real OpenClaw sandbox explain contract without docker config fields", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId: "run-real-explain",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
  });

  try {
    await manager.start();
    const evidence = await manager.attestSession("session-1", "before");
    assert.equal(evidence.status, "attested");
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("rejects writable or incomplete workspace mounts from sandbox explain", async (t) => {
  const cases = [
    {
      name: "writable workspace",
      mutate(payload: ReturnType<typeof realSandboxExplain>) {
        payload.sandbox.workspaceMounts[0].writable = true;
      },
    },
    {
      name: "missing agent mount",
      mutate(payload: ReturnType<typeof realSandboxExplain>) {
        payload.sandbox.workspaceMounts = payload.sandbox.workspaceMounts.filter(
          (mount) => mount.containerRoot !== "/agent",
        );
      },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const { runner } = runnerFor();
      const manager = new DetectionSandboxManager({
        ...readyGatewayTestOptions(),
        runGroupId: `run-explain-mount-mismatch-${index}`,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        commandRunner: async (input) => {
          if (input.args.includes("sandbox") && input.args.includes("explain")) {
            const payload = realSandboxExplain();
            fixture.mutate(payload);
            return { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" };
          }
          return runner(input);
        },
      });

      try {
        await manager.start();
        await assert.rejects(
          manager.attestSession("session-1", "before"),
          (error: unknown) =>
            error instanceof SandboxAttestationError &&
            error.code === "SANDBOX_EXPLAIN_MISMATCH",
        );
      } finally {
        await manager.cleanup().catch(() => undefined);
      }
    });
  }
});

test("rejects a sandbox explain mismatch and cleans only labeled objects", async () => {
  const { runner, calls } = runnerFor();
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId: "run-1", image: `openclaw@sha256:${"a".repeat(64)}`, commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain")) {
        return { ...result, stdout: JSON.stringify({ sandbox: { backend: "host" } }) };
      }
      return result;
    },
  });
  await manager.start();
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
  let capabilityInput: DetectionCommandInput | undefined;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-version", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      if (input.args.includes("plugins")) capabilityInput = input;
      return runner(input);
    },
    gatewayLauncher: async (input) => {
      launchEnv = input.env;
      return {
        url: input.gatewayUrl,
        token: input.token,
        attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
        process: gatewayLifetimeProcess(),
      };
    },
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
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
  assert.equal(capabilityInput?.env?.OPENCLAW_GATEWAY_URL, undefined);
  assert.equal(capabilityInput?.env?.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(capabilityInput?.timeoutMs, 30_000);
  assert.deepEqual((await fs.readdir(evidence.profileRoot ? `${process.cwd()}/outputs/openclaw-detection/run-version` : "")).sort(), ["config.json", "hashes.json"]);
  const persisted = JSON.parse(await fs.readFile(`${process.cwd()}/outputs/openclaw-detection/run-version/config.json`, "utf8"));
  assert.deepEqual(persisted.agents.defaults.sandbox.docker.labels, { "agent-guard.run-group": "run-version", "agent-guard.role": "agent" });
  await manager.cleanup();
});

test("uses the resolved JavaScript CLI invocation for sandbox attestation", async () => {
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-js-attestation-"));
  const cliPath = path.join(fixtureRoot, "openclaw.mjs");
  await fs.writeFile(cliPath, "export {};\n", "utf8");
  const { runner } = runnerFor();
  const calls: DetectionCommandInput[] = [];
  const manager = new DetectionSandboxManager({
    runGroupId: "run-js-attestation",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    cliPath,
    outputRoot: path.join(fixtureRoot, "evidence"),
    commandRunner: async (input) => {
      calls.push(input);
      return runner(input);
    },
    ...readyGatewayTestOptions(),
  });

  try {
    await manager.start();
    await manager.attestSession("session-js", "before");
    const explain = calls.find((call) => call.args.includes("explain"));
    assert.equal(explain?.command, process.execPath);
    assert.deepEqual(explain?.args.slice(0, 4), [
      path.resolve(cliPath),
      "sandbox",
      "explain",
      "--session",
    ]);
  } finally {
    await manager.cleanup().catch(() => undefined);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("concurrent starts share the live capability barrier", async () => {
  const { runner } = runnerFor();
  const probeEntered = deferred<void>();
  const releaseProbe = deferred<void>();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-concurrent-start",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: gatewayLifetimeProcess(),
    }),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => {
      probeEntered.resolve();
      await releaseProbe.promise;
      return {
        openclawVersion: "2026.7.2",
        supportsNativeGuard: true,
        finalizerAssurance: "isolated_profile",
        conflictingPluginIds: [],
      };
    },
  });

  const first = manager.start();
  await probeEntered.promise;
  let secondResolved = false;
  const second = manager.start().then((value) => {
    secondResolved = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondResolved, false);
  releaseProbe.resolve();
  const [firstEvidence, secondEvidence] = await Promise.all([first, second]);
  assert.equal(secondEvidence.gatewayUrl, firstEvidence.gatewayUrl);
  await manager.cleanup();
});

test("cleanup stops the Gateway before enumerating Docker resources", async () => {
  const { runner } = runnerFor();
  const operations: string[] = [];
  let cleaning = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-cleanup-order",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      if (cleaning && input.command === "docker" && input.args[0] === "ps") {
        operations.push("docker-inventory");
      }
      return runner(input);
    },
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: gatewayLifetimeProcess(() => { operations.push("gateway-stop"); }),
    }),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => ({
      openclawVersion: "2026.7.2",
      supportsNativeGuard: true,
      finalizerAssurance: "isolated_profile",
      conflictingPluginIds: [],
    }),
  });

  await manager.start();
  cleaning = true;
  await manager.cleanup();
  assert.ok(operations.indexOf("gateway-stop") >= 0);
  assert.ok(operations.indexOf("docker-inventory") >= 0);
  assert.ok(
    operations.indexOf("gateway-stop") < operations.indexOf("docker-inventory"),
    operations.join(", "),
  );
});

test("cleanup fails closed after three retries when force-killed Gateway never exits", async () => {
  const { runner } = runnerFor();
  let gracefulKills = 0;
  let forceKills = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-stuck-gateway",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayShutdownTimeoutMs: { graceful: 5, forced: 5 },
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: {
        kill: () => { gracefulKills += 1; },
        forceKill: () => { forceKills += 1; },
        waitForExit: () => new Promise<void>(() => undefined),
      },
    }),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => ({
      openclawVersion: "2026.7.2",
      supportsNativeGuard: true,
      finalizerAssurance: "isolated_profile",
      conflictingPluginIds: [],
    }),
  });

  await manager.start();
  await assert.rejects(manager.cleanup(), /gateway-terminate/);
  assert.equal(gracefulKills, 3);
  assert.equal(forceKills, 3);
  assert.equal(
    manager.getCleanupErrors().filter((entry) => entry.operation === "gateway-terminate").length,
    3,
  );
});

test("rejects a non-ready Gateway even when the CLI reports complete capability", async () => {
  const { runner } = runnerFor();
  let gatewayKills = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-runtime-status",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    gatewayLauncher: async (input) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: gatewayLifetimeProcess(() => { gatewayKills += 1; }),
    }),
    capabilityProbe: async () => ({
      openclawVersion: "2026.7.2",
      supportsNativeGuard: true,
      finalizerAssurance: "isolated_profile",
      conflictingPluginIds: [],
    }),
    runtimeStatusProbe: async () => ({
      coverage: "unsupported",
      finalizerAssurance: "unverified",
      activeLeaseCount: 0,
      openclawVersion: "2026.7.2",
    }),
  });

  await assert.rejects(
    manager.start(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "OPENCLAW_CAPABILITY_UNAVAILABLE",
  );
  assert.ok(gatewayKills > 0);
  assert.equal(manager.getGatewayCredentials(), undefined);
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

test("accepts the two read-only OpenClaw profile bind mounts during container attestation", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-real-container-mounts";
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "inspect" && profileRoot) {
        return {
          ...result,
          stdout: JSON.stringify([realAgentContainerInspect(profileRoot, runGroupId)]),
        };
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const evidence = await manager.attestSession("session-1", "after");
    assert.equal(evidence.status, "attested");
    assert.equal(evidence.containerId, "agent-1");
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("rejects missing, writable, extra, or escaped OpenClaw profile bind mounts", async (t) => {
  const cases = [
    {
      name: "missing HostConfig binds",
      mutate(record: ReturnType<typeof realAgentContainerInspect>) {
        delete (record.HostConfig as Record<string, unknown>).Binds;
      },
    },
    {
      name: "null HostConfig binds",
      mutate(record: ReturnType<typeof realAgentContainerInspect>) {
        (record.HostConfig as Record<string, unknown>).Binds = null;
      },
    },
    {
      name: "writable workspace bind",
      mutate(record: ReturnType<typeof realAgentContainerInspect>) {
        record.Mounts[0].RW = true;
      },
    },
    {
      name: "extra bind",
      mutate(record: ReturnType<typeof realAgentContainerInspect>) {
        record.HostConfig.Binds.push(`${record.Mounts[0].Source}:/extra:ro,z`);
        record.Mounts.push({
          Type: "bind",
          Source: record.Mounts[0].Source,
          Destination: "/extra",
          Mode: "ro,z",
          RW: false,
          Propagation: "rprivate",
        });
      },
    },
    {
      name: "workspace source outside the profile sandbox root",
      mutate(record: ReturnType<typeof realAgentContainerInspect>) {
        const outsideSource = path.resolve(record.Mounts[0].Source, "..", "..", "outside");
        record.Mounts[0].Source = outsideSource;
        record.HostConfig.Binds[0] = `${outsideSource}:/workspace:ro,z`;
      },
    },
    {
      name: "workspace source is nested below the session root",
      mutate(record: ReturnType<typeof realAgentContainerInspect>) {
        const nestedSource = path.join(record.Mounts[0].Source, "nested");
        record.Mounts[0].Source = nestedSource;
        record.HostConfig.Binds[0] = `${nestedSource}:/workspace:ro,z`;
      },
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const { runner } = runnerFor();
      const runGroupId = `run-container-mount-mismatch-${index}`;
      let profileRoot: string | undefined;
      const manager = new DetectionSandboxManager({
        ...readyGatewayTestOptions(),
        runGroupId,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        commandRunner: async (input) => {
          const result = await runner(input);
          if (input.args[0] === "inspect" && profileRoot) {
            const record = realAgentContainerInspect(profileRoot, runGroupId);
            fixture.mutate(record);
            return { ...result, stdout: JSON.stringify([record]) };
          }
          return result;
        },
      });

      try {
        profileRoot = (await manager.start()).profileRoot;
        await assert.rejects(
          manager.attestSession("session-1", "after"),
          (error: unknown) =>
            error instanceof SandboxAttestationError &&
            error.code === "CONTAINER_ATTESTATION_MISMATCH",
        );
      } finally {
        await manager.cleanup().catch(() => undefined);
      }
    });
  }
});

test("fails after-run attestation when Docker resource limits do not match", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId: "run-resource", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "inspect") {
        return { ...result, stdout: JSON.stringify([{ Id: "container-1", Config: { Labels: { "agent-guard.run-group": "run-resource" } }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], PidsLimit: 1, Memory: 1, MemorySwap: 1, NanoCpus: 1, Binds: [] } }]) };
      }
      return result;
    },
  });
  await manager.start();
  await assert.rejects(manager.attestSession("session-1", "after"), (error: unknown) => error instanceof SandboxAttestationError && error.code === "CONTAINER_ATTESTATION_MISMATCH");
  await manager.cleanup();
});

test("fails closed when the inspected agent is privileged or missing privilege evidence", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId: "run-privileged", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "inspect") {
        return { ...result, stdout: JSON.stringify([{ Id: "agent-1", Image: `sha256:${"a".repeat(64)}`, Config: { User: "65532:65532", Labels: { "agent-guard.run-group": "run-privileged", "agent-guard.role": "agent" } }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: true, CapDrop: ["ALL"], PidsLimit: 128, Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, Binds: [], SecurityOpt: ["no-new-privileges:true"], Tmpfs: { "/tmp": "", "/var/tmp": "", "/run": "" }, Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }] }, Mounts: [] }]) };
      }
      return result;
    },
  });
  await manager.start();
  await assert.rejects(manager.attestSession("session-1", "after"), (error: unknown) => error instanceof SandboxAttestationError && error.code === "CONTAINER_ATTESTATION_MISMATCH");
  await manager.cleanup();
});

test("fails closed when Docker adds a capability despite capDrop ALL", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId: "run-capadd", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "inspect") {
        return { ...result, stdout: JSON.stringify([{ Id: "agent-1", Image: `sha256:${"a".repeat(64)}`, Config: { User: "65532:65532", Labels: { "agent-guard.run-group": "run-capadd", "agent-guard.role": "agent" } }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, Privileged: false, CapAdd: ["SYS_ADMIN"], CapDrop: ["ALL"], PidsLimit: 128, Memory: 536870912, MemorySwap: 536870912, NanoCpus: 1000000000, Binds: [], SecurityOpt: ["no-new-privileges:true"], Tmpfs: { "/tmp": "", "/var/tmp": "", "/run": "" }, Ulimits: [{ Name: "nofile", Soft: 1024, Hard: 1024 }] }, Mounts: [] }]) };
      }
      return result;
    },
  });
  await manager.start();
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function readyRuntimeStatus() {
  return {
    coverage: "ready" as const,
    finalizerAssurance: "isolated_profile" as const,
    activeLeaseCount: 0,
    openclawVersion: "2026.7.2",
    gatewayInstanceId: "gateway.instance.1",
  };
}

function gatewayLifetimeProcess(onKill: () => void = () => undefined) {
  const exited = deferred<void>();
  return {
    kill() {
      onKill();
      exited.resolve();
    },
    forceKill() {
      onKill();
      exited.resolve();
    },
    waitForExit() {
      return exited.promise;
    },
  };
}

function readyCapability() {
  return {
    openclawVersion: "2026.7.2",
    supportsNativeGuard: true,
    finalizerAssurance: "isolated_profile" as const,
    conflictingPluginIds: [],
  };
}

function readyGatewayTestOptions() {
  return {
    gatewayLauncher: async (input: {
      gatewayUrl: string;
      token: string;
    }) => ({
      url: input.gatewayUrl,
      token: input.token,
      attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
      process: gatewayLifetimeProcess(),
    }),
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input: {
      gatewayUrl: string;
      challenge: string;
    }) => readyGatewayAttestation(input),
    capabilityProbe: async () => readyCapability(),
  };
}

async function assertPostAttestationCancellation(
  source: "manager" | "external",
): Promise<void> {
  const { runner } = runnerFor();
  const external = new AbortController();
  const gatewayExit = deferred<void>();
  const operationStarted = deferred<void>();
  let gatewayStops = 0;
  let cleanupCalls = 0;
  const manager = new DetectionSandboxManager({
    runGroupId: `run-post-attestation-${source}-cancel`,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    ...(source === "external" ? { signal: external.signal } : {}),
    gatewayLauncher: async (input) => {
      input.signal.addEventListener("abort", () => {
        gatewayStops += 1;
        gatewayExit.resolve();
      }, { once: true });
      return {
        url: input.gatewayUrl,
        token: input.token,
        attestationPublicKey: TEST_GATEWAY_KEYS.publicKey,
        process: {
          kill: () => {
            gatewayStops += 1;
            gatewayExit.resolve();
          },
          waitForExit: () => gatewayExit.promise,
        },
      };
    },
    runtimeStatusProbe: async () => readyRuntimeStatus(),
    gatewayAttestationProbe: async (input) => readyGatewayAttestation(input),
    capabilityProbe: async () => readyCapability(),
    onCleanup: () => { cleanupCalls += 1; },
  });

  const running = manager.runSession("session-cancelled", async () => {
    operationStarted.resolve();
    await new Promise<void>((_resolve, reject) => {
      const abort = (): void => reject(new Error("operation cancelled"));
      manager.signal.addEventListener("abort", abort, { once: true });
      if (manager.signal.aborted) abort();
    });
  });
  await operationStarted.promise;
  if (source === "manager") manager.cancel();
  else external.abort();

  await assert.rejects(
    () => settleWithin(running, 1_500),
    (error: unknown) =>
      error instanceof SandboxPreflightError && error.code === "CANCELLED",
  );
  assert.equal(manager.signal.aborted, true);
  assert.ok(gatewayStops >= 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(
    await Promise.race([
      manager.waitForGatewayFailure().then(() => "failed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 30)),
    ]),
    "quiet",
  );
}

function readyGatewayAttestation(input: { gatewayUrl: string; challenge: string }) {
  const unsigned = {
    contractVersion: "native-guard-gateway-1",
    signatureContext: "native_guard.gateway_attestation.v1",
    challenge: input.challenge,
    gatewayUrl: input.gatewayUrl,
    gatewayInstanceId: "gateway.instance.1",
    openclawVersion: "2026.7.2",
    nativeGuard: (livePluginInventory().registry as Record<string, unknown>).nativeGuard,
  };
  return {
    ...unsigned,
    signature: signNativeGuardPayload(unsigned, TEST_GATEWAY_KEYS.privateKey),
  };
}

function livePluginInventory() {
  return {
    plugins: [{
      id: "agent-guard-supervision",
      enabled: true,
      status: "loaded",
      hookNames: ["before_tool_call", "after_tool_call"],
      services: ["agent-guard-runtime"],
      manifest: { contracts: { trustedToolPolicies: ["agent-guard-admission"] } },
    }],
    diagnostics: [],
    registry: {
      liveAttestation: true,
      nativeGuard: {
        contractVersion: "native-guard-1",
        registrarStatus: "live",
        finalBeforeToolCall: { pluginId: "agent-guard-supervision", exclusive: true },
        trustedToolPolicy: { policyId: "agent-guard-admission", exclusive: true },
        recoveryService: { serviceId: "agent-guard-runtime", live: true },
        postApprovalLeaseRecheck: true,
        paramsProvenance: "json-only",
      },
    },
  };
}

async function createGatewayCliFixture(
  mode: "valid" | "missing" | "oversize" | "wrong-key",
  options: {
    wrapperLocalProfile?: boolean;
    recordGatewayEnv?: boolean;
  } = {},
): Promise<{ root: string; cliPath: string; gatewayEnvPath?: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-gateway-fixture-"));
  const scriptPath = path.join(root, "gateway-fixture.mjs");
  const gatewayEnvPath = options.recordGatewayEnv
    ? path.join(root, "gateway-env.json")
    : undefined;
  const source = `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";

const mode = ${JSON.stringify(mode)};
const gatewayEnvPath = ${JSON.stringify(gatewayEnvPath)};
if (gatewayEnvPath) {
  fs.writeFileSync(gatewayEnvPath, JSON.stringify({
    OPENCLAW_HOME: process.env.OPENCLAW_HOME,
    OPENCLAW_CONFIG_DIR: process.env.OPENCLAW_CONFIG_DIR,
    OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_WORKSPACE_DIR: process.env.OPENCLAW_WORKSPACE_DIR,
  }));
}
if (
  process.env.OPENCLAW_NATIVE_GUARD_BOOTSTRAP_FD !== "3" ||
  process.env.OPENCLAW_NATIVE_GUARD_BOOTSTRAP_CONTRACT !== "native-guard-bootstrap-1"
) {
  process.exit(78);
}
const args = process.argv.slice(2);
const valueAfter = (name) => args[args.indexOf(name) + 1];
if (valueAfter("--bind") !== "loopback") {
  process.exit(79);
}
const port = Number(valueAfter("--port"));
const token = valueAfter("--token");
const gatewayUrl = "http://127.0.0.1:" + String(port);
const bootstrap = generateKeyPairSync("ed25519");
const signer = mode === "wrong-key" ? generateKeyPairSync("ed25519") : bootstrap;
const encoded = bootstrap.publicKey.export({ format: "der", type: "spki" }).toString("base64");
if (mode === "missing") {
  fs.closeSync(3);
  setInterval(() => undefined, 1000);
} else if (mode === "oversize") {
  fs.writeSync(3, "A".repeat(8193) + "\\n");
  fs.closeSync(3);
  setInterval(() => undefined, 1000);
} else {
  fs.writeSync(3, JSON.stringify({ contractVersion: "native-guard-bootstrap-1", attestationPublicKey: encoded }) + "\\n");
  fs.closeSync(3);
  const nativeGuard = ${JSON.stringify((livePluginInventory().registry as Record<string, unknown>).nativeGuard)};
  const canonical = (value) => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  };
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer " + token) {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    if (request.url === "/") {
      response.statusCode = 200;
      response.end("ready");
      return;
    }
    if (request.url === "/agent-guard/native-guard/v1/status") {
      const nonce = request.headers["x-agent-guard-ready-nonce"];
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        coverage: "ready",
        finalizerAssurance: "isolated_profile",
        activeLeaseCount: 0,
        openclawVersion: "2026.7.2",
        gatewayInstanceId: "gateway.instance.fixture",
        ...(typeof nonce === "string" ? { _readyNonce: nonce } : {}),
      }));
      return;
    }
    if (request.url === "/agent-guard/native-guard/v1/gateway-attestation") {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const { challenge } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const unsigned = {
        contractVersion: "native-guard-gateway-1",
        signatureContext: "native_guard.gateway_attestation.v1",
        challenge,
        gatewayUrl,
        gatewayInstanceId: "gateway.instance.fixture",
        openclawVersion: "2026.7.2",
        nativeGuard,
      };
      const signature = sign(null, Buffer.from(canonical(unsigned), "utf8"), signer.privateKey).toString("base64url");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...unsigned, signature }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  server.listen(port, "127.0.0.1");
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
`;
  await fs.writeFile(scriptPath, source, { encoding: "utf8", mode: 0o700 });
  if (options.wrapperLocalProfile) {
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, "config", "openclaw.json"),
      JSON.stringify({ wrapperLocal: true }),
      "utf8",
    );
  }
  if (process.platform !== "win32") {
    return { root, cliPath: scriptPath, gatewayEnvPath };
  }
  const cliPath = path.join(root, "openclaw.cmd");
  await fs.writeFile(
    cliPath,
    '@echo off\r\nnode "%~dp0gateway-fixture.mjs" %*\r\n',
    "utf8",
  );
  return { root, cliPath, gatewayEnvPath };
}

async function createBlockingAgentCliFixture(): Promise<{
  root: string;
  cliPath: string;
  pidPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-cli-lifetime-"));
  const scriptPath = path.join(root, "agent-fixture.mjs");
  const pidPath = path.join(root, "pid.txt");
  await fs.writeFile(scriptPath, [
    "#!/usr/bin/env node",
    "import fs from 'node:fs';",
    "fs.writeFileSync(process.env.OPENCLAW_TEST_PID_PATH, String(process.pid));",
    "setInterval(() => undefined, 1000);",
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
  if (process.platform !== "win32") return { root, cliPath: scriptPath, pidPath };
  const cliPath = path.join(root, "openclaw.cmd");
  await fs.writeFile(
    cliPath,
    '@echo off\r\nnode "%~dp0agent-fixture.mjs" %*\r\n',
    "utf8",
  );
  return { root, cliPath, pidPath };
}

async function waitForFixturePid(pidPath: string): Promise<number> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      return Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("OpenClaw agent fixture did not start.");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } catch {
      return true;
    }
  }
  return false;
}

async function terminateFixtureProcess(pidPath: string): Promise<void> {
  let pid: number;
  try {
    pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The manager abort path may have already reaped the process.
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Operation did not settle in time.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
