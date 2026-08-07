import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { DetectionSandboxManager } from "../modules/openclaw/detectionSandboxManager";
import type { DetectionProfileSeed } from "../modules/openclaw/detectionProfileSeed";
import {
  DetectionRunConflictError,
  classifyDetectionError,
  createInitialE2ERunGroup,
  finalizeDetectionRunReservation,
  releaseDetectionRunReservation,
  reserveDetectionRun,
  resolveNativeGuardSessionKeys,
  runDetectionWithSandboxLifetime,
  type DetectionRunReservation,
  runE2E,
} from "./e2eRunService";

const OPENCLAW_REQUEST = {
  adapterKind: "openclaw",
  agent: { name: "Native guard test" },
  generateDefenseReport: false,
} as const;

test("a conflicting detection run cannot release the active owner's reservation", () => {
  const owner = reserveDetectionRun();
  let contender: DetectionRunReservation | undefined;

  try {
    assert.throws(
      () => {
        contender = reserveDetectionRun();
      },
      DetectionRunConflictError,
    );

    assert.equal(releaseDetectionRunReservation(contender), false);
    assert.throws(() => reserveDetectionRun(), DetectionRunConflictError);
  } finally {
    assert.equal(releaseDetectionRunReservation(owner), true);
  }

  const nextOwner = reserveDetectionRun();
  assert.equal(releaseDetectionRunReservation(nextOwner), true);
});

test("a detection reservation remains active until sandbox cleanup finishes", async () => {
  const owner = reserveDetectionRun();

  await finalizeDetectionRunReservation(owner, async () => {
    assert.throws(() => reserveDetectionRun(), DetectionRunConflictError);
  });

  const nextOwner = reserveDetectionRun();
  assert.equal(releaseDetectionRunReservation(nextOwner), true);
});

test("native guard evidence failures are fatal and use a stable category", () => {
  assert.deepEqual(
    classifyDetectionError(
      "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: event store unavailable",
      OPENCLAW_REQUEST,
    ),
    {
      category: "native_guard_evidence_unavailable",
      retryable: false,
      skipAllowed: false,
    },
  );
});

test("native guard revoke failures are fatal and use a stable category", () => {
  assert.deepEqual(
    classifyDetectionError(
      "NATIVE_GUARD_REVOKE_FAILED: plugin did not acknowledge revoke",
      OPENCLAW_REQUEST,
    ),
    {
      category: "native_guard_revoke_failed",
      retryable: false,
      skipAllowed: false,
    },
  );
});

test("OpenClaw detection batch is wrapped by the sandbox lifetime and uses its signal", async () => {
  const controller = new AbortController();
  let wrapped = false;
  let observedSignal: AbortSignal | undefined;
  const sandbox = {
    signal: controller.signal,
    async runWhileGatewayAlive<T>(operation: (signal: AbortSignal) => Promise<T>) {
      wrapped = true;
      return operation(controller.signal);
    },
  };

  const value = await runDetectionWithSandboxLifetime(
    sandbox,
    async (signal) => {
      observedSignal = signal;
      return "completed";
    },
  );

  assert.equal(value, "completed");
  assert.equal(wrapped, true);
  assert.equal(observedSignal, controller.signal);
});

test("E2E native guard boundaries use canonical session keys without changing stored test run ids", () => {
  const runGroup = {
    testRunIds: ["run.one", "agent:main:run.two"],
    runGroupId: "run_group.fallback",
  };
  assert.deepEqual(resolveNativeGuardSessionKeys(runGroup), [
    "agent:main:run.one",
    "agent:main:run.two",
  ]);
  assert.deepEqual(runGroup.testRunIds, ["run.one", "agent:main:run.two"]);
  assert.deepEqual(resolveNativeGuardSessionKeys({
    testRunIds: [],
    runGroupId: "run_group.fallback",
  }), ["agent:main:run_group.fallback"]);
});

test("formal OpenClaw runE2E resolves a scrubbed host profile seed for the sandbox manager", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-e2e-seed-"));
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const agentStateDir = path.join(stateDir, "agents", "main", "agent");
  await fs.mkdir(agentStateDir, { recursive: true });
  await fs.writeFile(`${configPath}.last-good`, JSON.stringify({
    agents: {
      defaults: {
        model: { primary: "deepseek/deepseek-v4-flash" },
        models: { "deepseek/deepseek-v4-flash": { alias: "DeepSeek" } },
      },
    },
    models: {
      providers: {
        deepseek: {
          models: [{ id: "deepseek-v4-flash" }],
        },
      },
    },
    tools: { elevated: { enabled: true } },
    plugins: { entries: { arbitrary: { enabled: true } } },
  }));

  const previousImage = process.env.AGENT_GUARD_DETECTION_IMAGE;
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.AGENT_GUARD_DETECTION_IMAGE = `openclaw@sha256:${"a".repeat(64)}`;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(async () => {
    restoreEnv("AGENT_GUARD_DETECTION_IMAGE", previousImage);
    restoreEnv("OPENCLAW_CONFIG_PATH", previousConfigPath);
    restoreEnv("OPENCLAW_STATE_DIR", previousStateDir);
    await fs.rm(root, { recursive: true, force: true });
  });

  const request = {
    ...OPENCLAW_REQUEST,
    caseIds: ["case.resource_injection"],
  };
  const runGroup = createInitialE2ERunGroup(request);
  let receivedOptions: Record<string, unknown> | undefined;
  const stopped = new Error("stop after sandbox manager construction");

  await assert.rejects(
    runE2E(request, runGroup, undefined, undefined, {
      createDetectionSandboxManager(options: Record<string, unknown>) {
        receivedOptions = options;
        return {
          signal: new AbortController().signal,
          async preflight() { throw stopped; },
          async cleanup() {},
        } as unknown as DetectionSandboxManager;
      },
    }),
    stopped,
  );

  assert.ok(receivedOptions);
  const receivedSeed = receivedOptions.profileSeed as DetectionProfileSeed;
  assert.deepEqual(receivedSeed.userConfig, {
    model: { primary: "deepseek/deepseek-v4-flash" },
  });
  assert.equal(receivedSeed.agentStateDir, agentStateDir);
  const [stateRootStat, agentStateStat] = await Promise.all([
    fs.lstat(stateDir),
    fs.lstat(agentStateDir),
  ]);
  assert.deepEqual(receivedSeed.stateRootIdentity, {
    resolvedPath: path.resolve(stateDir),
    canonicalPath: await fs.realpath(stateDir),
    dev: stateRootStat.dev,
    ino: stateRootStat.ino,
    birthtimeMs: stateRootStat.birthtimeMs,
  });
  assert.deepEqual(receivedSeed.agentStateIdentity, {
    resolvedPath: path.resolve(agentStateDir),
    canonicalPath: await fs.realpath(agentStateDir),
    dev: agentStateStat.dev,
    ino: agentStateStat.ino,
    birthtimeMs: agentStateStat.birthtimeMs,
  });
  assert.deepEqual(runGroup.testRunIds, []);
});

test("formal OpenClaw runE2E preserves invalid profile seed classification before manager construction", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-guard-e2e-invalid-seed-"));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true });
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.writeFile(`${configPath}.last-good`, "{not-json5", "utf8");
  const previousImage = process.env.AGENT_GUARD_DETECTION_IMAGE;
  const previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.AGENT_GUARD_DETECTION_IMAGE = `openclaw@sha256:${"a".repeat(64)}`;
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  t.after(async () => {
    restoreEnv("AGENT_GUARD_DETECTION_IMAGE", previousImage);
    restoreEnv("OPENCLAW_CONFIG_PATH", previousConfigPath);
    restoreEnv("OPENCLAW_STATE_DIR", previousStateDir);
    await fs.rm(root, { recursive: true, force: true });
  });

  const request = {
    ...OPENCLAW_REQUEST,
    caseIds: ["case.resource_injection"],
  };
  const runGroup = createInitialE2ERunGroup(request);
  let managerConstructions = 0;

  await assert.rejects(
    runE2E(request, runGroup, undefined, undefined, {
      createDetectionSandboxManager() {
        managerConstructions += 1;
        throw new Error("manager must not be constructed");
      },
    }),
    /not valid JSON5/i,
  );

  assert.equal(managerConstructions, 0);
  assert.deepEqual(runGroup.testRunIds, []);
  assert.equal(runGroup.progress?.caseFailures?.[0]?.caseId, "sandbox_preflight");
  assert.equal(runGroup.progress?.caseFailures?.[0]?.category, "sandbox_profile_seed_failed");
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
