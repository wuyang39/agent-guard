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
import { OpenClawAdapter, resolveOpenClawCliPath } from "../agent/openclawAdapter";
import { resolveDetectionProfileSeed } from "./detectionProfileSeed";
import {
  DetectionSandboxManager,
  SandboxAttestationError,
  SandboxPreflightError,
  readGatewayBootstrap,
  waitForGateway,
  writeSeedSnapshotInChunks,
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
      const payload = realSandboxExplain();
      const sessionFlag = input.args.indexOf("--session");
      if (sessionFlag >= 0 && input.args[sessionFlag + 1]) {
        payload.sessionKey = input.args[sessionFlag + 1];
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify(payload),
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

async function resolveTestProfileSeed(
  stateDir: string,
  userConfig: Record<string, unknown>,
) {
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(`${configPath}.last-good`, JSON.stringify({
    agents: { defaults: userConfig },
  }));
  return resolveDetectionProfileSeed({
    env: {
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    },
  });
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

function realAgentContainerInspect(
  profileRoot: string,
  runGroupId: string,
  sessionId = "session-1",
  containerId = "agent-1",
) {
  const sandboxRoot = path.join(profileRoot, "state", "sandboxes", sessionId);
  const agentRoot = path.join(profileRoot, "workspace");
  return {
    Id: containerId,
    Image: `sha256:${"a".repeat(64)}`,
    Config: {
      User: "65532:65532",
      Labels: {
        "agent-guard.run-group": runGroupId,
        "agent-guard.role": "agent",
        "openclaw.sessionKey": sessionId,
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

function sandboxExplainForSession(profileRoot: string, sessionId: string) {
  const payload = realSandboxExplain();
  const workspaceRoot = path.join(profileRoot, "state", "sandboxes", sessionId);
  payload.sessionKey = sessionId;
  payload.sandbox.effectiveHostWorkspaceRoot = workspaceRoot;
  payload.sandbox.workspaceMounts[0].hostRoot = workspaceRoot;
  payload.sandbox.workspaceMounts[1].hostRoot = path.join(profileRoot, "workspace");
  return payload;
}

function assertCleanupDiagnostic(
  manager: DetectionSandboxManager,
  operation: string,
  expectedMessage: string,
  forbiddenText: string,
) {
  const diagnostic = manager.getCleanupErrors().find((entry) => entry.operation === operation);
  assert.ok(diagnostic?.error instanceof Error);
  assert.equal(diagnostic.error.message, expectedMessage);
  assert.ok(diagnostic.error.message.length <= 256);
  assert.doesNotMatch(diagnostic.error.message, new RegExp(forbiddenText, "i"));
}

function scopedSessionCleanupFixture(runGroupId: string) {
  const { runner } = runnerFor();
  const activeContainerIds = new Set(["agent-main", "agent-other"]);
  const removeCalls: string[][] = [];
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        const sessionFlag = input.args.indexOf("--session");
        const requested = input.args[sessionFlag + 1] ?? "";
        const agentId = requested === "agent:other:session-1" ? "other" : "main";
        const payload = sandboxExplainForSession(profileRoot, `agent-${agentId}-session-1`);
        payload.sessionKey = `agent:${agentId}:session-1`;
        return { ...result, stdout: JSON.stringify(payload) };
      }
      if (input.args[0] === "ps") {
        const idFilter = input.args.find((arg) => arg.startsWith("id="));
        const ids = idFilter
          ? (activeContainerIds.has(idFilter.slice(3)) ? [idFilter.slice(3)] : [])
          : [...activeContainerIds];
        return { ...result, stdout: ids.length ? `${ids.join("\n")}\n` : "" };
      }
      if (input.args[0] === "inspect" && profileRoot) {
        const records = input.args.slice(3)
          .filter((id) => activeContainerIds.has(id))
          .map((id) => {
            const agentId = id === "agent-other" ? "other" : "main";
            const record = realAgentContainerInspect(
              profileRoot!,
              runGroupId,
              `agent-${agentId}-session-1`,
              id,
            );
            record.Config.Labels["openclaw.sessionKey"] = `agent:${agentId}:session-1`;
            return record;
          });
        return { ...result, stdout: JSON.stringify(records) };
      }
      if (input.args[0] === "rm" && input.args[1] === "-f") {
        const ids = input.args.slice(2);
        removeCalls.push(ids);
        ids.forEach((id) => activeContainerIds.delete(id));
        return result;
      }
      return result;
    },
  });
  return {
    activeContainerIds,
    manager,
    removeCalls,
    setProfileRoot(value: string) { profileRoot = value; },
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

test("profile seed snapshots only allowlisted main-agent model state files", async (t) => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-"));
  const sourceAgentDir = path.join(sourceRoot, "agents", "main", "agent");
  await fs.mkdir(path.join(sourceAgentDir, "plugins"), { recursive: true });
  const sourceFiles = new Map<string, string | Buffer>([
    ["models.json", JSON.stringify({
      providers: {
        deepseek: {
          models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
        },
      },
    })],
    ["openclaw-agent.sqlite", Buffer.from("SQLite format 3\0seed")],
    ["openclaw-agent.sqlite-wal", "wal-state"],
    ["openclaw-agent.sqlite.evil", "must-not-copy"],
    ["auth-profiles.json", "must-not-copy"],
    ["arbitrary-tool.json", "must-not-copy"],
  ]);
  for (const [name, content] of sourceFiles) {
    await fs.writeFile(path.join(sourceAgentDir, name), content);
  }
  const profileSeed = await resolveTestProfileSeed(sourceRoot, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));

  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-allowlist",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    profileSeed,
  });
  t.after(() => manager.cleanup().catch(() => undefined));

  const evidence = await manager.preflight();
  const isolatedAgentDir = path.join(evidence.profileRoot, "state", "agents", "main", "agent");
  assert.deepEqual((await fs.readdir(isolatedAgentDir)).sort(), [
    "models.json",
    "openclaw-agent.sqlite",
    "openclaw-agent.sqlite-wal",
  ]);
  assert.equal(await fs.readFile(path.join(isolatedAgentDir, "models.json"), "utf8"), sourceFiles.get("models.json"));
  assert.equal(await fs.readFile(path.join(sourceAgentDir, "auth-profiles.json"), "utf8"), "must-not-copy");
  const isolatedConfig = JSON.parse(await fs.readFile(evidence.configPath, "utf8")) as {
    agents?: { defaults?: Record<string, unknown> };
    models?: unknown;
  };
  assert.deepEqual(isolatedConfig.agents?.defaults?.model, {
    primary: "deepseek/deepseek-v4-flash",
  });
  assert.equal(Object.hasOwn(isolatedConfig.agents?.defaults ?? {}, "models"), false);
  assert.equal(Object.hasOwn(isolatedConfig, "models"), false);
});

test("profile seed accepts built-in model state without optional models.json", async (t) => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-builtin-model-state-"));
  const sourceAgentDir = path.join(sourceRoot, "agents", "main", "agent");
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceAgentDir, "openclaw-agent.sqlite"),
    Buffer.from("SQLite format 3\0seed"),
  );
  const profileSeed = await resolveTestProfileSeed(sourceRoot, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));

  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-builtin-model",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    profileSeed,
  });
  t.after(() => manager.cleanup().catch(() => undefined));

  const evidence = await manager.preflight();
  const isolatedAgentDir = path.join(evidence.profileRoot, "state", "agents", "main", "agent");
  assert.deepEqual(await fs.readdir(isolatedAgentDir), ["openclaw-agent.sqlite"]);
});

test("profile seed destination copying checks cancellation before each chunk", async () => {
  const controller = new AbortController();
  const writes: { offset: number; length: number; position: number }[] = [];
  const writer = {
    async write(_buffer: Buffer, offset: number, length: number, position: number) {
      writes.push({ offset, length, position });
      controller.abort();
      return { bytesWritten: length };
    },
  };

  await assert.rejects(
    writeSeedSnapshotInChunks(writer, Buffer.alloc(1024 * 1024 + 1), () => {
      if (controller.signal.aborted) {
        throw new SandboxPreflightError("CANCELLED", "Detection sandbox operation was cancelled.");
      }
    }),
    (error: unknown) => error instanceof SandboxPreflightError && error.code === "CANCELLED",
  );
  assert.deepEqual(writes, [{ offset: 0, length: 1024 * 1024, position: 0 }]);
});

test("profile seed destination copying checks cancellation after the final write", async () => {
  const controller = new AbortController();
  let writes = 0;
  const writer = {
    async write(_buffer: Buffer, _offset: number, length: number, _position: number) {
      writes += 1;
      controller.abort();
      return { bytesWritten: length };
    },
  };

  await assert.rejects(
    writeSeedSnapshotInChunks(writer, Buffer.alloc(1), () => {
      if (controller.signal.aborted) {
        throw new SandboxPreflightError("CANCELLED", "Detection sandbox operation was cancelled.");
      }
    }),
    (error: unknown) => error instanceof SandboxPreflightError && error.code === "CANCELLED",
  );
  assert.equal(writes, 1);
});

test("profile seed destination copying retries partial writes from the next byte", async () => {
  const content = Buffer.alloc(1024 * 1024 + 17, 0x5a);
  const destination = Buffer.alloc(content.length);
  const writes: { offset: number; length: number; position: number }[] = [];
  const maxWriteBytes = 128 * 1024;
  const writer = {
    async write(buffer: Buffer, offset: number, length: number, position: number) {
      const bytesWritten = Math.min(length, maxWriteBytes);
      writes.push({ offset, length, position });
      buffer.copy(destination, position, offset, offset + bytesWritten);
      return { bytesWritten };
    },
  };

  await writeSeedSnapshotInChunks(writer, content, () => undefined);

  assert.deepEqual(destination, content);
  assert.deepEqual(writes.slice(0, 2), [
    { offset: 0, length: 1024 * 1024, position: 0 },
    { offset: maxWriteBytes, length: 896 * 1024, position: maxWriteBytes },
  ]);
  assert.deepEqual(writes.at(-1), {
    offset: 1024 * 1024,
    length: 17,
    position: 1024 * 1024,
  });
});

test("profile seed rejects a state root replaced after resolver approval", async (t) => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-profile-seed-identity-"));
  const approvedStateDir = `${stateDir}-approved`;
  const sourceAgentDir = path.join(stateDir, "agents", "main", "agent");
  const configPath = path.join(stateDir, "openclaw.json");
  const modelCatalog = JSON.stringify({
    providers: { deepseek: { models: [{ id: "deepseek-v4-flash" }] } },
  });
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(`${configPath}.last-good`, JSON.stringify({
    agents: { defaults: { model: { primary: "deepseek/deepseek-v4-flash" } } },
  }));
  await fs.writeFile(path.join(sourceAgentDir, "models.json"), modelCatalog);
  await fs.writeFile(path.join(sourceAgentDir, "openclaw-agent.sqlite"), Buffer.from("SQLite format 3\0approved"));
  const profileSeed = await resolveDetectionProfileSeed({
    env: {
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    },
  });

  await fs.rename(stateDir, approvedStateDir);
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(path.join(sourceAgentDir, "models.json"), modelCatalog);
  await fs.writeFile(path.join(sourceAgentDir, "openclaw-agent.sqlite"), Buffer.from("SQLite format 3\0replacement"));
  t.after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(approvedStateDir, { recursive: true, force: true });
  });

  const { runner } = runnerFor();
  let capabilityProbed = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-replaced-root",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbed = true;
      return readyCapability();
    },
    profileSeed,
  });
  t.after(() => manager.cleanup().catch(() => undefined));

  await assert.rejects(
    manager.preflight(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /changed since profile resolution/i.test(error.message),
  );
  assert.equal(capabilityProbed, false);
});

test("profile seed fails preflight before capability probing when required model state is missing", async (t) => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-missing-"));
  const sourceAgentDir = path.join(sourceRoot, "agents", "main", "agent");
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(path.join(sourceAgentDir, "models.json"), JSON.stringify({ providers: { deepseek: {} } }));
  const profileSeed = await resolveTestProfileSeed(sourceRoot, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));

  const { runner } = runnerFor();
  let capabilityProbed = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-missing",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbed = true;
      return readyCapability();
    },
    profileSeed,
  });

  await assert.rejects(
    manager.preflight(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /openclaw-agent\.sqlite/.test(error.message),
  );
  assert.equal(capabilityProbed, false);
});

test("profile seed rejects a default model whose provider is absent from models.json", async (t) => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-provider-missing-"));
  const sourceAgentDir = path.join(sourceRoot, "agents", "main", "agent");
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceAgentDir, "models.json"),
    JSON.stringify({ providers: { deepseek: { models: [{ id: "deepseek-v4-flash" }] } } }),
  );
  await fs.writeFile(path.join(sourceAgentDir, "openclaw-agent.sqlite"), Buffer.from("SQLite format 3\0seed"));
  const profileSeed = await resolveTestProfileSeed(sourceRoot, {
    model: { primary: "openai/gpt-5.5" },
  });
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));

  const { runner } = runnerFor();
  let capabilityProbed = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-provider-missing",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbed = true;
      return readyCapability();
    },
    profileSeed,
  });

  await assert.rejects(
    manager.preflight(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /provider openai/i.test(error.message),
  );
  assert.equal(capabilityProbed, false);
});

test("profile seed rejects a default model absent from its models.json provider catalog", async (t) => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-model-missing-"));
  const sourceAgentDir = path.join(sourceRoot, "agents", "main", "agent");
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceAgentDir, "models.json"),
    JSON.stringify({ providers: { deepseek: { models: [{ id: "deepseek-chat" }] } } }),
  );
  await fs.writeFile(path.join(sourceAgentDir, "openclaw-agent.sqlite"), Buffer.from("SQLite format 3\0seed"));
  const profileSeed = await resolveTestProfileSeed(sourceRoot, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));

  const { runner } = runnerFor();
  let capabilityProbed = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-model-missing",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbed = true;
      return readyCapability();
    },
    profileSeed,
  });

  await assert.rejects(
    manager.preflight(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /model deepseek-v4-flash/i.test(error.message),
  );
  assert.equal(capabilityProbed, false);
});

test("profile seed rejects malformed models.json before capability probing", async (t) => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-invalid-"));
  const sourceAgentDir = path.join(sourceRoot, "agents", "main", "agent");
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(path.join(sourceAgentDir, "models.json"), "{not-json", "utf8");
  await fs.writeFile(path.join(sourceAgentDir, "openclaw-agent.sqlite"), Buffer.from("SQLite format 3\0seed"));
  const profileSeed = await resolveTestProfileSeed(sourceRoot, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));

  const { runner } = runnerFor();
  let capabilityProbed = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-invalid-models",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbed = true;
      return readyCapability();
    },
    profileSeed,
  });

  await assert.rejects(
    manager.preflight(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /models\.json/i.test(error.message),
  );
  assert.equal(capabilityProbed, false);
});

test("profile seed rejects an invalid main-agent SQLite database before capability probing", async (t) => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-invalid-db-"));
  const sourceAgentDir = path.join(sourceRoot, "agents", "main", "agent");
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceAgentDir, "models.json"),
    JSON.stringify({ providers: { deepseek: { models: [{ id: "deepseek-v4-flash" }] } } }),
  );
  await fs.writeFile(path.join(sourceAgentDir, "openclaw-agent.sqlite"), "not-sqlite", "utf8");
  const profileSeed = await resolveTestProfileSeed(sourceRoot, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));

  const { runner } = runnerFor();
  let capabilityProbed = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-invalid-db",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbed = true;
      return readyCapability();
    },
    profileSeed,
  });

  await assert.rejects(
    manager.preflight(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /SQLite database/i.test(error.message),
  );
  assert.equal(capabilityProbed, false);
});

test("profile seed rejects an oversized allowlisted state file before capability probing", async (t) => {
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-oversized-"));
  const sourceAgentDir = path.join(sourceRoot, "agents", "main", "agent");
  await fs.mkdir(sourceAgentDir, { recursive: true });
  await fs.writeFile(
    path.join(sourceAgentDir, "models.json"),
    JSON.stringify({ providers: { deepseek: { models: [{ id: "deepseek-v4-flash" }] } } }),
  );
  const sqlitePath = path.join(sourceAgentDir, "openclaw-agent.sqlite");
  await fs.writeFile(sqlitePath, Buffer.from("SQLite format 3\0seed"));
  await fs.truncate(sqlitePath, 33 * 1024 * 1024);
  const profileSeed = await resolveTestProfileSeed(sourceRoot, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  t.after(() => fs.rm(sourceRoot, { recursive: true, force: true }));

  const { runner } = runnerFor();
  let capabilityProbed = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-oversized",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbed = true;
      return readyCapability();
    },
    profileSeed,
  });

  await assert.rejects(
    manager.preflight(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /size limit/i.test(error.message),
  );
  assert.equal(capabilityProbed, false);
});

test("profile seed rejects a junction in the main-agent state ancestry", async (t) => {
  const trustedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-junction-"));
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-model-state-junction-target-"));
  const trustedAgentDir = path.join(trustedRoot, "agents", "main", "agent");
  const outsideAgentDir = path.join(outsideRoot, "main", "agent");
  await fs.mkdir(trustedAgentDir, { recursive: true });
  await fs.mkdir(outsideAgentDir, { recursive: true });
  const modelCatalog = JSON.stringify({
    providers: { deepseek: { models: [{ id: "deepseek-v4-flash" }] } },
  });
  await fs.writeFile(path.join(trustedAgentDir, "models.json"), modelCatalog);
  await fs.writeFile(path.join(trustedAgentDir, "openclaw-agent.sqlite"), Buffer.from("SQLite format 3\0approved"));
  await fs.writeFile(
    path.join(outsideAgentDir, "models.json"),
    modelCatalog,
  );
  await fs.writeFile(path.join(outsideAgentDir, "openclaw-agent.sqlite"), Buffer.from("SQLite format 3\0seed"));
  const profileSeed = await resolveTestProfileSeed(trustedRoot, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  const junctionPath = path.join(trustedRoot, "agents");
  await fs.rm(junctionPath, { recursive: true });
  try {
    await fs.symlink(outsideRoot, junctionPath, "junction");
  } catch (error) {
    await fs.rm(trustedRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
    if (error instanceof Error && "code" in error &&
      ((error as NodeJS.ErrnoException).code === "EPERM" || (error as NodeJS.ErrnoException).code === "EACCES")) {
      t.skip("Junction creation requires additional privileges on this host");
      return;
    }
    throw error;
  }
  t.after(async () => {
    await fs.rm(trustedRoot, { recursive: true, force: true });
    await fs.rm(outsideRoot, { recursive: true, force: true });
  });

  const { runner } = runnerFor();
  let capabilityProbed = false;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-profile-seed-junction",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    capabilityProbe: async () => {
      capabilityProbed = true;
      return readyCapability();
    },
    profileSeed,
  });

  await assert.rejects(
    manager.preflight(),
    (error: unknown) =>
      error instanceof SandboxPreflightError &&
      error.code === "MODEL_PROFILE_SEED_INVALID" &&
      /symbolic link|junction/i.test(error.message),
  );
  assert.equal(capabilityProbed, false);
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

test("default readiness budget tolerates a cold Gateway after sixty seconds", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let nowMs = 0;
  let fetchCalls = 0;
  Date.now = () => nowMs;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      nowMs = 60_001;
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }

    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) {
      return new Response("unauthorized", { status: 401 });
    }
    const nonce = headers.get("x-agent-guard-ready-nonce");
    assert.ok(nonce);
    return new Response(JSON.stringify({
      coverage: "ready",
      activeLeaseCount: 0,
      _readyNonce: nonce,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  try {
    await waitForGateway(
      "http://127.0.0.1:1",
      "token",
      child,
      new AbortController().signal,
      undefined,
      0,
    );
    assert.equal(fetchCalls, 3);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("default readiness budget survives more than 1200 connection refusals", async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let nowMs = 0;
  let fetchCalls = 0;
  Date.now = () => nowMs;
  let killed = false;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    nowMs += 50;
    if (fetchCalls <= 1_201) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
      });
    }

    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (!authorization) {
      return new Response("unauthorized", { status: 401 });
    }

    assert.equal(authorization, "Bearer token");
    const nonce = headers.get("x-agent-guard-ready-nonce");
    assert.ok(nonce);
    return new Response(JSON.stringify({
      coverage: "ready",
      activeLeaseCount: 0,
      _readyNonce: nonce,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const child = { exitCode: null as number | null, kill: () => { killed = true; } };
  try {
    await waitForGateway(
      "http://127.0.0.1:1",
      "token",
      child,
      new AbortController().signal,
      undefined,
      0,
    );
    assert.equal(fetchCalls, 1_203);
    assert.equal(killed, false);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test("readiness polling stops at its absolute deadline", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  const startedAt = Date.now();
  try {
    await assert.rejects(
      waitForGateway(
        "http://127.0.0.1:1",
        "token",
        child,
        new AbortController().signal,
        2,
        100,
        25,
      ),
      (error: unknown) =>
        error instanceof SandboxPreflightError && error.code === "GATEWAY_START_FAILED",
    );
    assert.ok(Date.now() - startedAt < 150, "readiness exceeded its absolute deadline");
    assert.equal(fetchCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readiness deadline bounds stalled response cancellation", async () => {
  const originalFetch = globalThis.fetch;
  let cancelCalls = 0;
  globalThis.fetch = (async () => ({
    status: 401,
    body: {
      cancel: () => {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    },
  }) as unknown as Response) as typeof fetch;

  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  let witnessTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const readiness = waitForGateway(
      "http://127.0.0.1:1",
      "token",
      child,
      new AbortController().signal,
      1,
      0,
      5,
    ).then(
      () => "ready" as const,
      (error: unknown) => {
        assert.ok(error instanceof SandboxPreflightError);
        assert.equal(error.code, "GATEWAY_START_FAILED");
        return "failed" as const;
      },
    );
    const outcome = await Promise.race([
      readiness,
      new Promise<"deadline-exceeded">((resolve) => {
        witnessTimer = setTimeout(() => resolve("deadline-exceeded"), 15);
      }),
    ]);
    if (outcome === "deadline-exceeded") await readiness;
    assert.equal(outcome, "failed");
    assert.ok(cancelCalls >= 1);
  } finally {
    if (witnessTimer) clearTimeout(witnessTimer);
    globalThis.fetch = originalFetch;
  }
});

test("readiness deadline bounds a stalled authenticated response body", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  let cancelCalls = 0;
  const cancel = () => {
    cancelCalls += 1;
    return new Promise<void>(() => undefined);
  };
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return { status: 401, body: null } as unknown as Response;
    }
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: {
        cancel,
        getReader: () => ({
          cancel,
          read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
        }),
      },
    } as unknown as Response;
  }) as typeof fetch;

  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  let witnessTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const readiness = waitForGateway(
      "http://127.0.0.1:1",
      "token",
      child,
      new AbortController().signal,
      1,
      0,
      5,
    ).then(
      () => "ready" as const,
      (error: unknown) => {
        assert.ok(error instanceof SandboxPreflightError);
        assert.equal(error.code, "GATEWAY_START_FAILED");
        return "failed" as const;
      },
    );
    const outcome = await Promise.race([
      readiness,
      new Promise<"deadline-exceeded">((resolve) => {
        witnessTimer = setTimeout(() => resolve("deadline-exceeded"), 15);
      }),
    ]);
    if (outcome === "deadline-exceeded") await readiness;
    assert.equal(outcome, "failed");
    assert.ok(cancelCalls >= 1);
  } finally {
    if (witnessTimer) clearTimeout(witnessTimer);
    globalThis.fetch = originalFetch;
  }
});

test("readiness polling rejects invalid timeout values", async (t) => {
  for (const timeoutMs of [0, -1, 120_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await t.test(String(timeoutMs), async () => {
      const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
      await assert.rejects(
        waitForGateway(
          "http://127.0.0.1:1",
          "token",
          child,
          new AbortController().signal,
          0,
          0,
          timeoutMs,
        ),
        (error: unknown) =>
          error instanceof TypeError && error.message === "Gateway readiness timeout is invalid.",
      );
    });
  }
});

test("readiness polling fails immediately after the child exits", async () => {
  let killCalls = 0;
  const child = { exitCode: 9, kill: () => { killCalls += 1; } };
  const startedAt = Date.now();

  await assert.rejects(
    waitForGateway(
      "http://127.0.0.1:1",
      "token",
      child,
      new AbortController().signal,
      undefined,
      50,
      60_000,
    ),
    (error: unknown) =>
      error instanceof SandboxPreflightError && error.code === "GATEWAY_START_FAILED",
  );
  assert.ok(Date.now() - startedAt < 150, "readiness waited after the child exited");
  assert.equal(killCalls, 1);
});

test("readiness polling aborts an in-flight request with the caller signal", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let fetchStarted = false;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchStarted = true;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("attempt aborted")),
        { once: true },
      );
    });
  }) as typeof fetch;

  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 10);
  try {
    await assert.rejects(
      waitForGateway(
        "http://127.0.0.1:1",
        "token",
        child,
        controller.signal,
        undefined,
        500,
        60_000,
      ),
      (error: unknown) =>
        error instanceof SandboxPreflightError && error.code === "CANCELLED",
    );
    assert.equal(fetchStarted, true);
    assert.ok(Date.now() - startedAt < 150, "caller abort did not stop the in-flight request");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("readiness polling aborts an in-flight request when the child exits", async () => {
  const originalFetch = globalThis.fetch;
  let resolveChildExit: (() => void) | undefined;
  const childExit = new Promise<void>((resolve) => {
    resolveChildExit = resolve;
  });
  let fetchStarted = false;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    fetchStarted = true;
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new Error("attempt aborted")),
        { once: true },
      );
    });
  }) as typeof fetch;

  const child = { exitCode: null as number | null, kill: () => { child.exitCode = 1; } };
  const startedAt = Date.now();
  setTimeout(() => {
    child.exitCode = 9;
    resolveChildExit?.();
  }, 10);
  try {
    await assert.rejects(
      waitForGateway(
        "http://127.0.0.1:1",
        "token",
        child,
        new AbortController().signal,
        undefined,
        500,
        60_000,
        childExit,
      ),
      (error: unknown) =>
        error instanceof SandboxPreflightError && error.code === "GATEWAY_START_FAILED",
    );
    assert.equal(fetchStarted, true);
    assert.ok(Date.now() - startedAt < 150, "child exit did not stop the in-flight request");
  } finally {
    globalThis.fetch = originalFetch;
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
    assert.equal(probeInputs[0]?.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS, "1");
    assert.equal(
      probeInputs[0]?.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY,
      "1",
    );
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

test("exposes detached capability snapshots only while the live Gateway is validated", async () => {
  const { runner } = runnerFor();
  const manager = new DetectionSandboxManager({
    runGroupId: "run-attested-capability-snapshot",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: runner,
    ...readyGatewayTestOptions(),
  });

  assert.equal(manager.getAttestedCapabilitySnapshot(), undefined);
  try {
    await manager.start();
    const first = manager.getAttestedCapabilitySnapshot();
    assert.deepEqual(first, readyCapability());
    first!.conflictingPluginIds.push("mutated-outside-manager");
    assert.deepEqual(manager.getAttestedCapabilitySnapshot(), readyCapability());
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
  assert.equal(manager.getAttestedCapabilitySnapshot(), undefined);
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
  let launchCliPath: string | undefined;
  let capabilityInput: DetectionCommandInput | undefined;
  const manager = new DetectionSandboxManager({
    runGroupId: "run-version", image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      if (input.args.includes("plugins")) capabilityInput = input;
      return runner(input);
    },
    gatewayLauncher: async (input) => {
      launchEnv = input.env;
      launchCliPath = input.cliPath;
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
  assert.equal(launchCliPath, resolveOpenClawCliPath());
  assert.equal(launchEnv?.OPENCLAW_CONFIG_PATH, evidence.configPath);
  assert.equal(launchEnv?.OPENCLAW_WORKSPACE_DIR, path.join(evidence.profileRoot, "workspace"));
  assert.equal(launchEnv?.OPENCLAW_PLUGIN_DIRS, "");
  assert.equal(launchEnv?.OPENCLAW_GATEWAY_URL, evidence.gatewayUrl);
  assert.equal(capabilityInput?.env?.OPENCLAW_GATEWAY_URL, undefined);
  assert.equal(capabilityInput?.env?.OPENCLAW_GATEWAY_TOKEN, undefined);
  assert.equal(capabilityInput?.timeoutMs, 90_000);
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
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        const payload = realSandboxExplain();
        const workspaceRoot = path.join(profileRoot, "state", "sandboxes", "session-1");
        payload.sandbox.effectiveHostWorkspaceRoot = workspaceRoot;
        payload.sandbox.workspaceMounts[0].hostRoot = workspaceRoot;
        payload.sandbox.workspaceMounts[1].hostRoot = path.join(profileRoot, "workspace");
        return { ...result, stdout: JSON.stringify(payload) };
      }
      if (input.args[0] === "ps") return { ...result, stdout: "agent-1\n" };
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

test("attests the requested session when a run owns multiple compliant agent containers", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-multiple-session-containers";
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "ps" && input.args.includes(`label=agent-guard.run-group=${runGroupId}`)) {
        return { ...result, stdout: "agent-1\nagent-2\n" };
      }
      if (input.args[0] === "inspect" && profileRoot) {
        return {
          ...result,
          stdout: JSON.stringify([
            realAgentContainerInspect(profileRoot, runGroupId, "session-1", "agent-1"),
            realAgentContainerInspect(profileRoot, runGroupId, "session-2", "agent-2"),
          ]),
        };
      }
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        const payload = realSandboxExplain();
        const workspaceRoot = path.join(profileRoot, "state", "sandboxes", "session-2");
        payload.sessionKey = "session-2";
        payload.sandbox.effectiveHostWorkspaceRoot = workspaceRoot;
        payload.sandbox.workspaceMounts[0].hostRoot = workspaceRoot;
        payload.sandbox.workspaceMounts[1].hostRoot = path.join(profileRoot, "workspace");
        return { ...result, stdout: JSON.stringify(payload) };
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const evidence = await manager.attestSession("session-2", "after");
    assert.equal(evidence.status, "attested");
    assert.equal(evidence.containerId, "agent-2");
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("finalizeSessionContainer proves target absence with zero containers", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-finalize-absent-zero";
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") return { ...result, stdout: "" };
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const first = await manager.finalizeSessionContainer(
      "session-1",
      { allowNotCreated: true },
    );
    assert.equal(first.outcome, "not_created");
    assert.equal(first.sessionKey, "agent:main:session-1");
    assert.equal(first.evidence.status, "attested");
    assert.equal(first.evidence.containerId, undefined);
    const expectedEvidence = { ...first.evidence };
    first.evidence.imageId = "mutated";

    const second = await manager.finalizeSessionContainer(
      "agent:main:session-1",
      { allowNotCreated: true },
    );
    assert.deepEqual(second.evidence, expectedEvidence);
    assert.notStrictEqual(second.evidence, first.evidence);

    await assert.rejects(
      manager.attestAndCleanupSession("session-1"),
      (error: unknown) =>
        error instanceof SandboxAttestationError &&
        error.code === "CONTAINER_ATTESTATION_MISMATCH",
    );
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("finalizeSessionContainer proves target absence among unrelated sessions", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-finalize-absent-unrelated";
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") return { ...result, stdout: "agent-2\n" };
      if (input.args[0] === "inspect" && profileRoot) {
        return {
          ...result,
          stdout: JSON.stringify([
            realAgentContainerInspect(profileRoot, runGroupId, "session-2", "agent-2"),
          ]),
        };
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const result = await manager.finalizeSessionContainer(
      "session-1",
      { allowNotCreated: true },
    );
    assert.equal(result.outcome, "not_created");
    assert.equal(result.sessionKey, "agent:main:session-1");
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("concurrent strict and permissive finalization apply absence policy per caller", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-finalize-absent-concurrent";
  const inventoryStarted = deferred<void>();
  const allowInventory = deferred<void>();
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") {
        inventoryStarted.resolve();
        await allowInventory.promise;
        return { ...result, stdout: "" };
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const strict = manager.attestAndCleanupSession("session-1");
    await inventoryStarted.promise;
    const permissive = manager.finalizeSessionContainer(
      "agent:main:session-1",
      { allowNotCreated: true },
    );
    allowInventory.resolve();

    await assert.rejects(
      strict,
      (error: unknown) =>
        error instanceof SandboxAttestationError &&
        error.code === "CONTAINER_ATTESTATION_MISMATCH",
    );
    assert.equal((await permissive).outcome, "not_created");
  } finally {
    allowInventory.resolve();
    await manager.cleanup().catch(() => undefined);
  }
});

test("finalizeSessionContainer rejects partial target identity", async (t) => {
  for (const fixture of [
    {
      name: "workspace only",
      build(profileRoot: string, runGroupId: string) {
        const record = realAgentContainerInspect(profileRoot, runGroupId, "session-1", "agent-1");
        record.Config.Labels["openclaw.sessionKey"] = "session-2";
        return record;
      },
    },
    {
      name: "label only",
      build(profileRoot: string, runGroupId: string) {
        const record = realAgentContainerInspect(profileRoot, runGroupId, "session-2", "agent-1");
        record.Config.Labels["openclaw.sessionKey"] = "session-1";
        return record;
      },
    },
  ]) {
    await t.test(fixture.name, async () => {
      const { runner } = runnerFor();
      const runGroupId = `run-session-finalize-partial-${fixture.name.replaceAll(" ", "-")}`;
      let profileRoot: string | undefined;
      const manager = new DetectionSandboxManager({
        ...readyGatewayTestOptions(),
        runGroupId,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        commandRunner: async (input) => {
          const result = await runner(input);
          if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
            return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
          }
          if (input.args[0] === "ps") return { ...result, stdout: "agent-1\n" };
          if (input.args[0] === "inspect" && profileRoot) {
            return { ...result, stdout: JSON.stringify([fixture.build(profileRoot, runGroupId)]) };
          }
          return result;
        },
      });

      try {
        profileRoot = (await manager.start()).profileRoot;
        await assert.rejects(
          manager.finalizeSessionContainer("session-1", { allowNotCreated: true }),
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

test("finalizeSessionContainer rejects failed Docker inventory", async (t) => {
  for (const operation of ["list", "inspect"] as const) {
    await t.test(operation, async () => {
      const { runner } = runnerFor();
      const runGroupId = `run-session-finalize-inventory-${operation}`;
      let profileRoot: string | undefined;
      const manager = new DetectionSandboxManager({
        ...readyGatewayTestOptions(),
        runGroupId,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        commandRunner: async (input) => {
          const result = await runner(input);
          if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
            return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
          }
          if (input.args[0] === "ps") {
            return operation === "list"
              ? { ...result, exitCode: 1, stdout: "" }
              : { ...result, stdout: "agent-1\n" };
          }
          if (input.args[0] === "inspect") {
            return { ...result, exitCode: 1, stdout: "" };
          }
          return result;
        },
      });

      try {
        profileRoot = (await manager.start()).profileRoot;
        await assert.rejects(
          manager.finalizeSessionContainer("session-1", { allowNotCreated: true }),
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

test("attestAndCleanupSession removes only the exact attested session container", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-cleanup-exact";
  const activeContainerIds = new Set(["agent-1", "agent-2"]);
  const removeCalls: string[][] = [];
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") {
        const idFilter = input.args.find((arg) => arg.startsWith("id="));
        const ids = idFilter
          ? (activeContainerIds.has(idFilter.slice(3)) ? [idFilter.slice(3)] : [])
          : [...activeContainerIds];
        return { ...result, stdout: ids.length ? `${ids.join("\n")}\n` : "" };
      }
      if (input.args[0] === "inspect" && profileRoot) {
        const currentProfileRoot = profileRoot;
        const requestedIds = input.args.slice(3);
        const records = requestedIds
          .filter((id) => activeContainerIds.has(id))
          .map((id) => realAgentContainerInspect(
            currentProfileRoot,
            runGroupId,
            id === "agent-1" ? "session-1" : "session-2",
            id,
          ));
        return {
          ...result,
          exitCode: records.length === requestedIds.length ? 0 : 1,
          stdout: JSON.stringify(records),
        };
      }
      if (input.args[0] === "rm" && input.args[1] === "-f") {
        const ids = input.args.slice(2);
        removeCalls.push(ids);
        ids.forEach((id) => activeContainerIds.delete(id));
        return result;
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const evidence = await manager.attestAndCleanupSession("session-1");

    assert.equal(evidence.containerId, "agent-1");
    assert.deepEqual(removeCalls, [["agent-1"]]);
    assert.deepEqual([...activeContainerIds], ["agent-2"]);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("attestAndCleanupSession accepts Docker short list ids for a full inspected id", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-cleanup-short-id";
  const fullContainerId = "a".repeat(64);
  const shortContainerId = fullContainerId.slice(0, 12);
  let containerPresent = true;
  const removeCalls: string[][] = [];
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") {
        const id = input.args.includes("--no-trunc") ? fullContainerId : shortContainerId;
        return { ...result, stdout: containerPresent ? `${id}\n` : "" };
      }
      if (input.args[0] === "inspect" && profileRoot) {
        return containerPresent
          ? {
              ...result,
              stdout: JSON.stringify([
                realAgentContainerInspect(profileRoot, runGroupId, "session-1", fullContainerId),
              ]),
            }
          : { ...result, exitCode: 1, stdout: "" };
      }
      if (input.args[0] === "rm" && input.args[1] === "-f") {
        removeCalls.push(input.args.slice(2));
        containerPresent = false;
        return result;
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const evidence = await manager.attestAndCleanupSession("session-1");

    assert.equal(evidence.containerId, fullContainerId);
    assert.deepEqual(removeCalls, [[fullContainerId]]);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("attestAndCleanupSession returns detached tombstone evidence without removing twice", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-cleanup-idempotent";
  let containerPresent = true;
  let removeCalls = 0;
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") {
        return { ...result, stdout: containerPresent ? "agent-1\n" : "" };
      }
      if (input.args[0] === "inspect" && profileRoot) {
        return containerPresent
          ? { ...result, stdout: JSON.stringify([realAgentContainerInspect(profileRoot, runGroupId)]) }
          : { ...result, exitCode: 1, stdout: "" };
      }
      if (input.args[0] === "rm" && input.args[1] === "-f") {
        removeCalls += 1;
        containerPresent = false;
        return result;
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const first = await manager.attestAndCleanupSession("session-1");
    const expected = { ...first };
    first.containerId = "mutated-container";
    first.status = "preflight_passed";

    const second = await manager.attestAndCleanupSession("session-1");

    assert.deepEqual(second, expected);
    assert.notStrictEqual(second, first);
    assert.equal(removeCalls, 1);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("attestAndCleanupSession rejects zero or multiple matching session identities without removal", async (t) => {
  for (const fixture of [
    { name: "zero matches", sessions: ["session-2"] },
    { name: "multiple matches", sessions: ["session-1", "session-1"] },
  ]) {
    await t.test(fixture.name, async () => {
      const { runner } = runnerFor();
      const runGroupId = `run-session-cleanup-${fixture.name.replaceAll(" ", "-")}`;
      const containerIds = fixture.sessions.map((_session, index) => `agent-${index + 1}`);
      let removeCalls = 0;
      let profileRoot: string | undefined;
      const manager = new DetectionSandboxManager({
        ...readyGatewayTestOptions(),
        runGroupId,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        commandRunner: async (input) => {
          const result = await runner(input);
          if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
            return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
          }
          if (input.args[0] === "ps") {
            return { ...result, stdout: `${containerIds.join("\n")}\n` };
          }
          if (input.args[0] === "inspect" && profileRoot) {
            return {
              ...result,
              stdout: JSON.stringify(fixture.sessions.map((sessionId, index) =>
                realAgentContainerInspect(profileRoot!, runGroupId, sessionId, containerIds[index]))),
            };
          }
          if (input.args[0] === "rm" && input.args[1] === "-f") removeCalls += 1;
          return result;
        },
      });

      try {
        profileRoot = (await manager.start()).profileRoot;
        await assert.rejects(
          manager.attestAndCleanupSession("session-1"),
          (error: unknown) =>
            error instanceof SandboxAttestationError &&
            error.code === "CONTAINER_ATTESTATION_MISMATCH",
        );
        assert.equal(removeCalls, 0);
      } finally {
        await manager.cleanup().catch(() => undefined);
      }
    });
  }
});

test("attestAndCleanupSession rejects a workspace match with a missing or contradictory session label", async (t) => {
  for (const fixture of [
    {
      name: "missing label",
      mutate(record: ReturnType<typeof realAgentContainerInspect>) {
        delete (record.Config.Labels as Record<string, unknown>)["openclaw.sessionKey"];
      },
    },
    {
      name: "contradictory label",
      mutate(record: ReturnType<typeof realAgentContainerInspect>) {
        record.Config.Labels["openclaw.sessionKey"] = "session-2";
      },
    },
  ]) {
    await t.test(fixture.name, async () => {
      const { runner } = runnerFor();
      const runGroupId = `run-session-cleanup-label-${fixture.name.replaceAll(" ", "-")}`;
      let removeCalls = 0;
      let profileRoot: string | undefined;
      const manager = new DetectionSandboxManager({
        ...readyGatewayTestOptions(),
        runGroupId,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        commandRunner: async (input) => {
          const result = await runner(input);
          if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
            return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
          }
          if (input.args[0] === "ps") return { ...result, stdout: "agent-1\n" };
          if (input.args[0] === "inspect" && profileRoot) {
            const record = realAgentContainerInspect(profileRoot, runGroupId);
            fixture.mutate(record);
            return { ...result, stdout: JSON.stringify([record]) };
          }
          if (input.args[0] === "rm" && input.args[1] === "-f") removeCalls += 1;
          return result;
        },
      });

      try {
        profileRoot = (await manager.start()).profileRoot;
        await assert.rejects(
          manager.attestAndCleanupSession("session-1"),
          (error: unknown) =>
            error instanceof SandboxAttestationError &&
            error.code === "CONTAINER_ATTESTATION_MISMATCH",
        );
        assert.equal(removeCalls, 0);
      } finally {
        await manager.cleanup().catch(() => undefined);
      }
    });
  }
});

test("attestAndCleanupSession rejects a matching label mounted from an unrelated session workspace", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-cleanup-workspace-mismatch";
  let removeCalls = 0;
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        const payload = sandboxExplainForSession(profileRoot, "session-1");
        const unrelatedWorkspace = path.join(
          profileRoot,
          "state",
          "unrelated-sandboxes",
          "session-1",
        );
        payload.sandbox.effectiveHostWorkspaceRoot = unrelatedWorkspace;
        payload.sandbox.workspaceMounts[0].hostRoot = unrelatedWorkspace;
        return { ...result, stdout: JSON.stringify(payload) };
      }
      if (input.args[0] === "ps") return { ...result, stdout: "agent-1\n" };
      if (input.args[0] === "inspect" && profileRoot) {
        return { ...result, stdout: JSON.stringify([realAgentContainerInspect(profileRoot, runGroupId)]) };
      }
      if (input.args[0] === "rm" && input.args[1] === "-f") removeCalls += 1;
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    await assert.rejects(
      manager.attestAndCleanupSession("session-1"),
      (error: unknown) =>
        error instanceof SandboxAttestationError &&
        error.code === "CONTAINER_ATTESTATION_MISMATCH",
    );
    assert.equal(removeCalls, 0);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("concurrent attestAndCleanupSession calls share one removal and return detached evidence", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-cleanup-concurrent";
  const removalStarted = deferred<void>();
  const allowRemoval = deferred<void>();
  let containerPresent = true;
  let removeCalls = 0;
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") {
        return { ...result, stdout: containerPresent ? "agent-1\n" : "" };
      }
      if (input.args[0] === "inspect" && profileRoot) {
        return containerPresent
          ? { ...result, stdout: JSON.stringify([realAgentContainerInspect(profileRoot, runGroupId)]) }
          : { ...result, exitCode: 1, stdout: "" };
      }
      if (input.args[0] === "rm" && input.args[1] === "-f") {
        removeCalls += 1;
        removalStarted.resolve();
        await allowRemoval.promise;
        containerPresent = false;
        return result;
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const firstCall = manager.attestAndCleanupSession("session-1");
    const secondCall = manager.attestAndCleanupSession("agent:main:session-1");
    await removalStarted.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    allowRemoval.resolve();

    const [first, second] = await Promise.all([firstCall, secondCall]);

    assert.equal(removeCalls, 1);
    assert.deepEqual(second, first);
    assert.notStrictEqual(second, first);
    first.containerId = "mutated-container";
    assert.equal(second.containerId, "agent-1");
  } finally {
    allowRemoval.resolve();
    await manager.cleanup().catch(() => undefined);
  }
});

test("agent-scoped sessions with the same tail keep independent cleanup tombstones", async () => {
  const fixture = scopedSessionCleanupFixture("run-scoped-session-tombstones");

  try {
    fixture.setProfileRoot((await fixture.manager.start()).profileRoot);
    const mainEvidence = await fixture.manager.attestAndCleanupSession("agent:main:session-1");
    const otherEvidence = await fixture.manager.attestAndCleanupSession("agent:other:session-1");

    assert.equal(mainEvidence.containerId, "agent-main");
    assert.equal(otherEvidence.containerId, "agent-other");
    assert.deepEqual(fixture.removeCalls, [["agent-main"], ["agent-other"]]);
    assert.deepEqual([...fixture.activeContainerIds], []);
  } finally {
    await fixture.manager.cleanup().catch(() => undefined);
  }
});

test("concurrent agent-scoped sessions with the same tail do not share cleanup work", async () => {
  const fixture = scopedSessionCleanupFixture("run-scoped-session-concurrent");

  try {
    fixture.setProfileRoot((await fixture.manager.start()).profileRoot);
    const [mainEvidence, otherEvidence] = await Promise.all([
      fixture.manager.attestAndCleanupSession("agent:main:session-1"),
      fixture.manager.attestAndCleanupSession("agent:other:session-1"),
    ]);

    assert.deepEqual(
      new Set([mainEvidence.containerId, otherEvidence.containerId]),
      new Set(["agent-main", "agent-other"]),
    );
    assert.equal(fixture.removeCalls.length, 2);
    assert.deepEqual(
      new Set(fixture.removeCalls.flat()),
      new Set(["agent-main", "agent-other"]),
    );
  } finally {
    await fixture.manager.cleanup().catch(() => undefined);
  }
});

test("session cleanup recovers when a failed remove already removed the exact container", async (t) => {
  for (const fixture of [
    {
      name: "nonzero result",
      expectedDiagnostic: "Session container remove command returned a nonzero exit code.",
      fail(): DetectionCommandResult {
        return { exitCode: 1, stdout: "", stderr: "remove-secret" };
      },
    },
    {
      name: "thrown command",
      expectedDiagnostic: "Session container remove command failed.",
      fail(): never {
        throw new Error("remove-secret");
      },
    },
  ]) {
    await t.test(fixture.name, async () => {
      const { runner } = runnerFor();
      const runGroupId = `run-session-remove-recovery-${fixture.name.replaceAll(" ", "-")}`;
      let containerPresent = true;
      let inspectCalls = 0;
      let removeCalls = 0;
      let verifyCalls = 0;
      let profileRoot: string | undefined;
      const manager = new DetectionSandboxManager({
        ...readyGatewayTestOptions(),
        runGroupId,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        commandRunner: async (input) => {
          const result = await runner(input);
          if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
            return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
          }
          if (input.args[0] === "ps") {
            if (input.args.some((arg) => arg === "id=agent-1")) verifyCalls += 1;
            return { ...result, stdout: containerPresent ? "agent-1\n" : "" };
          }
          if (input.args[0] === "inspect" && profileRoot) {
            inspectCalls += 1;
            return { ...result, stdout: JSON.stringify([realAgentContainerInspect(profileRoot, runGroupId)]) };
          }
          if (input.args[0] === "rm" && input.args[1] === "-f") {
            removeCalls += 1;
            containerPresent = false;
            return fixture.fail();
          }
          return result;
        },
      });

      try {
        profileRoot = (await manager.start()).profileRoot;
        await assert.rejects(
          manager.attestAndCleanupSession("session-1"),
          (error: unknown) =>
            error instanceof SandboxAttestationError &&
            error.code === "SESSION_CONTAINER_CLEANUP_FAILED" &&
            !error.message.includes("remove-secret"),
        );
        assert.equal(verifyCalls, 1);
        assertCleanupDiagnostic(
          manager,
          "session-container-remove",
          fixture.expectedDiagnostic,
          "remove-secret",
        );

        const evidence = await manager.attestAndCleanupSession("agent:main:session-1");

        assert.equal(evidence.status, "cleaned");
        assert.equal(evidence.containerId, "agent-1");
        assert.equal(inspectCalls, 1);
        assert.equal(removeCalls, 1);
        assert.equal(verifyCalls, 2);
      } finally {
        await manager.cleanup().catch(() => undefined);
      }
    });
  }
});

test("session cleanup recovers after exact-container verification uncertainty", async (t) => {
  for (const fixture of [
    {
      name: "nonzero result",
      expectedDiagnostic: "Session container verification command returned a nonzero exit code.",
      fail(result: DetectionCommandResult): DetectionCommandResult {
        return { ...result, exitCode: 1, stdout: "", stderr: "verify-secret" };
      },
    },
    {
      name: "thrown command",
      expectedDiagnostic: "Session container verification command failed.",
      fail(): never {
        throw new Error("verify-secret");
      },
    },
    {
      name: "malformed output",
      expectedDiagnostic: "Session container verification returned malformed container identity output.",
      fail(result: DetectionCommandResult): DetectionCommandResult {
        return { ...result, stdout: "malformed id verify-secret\n" };
      },
    },
  ]) {
    await t.test(fixture.name, async () => {
      const { runner } = runnerFor();
      const runGroupId = `run-session-verify-recovery-${fixture.name.replaceAll(" ", "-")}`;
      let containerPresent = true;
      let inspectCalls = 0;
      let removeCalls = 0;
      let verifyCalls = 0;
      let profileRoot: string | undefined;
      const manager = new DetectionSandboxManager({
        ...readyGatewayTestOptions(),
        runGroupId,
        image: `openclaw@sha256:${"a".repeat(64)}`,
        commandRunner: async (input) => {
          const result = await runner(input);
          if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
            return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
          }
          if (input.args[0] === "ps") {
            if (input.args.some((arg) => arg === "id=agent-1")) {
              verifyCalls += 1;
              if (verifyCalls === 1) return fixture.fail(result);
            }
            return { ...result, stdout: containerPresent ? "agent-1\n" : "" };
          }
          if (input.args[0] === "inspect" && profileRoot) {
            inspectCalls += 1;
            return { ...result, stdout: JSON.stringify([realAgentContainerInspect(profileRoot, runGroupId)]) };
          }
          if (input.args[0] === "rm" && input.args[1] === "-f") {
            removeCalls += 1;
            containerPresent = false;
            return result;
          }
          return result;
        },
      });

      try {
        profileRoot = (await manager.start()).profileRoot;
        await assert.rejects(
          manager.attestAndCleanupSession("session-1"),
          (error: unknown) =>
            error instanceof SandboxAttestationError &&
            error.code === "SESSION_CONTAINER_CLEANUP_FAILED" &&
            !error.message.includes("verify-secret"),
        );
        assertCleanupDiagnostic(
          manager,
          "session-container-verify",
          fixture.expectedDiagnostic,
          "verify-secret",
        );

        const evidence = await manager.attestAndCleanupSession("agent:main:session-1");

        assert.equal(evidence.status, "cleaned");
        assert.equal(inspectCalls, 1);
        assert.equal(removeCalls, 1);
        assert.equal(verifyCalls, 2);
      } finally {
        await manager.cleanup().catch(() => undefined);
      }
    });
  }
});

test("session cleanup retries the retained exact ID when a failed remove leaves it present", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-remove-retry-present";
  const removedIds: string[] = [];
  let containerPresent = true;
  let inspectCalls = 0;
  let verifyCalls = 0;
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") {
        if (input.args.some((arg) => arg === "id=agent-1")) verifyCalls += 1;
        return { ...result, stdout: containerPresent ? "agent-1\n" : "" };
      }
      if (input.args[0] === "inspect" && profileRoot) {
        inspectCalls += 1;
        return { ...result, stdout: JSON.stringify([realAgentContainerInspect(profileRoot, runGroupId)]) };
      }
      if (input.args[0] === "rm" && input.args[1] === "-f") {
        removedIds.push(...input.args.slice(2));
        if (removedIds.length === 1) {
          return { ...result, exitCode: 1, stderr: "remove-secret" };
        }
        containerPresent = false;
        return result;
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    await assert.rejects(
      manager.attestAndCleanupSession("session-1"),
      (error: unknown) =>
        error instanceof SandboxAttestationError &&
        error.code === "SESSION_CONTAINER_CLEANUP_FAILED",
    );
    assertCleanupDiagnostic(
      manager,
      "session-container-remove",
      "Session container remove command returned a nonzero exit code.",
      "remove-secret",
    );
    assertCleanupDiagnostic(
      manager,
      "session-container-verify",
      "Session container verification found the exact container still present.",
      "remove-secret",
    );

    const evidence = await manager.attestAndCleanupSession("agent:main:session-1");

    assert.equal(evidence.status, "cleaned");
    assert.deepEqual(removedIds, ["agent-1", "agent-1"]);
    assert.equal(inspectCalls, 1);
    assert.equal(verifyCalls, 3);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("attestAndCleanupSession fails closed when the removed container remains visible", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-session-cleanup-verification";
  let removeCalls = 0;
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        return { ...result, stdout: JSON.stringify(sandboxExplainForSession(profileRoot, "session-1")) };
      }
      if (input.args[0] === "ps") return { ...result, stdout: "agent-1\n" };
      if (input.args[0] === "inspect" && profileRoot) {
        return { ...result, stdout: JSON.stringify([realAgentContainerInspect(profileRoot, runGroupId)]) };
      }
      if (input.args[0] === "rm" && input.args[1] === "-f") removeCalls += 1;
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    await assert.rejects(
      manager.attestAndCleanupSession("session-1"),
      (error: unknown) =>
        error instanceof SandboxAttestationError &&
        error.code === "SESSION_CONTAINER_CLEANUP_FAILED",
    );
    assert.equal(removeCalls, 1);
  } finally {
    await manager.cleanup().catch(() => undefined);
  }
});

test("attests a live probe whose CLI explain canonicalizes the container session key", async () => {
  const { runner } = runnerFor();
  const runGroupId = "run-canonicalized-probe-session";
  const sessionKey = "run-canonicalized-probe-session.benign";
  let profileRoot: string | undefined;
  const manager = new DetectionSandboxManager({
    ...readyGatewayTestOptions(),
    runGroupId,
    image: `openclaw@sha256:${"a".repeat(64)}`,
    commandRunner: async (input) => {
      const result = await runner(input);
      if (input.args[0] === "ps") return { ...result, stdout: "agent-probe\n" };
      if (input.args[0] === "inspect" && profileRoot) {
        const record = realAgentContainerInspect(
          profileRoot,
          runGroupId,
          "agent-main-run-canonicalized-probe-session",
          "agent-probe",
        );
        record.Config.Labels["openclaw.sessionKey"] = sessionKey;
        return {
          ...result,
          stdout: JSON.stringify([record]),
        };
      }
      if (input.args.includes("sandbox") && input.args.includes("explain") && profileRoot) {
        const payload = realSandboxExplain();
        const canonicalWorkspace = path.join(
          profileRoot,
          "state",
          "sandboxes",
          "agent-main-run-canonicalized-probe-session",
        );
        payload.sessionKey = `agent:main:${sessionKey}`;
        payload.sandbox.effectiveHostWorkspaceRoot = canonicalWorkspace;
        payload.sandbox.workspaceMounts[0].hostRoot = canonicalWorkspace;
        payload.sandbox.workspaceMounts[1].hostRoot = path.join(profileRoot, "workspace");
        return { ...result, stdout: JSON.stringify(payload) };
      }
      return result;
    },
  });

  try {
    profileRoot = (await manager.start()).profileRoot;
    const evidence = await manager.attestSession(sessionKey, "after");
    assert.equal(evidence.status, "attested");
    assert.equal(evidence.containerId, "agent-probe");
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
    conflictingPluginIds: [] as string[],
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
