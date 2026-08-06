import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import http from "node:http";
import test from "node:test";
import {
  runBenignSandboxProbe,
  startSandboxWithBenignProbe,
  verifyGatewayAuthentication,
} from "./verify-openclaw-detection-sandbox";

const SCRIPT = path.resolve("scripts", "verify-openclaw-detection-sandbox.ts");
const SCRIPT_URL = pathToFileURL(SCRIPT).href;
const IMAGE = `registry.example/openclaw-agentguard@sha256:${"a".repeat(64)}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

test("live verifier is import-safe", async () => {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `await import(${JSON.stringify(SCRIPT_URL)}); console.log("IMPORTED");`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP: "1" },
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /IMPORTED/);
});

test("benign sandbox probe uses the isolated Gateway without exposing its token in args", async () => {
  let observed: {
    command: string;
    args: string[];
    env?: NodeJS.ProcessEnv;
  } | undefined;
  await runBenignSandboxProbe({
    cliPath: "C:\\isolated\\openclaw-agentguard.exe",
    gatewayUrl: "http://127.0.0.1:18789",
    gatewayToken: "sandbox-secret-token",
    sessionKey: "verify-benign-session",
    env: { OPENCLAW_HOME: "C:\\isolated\\profile" },
    commandRunner: async (input) => {
      observed = input;
      return { exitCode: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    },
  });

  assert.ok(observed);
  assert.equal(observed.command, "C:\\isolated\\openclaw-agentguard.exe");
  assert.deepEqual(observed.args, [
    "gateway",
    "call",
    "nativeGuard.sandboxProbe",
    "--json",
    "--params",
    JSON.stringify({ sessionKey: "verify-benign-session" }),
  ]);
  assert.equal(observed.args.includes("--url"), false);
  assert.equal(observed.args.join(" ").includes("sandbox-secret-token"), false);
  assert.equal(observed.env?.OPENCLAW_GATEWAY_TOKEN, "sandbox-secret-token");
  assert.equal(observed.env?.OPENCLAW_GATEWAY_URL, "http://127.0.0.1:18789");
});

test("sandbox start failure executes zero benign probes", async () => {
  let probeCalls = 0;
  await assert.rejects(
    startSandboxWithBenignProbe({
      sandbox: {
        async start() { throw new Error("live capability failed"); },
        getGatewayCredentials() { return undefined; },
      },
      cliPath: "C:\\isolated\\openclaw-agentguard.exe",
      sessionKey: "verify-zero-samples",
      env: {},
      runProbe: async () => { probeCalls += 1; },
    }),
    /live capability failed/,
  );
  assert.equal(probeCalls, 0);
});

test("live verifier rejects official OpenClaw 2026.7.1 even with complete proof", async () => {
  const result = await runPreflightCase("OpenClaw 2026.7.1-2", liveInventory());
  assert.equal(result.ok, false);
  assert.equal(result.code, "OPENCLAW_UNSUPPORTED");
});

test("live verifier rejects an Agent Guard fork without structured live attestation", async () => {
  const result = await runPreflightCase("OpenClaw 2026.7.1-agentguard.1", {
    plugins: [agentGuardPlugin()],
    registry: { liveAttestation: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "OPENCLAW_CAPABILITY_UNAVAILABLE");
});

test("live verifier inspects a compatible fork through OPENCLAW_CLI in an isolated profile", async () => {
  const result = await runPreflightCase(
    "OpenClaw 2026.7.1-agentguard.1",
    liveInventory(),
  );
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.cliCommands, [
    "C:\\isolated\\openclaw-agentguard.exe",
    "C:\\isolated\\openclaw-agentguard.exe",
    "C:\\isolated\\openclaw-agentguard.exe",
  ]);
  assert.equal(result.cliArgs?.[0], "--version");
  assert.equal(result.cliArgs?.[1], "--version");
  assert.equal(result.cliArgs?.[2], "plugins list --enabled --json");
  assert.equal(result.profileIsIsolated, true);
  assert.equal(result.runtimeIdentityBound, true);
});

test("live verifier accepts a public Control UI when protected status enforces auth", async (t) => {
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
    if (request.headers.authorization !== "Bearer test-token") {
      response.statusCode = 401;
      response.end("unauthorized");
      return;
    }
    const nonce = request.headers["x-agent-guard-ready-nonce"];
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      coverage: "off",
      finalizerAssurance: "unverified",
      activeLeaseCount: 0,
      _readyNonce: nonce,
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const status = await verifyGatewayAuthentication({
    gatewayUrl: `http://127.0.0.1:${String(address.port)}`,
    gatewayToken: "test-token",
    nonce: "nonce.test",
  });

  assert.equal(status.coverage, "off");
  assert.equal(status._readyNonce, "nonce.test");
  assert.equal(rootRequests, 0);
});

test("live verifier bounds and validates authenticated Gateway status JSON", async (t) => {
  for (const mode of ["stalled", "oversized", "encoded", "malformed"] as const) {
    await t.test(mode, async () => {
      const server = http.createServer((request, response) => {
        if (!request.headers.authorization) {
          response.statusCode = 401;
          response.end("unauthorized");
          return;
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        if (mode === "encoded") {
          response.setHeader("content-encoding", "identity");
          response.end(JSON.stringify({ _readyNonce: "nonce.test" }));
          return;
        }
        if (mode === "oversized") {
          response.write(`{"value":"${"x".repeat(64 * 1024)}`);
          response.end('"}');
          return;
        }
        if (mode === "malformed") {
          response.end("{invalid");
          return;
        }
        response.write('{"_readyNonce":"nonce.test"');
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      assert.ok(address && typeof address === "object");
      try {
        await assert.rejects(
          () => settleWithin(
            verifyGatewayAuthentication({
              gatewayUrl: `http://127.0.0.1:${String(address.port)}`,
              gatewayToken: "test-token",
              nonce: "nonce.test",
              timeoutMs: 150,
            }),
            750,
          ),
          /cancel|timeout|size|encoded|JSON/i,
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});

type PreflightResult = {
  ok: boolean;
  code?: string;
  message?: string;
  cliCommands?: string[];
  cliArgs?: string[];
  profileIsIsolated?: boolean;
  runtimeIdentityBound?: boolean;
};

async function runPreflightCase(version: string, inventory: unknown): Promise<PreflightResult> {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "agent-guard-live-verifier-"));
  try {
    const probe = `
      const mod = await import(process.env.TEST_MODULE_URL);
      const http = await import("node:http");
      const crypto = await import("node:crypto");
      const calls = [];
      let gatewayServer;
      let runtimeIdentityBound = false;
      const attestationKeys = crypto.generateKeyPairSync("ed25519");
      const canonical = (value) => {
        if (value === null || typeof value !== "object") return JSON.stringify(value);
        if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
        return "{" + Object.keys(value).sort().map(
          (key) => JSON.stringify(key) + ":" + canonical(value[key])
        ).join(",") + "}";
      };
      const image = process.env.TEST_IMAGE;
      const imageId = process.env.TEST_IMAGE_ID;
      const runner = async (input) => {
        calls.push({ command: input.command, args: input.args, env: input.env });
        if (input.command === "docker" && input.args[0] === "version") {
          return { exitCode: 0, stdout: "29.4.0", stderr: "" };
        }
        if (input.command === "docker" && input.args[0] === "image") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ Id: imageId, RepoDigests: [image] }),
            stderr: "",
          };
        }
        if (input.command === "docker") {
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (input.args.join(" ") === "--version") {
          return { exitCode: 0, stdout: process.env.TEST_VERSION, stderr: "" };
        }
        if (input.args.join(" ") === "plugins list --enabled --json") {
          return { exitCode: 0, stdout: process.env.TEST_INVENTORY, stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected command" };
      };
      const sandbox = mod.createLiveDetectionSandbox({
        runGroupId: "live-verifier-test",
        image,
        outputRoot: process.env.TEST_OUTPUT_ROOT,
        env: { OPENCLAW_CLI: process.env.TEST_EXPLICIT_CLI },
        commandRunner: runner,
        gatewayLauncher: async (input) => {
          gatewayServer = http.createServer(async (request, response) => {
            if (request.headers.authorization !== "Bearer " + input.token) {
              response.statusCode = 401;
              response.end("unauthorized");
              return;
            }
            if (request.url === "/agent-guard/native-guard/v1/status") {
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({
                coverage: "off",
                finalizerAssurance: "unverified",
                activeLeaseCount: 0,
              }));
              return;
            }
            if (request.url === "/agent-guard/native-guard/v1/gateway-attestation") {
              const chunks = [];
              for await (const chunk of request) chunks.push(Buffer.from(chunk));
              const params = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              const inventory = JSON.parse(process.env.TEST_INVENTORY);
              runtimeIdentityBound =
                request.method === "POST" &&
                request.headers["content-type"] === "application/json" &&
                /^[A-Za-z0-9_-]{32}$/.test(params.challenge);
              response.statusCode = 200;
              response.setHeader("content-type", "application/json");
              const unsigned = {
                contractVersion: "native-guard-gateway-1",
                signatureContext: "native_guard.gateway_attestation.v1",
                challenge: params.challenge,
                gatewayUrl: input.gatewayUrl,
                gatewayInstanceId: "gateway.instance.1",
                openclawVersion: process.env.TEST_VERSION.match(
                  /[0-9]{4}[.][0-9]+[.][0-9]+(?:-[0-9A-Za-z.-]+)?/
                )?.[0],
                nativeGuard: inventory.registry?.nativeGuard,
              };
              response.end(JSON.stringify({
                ...unsigned,
                signature: crypto.sign(
                  null,
                  Buffer.from(canonical(unsigned), "utf8"),
                  attestationKeys.privateKey,
                ).toString("base64url"),
              }));
              return;
            }
            response.statusCode = 404;
            response.end("not found");
          });
          const url = new URL(input.gatewayUrl);
          await new Promise((resolve, reject) => {
            gatewayServer.once("error", reject);
            gatewayServer.listen(Number(url.port), url.hostname, resolve);
          });
          const exited = new Promise((resolve) => gatewayServer.once("close", resolve));
          return {
            url: input.gatewayUrl,
            token: input.token,
            attestationPublicKey: attestationKeys.publicKey,
            process: {
              kill() { gatewayServer.close(); },
              forceKill() { gatewayServer.closeAllConnections(); gatewayServer.close(); },
              waitForExit() { return exited; },
            },
          };
        },
      });
      let result;
      try {
        const started = await sandbox.start();
        const credentials = sandbox.getGatewayCredentials();
        const cliCalls = calls.filter((call) => call.command !== "docker");
        result = {
          ok: true,
          cliCommands: cliCalls.map((call) => call.command),
          cliArgs: cliCalls.map((call) => call.args.join(" ")),
          profileIsIsolated: cliCalls.every((call) =>
            typeof call.env?.OPENCLAW_HOME === "string" &&
            call.env.OPENCLAW_HOME !== process.env.OPENCLAW_HOME &&
            call.env.OPENCLAW_CONFIG_PATH?.startsWith(call.env.OPENCLAW_HOME)
          ),
          runtimeIdentityBound:
            runtimeIdentityBound &&
            typeof credentials?.gatewayToken === "string" &&
            started.gatewayUrl === credentials?.gatewayUrl,
        };
      } catch (error) {
        result = {
          ok: false,
          code: error && typeof error === "object" ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        };
      } finally {
        await sandbox.cleanup().catch(() => undefined);
        gatewayServer?.closeAllConnections();
        gatewayServer?.close();
      }
      console.log("PROBE_RESULT=" + JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      probe,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP: "1",
        TEST_MODULE_URL: SCRIPT_URL,
        TEST_IMAGE: IMAGE,
        TEST_IMAGE_ID: IMAGE_ID,
        TEST_VERSION: version,
        TEST_INVENTORY: JSON.stringify(inventory),
        TEST_OUTPUT_ROOT: outputRoot,
        TEST_EXPLICIT_CLI: "C:\\isolated\\openclaw-agentguard.exe",
      },
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 30_000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const resultLine = child.stdout
      .split(/\r?\n/)
      .find((line) => line.startsWith("PROBE_RESULT="));
    assert.ok(resultLine, child.stdout);
    return JSON.parse(resultLine.slice("PROBE_RESULT=".length)) as PreflightResult;
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

function agentGuardPlugin(): Record<string, unknown> {
  return {
    id: "agent-guard-supervision",
    enabled: true,
    status: "loaded",
    hookNames: ["before_tool_call"],
    services: ["agent-guard-runtime"],
    manifest: {
      contracts: { trustedToolPolicies: ["agent-guard-admission"] },
    },
  };
}

function liveInventory(): Record<string, unknown> {
  return {
    plugins: [agentGuardPlugin()],
    registry: {
      liveAttestation: true,
      nativeGuard: {
        contractVersion: "native-guard-1",
        registrarStatus: "live",
        finalBeforeToolCall: {
          pluginId: "agent-guard-supervision",
          exclusive: true,
        },
        trustedToolPolicy: {
          policyId: "agent-guard-admission",
          exclusive: true,
        },
        recoveryService: {
          serviceId: "agent-guard-runtime",
          live: true,
        },
        postApprovalLeaseRecheck: true,
        paramsProvenance: "json-only",
      },
    },
  };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation did not settle")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
