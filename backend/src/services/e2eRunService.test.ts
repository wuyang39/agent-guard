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
import * as e2eRunServiceModule from "./e2eRunService";
import type {
  NativeGuardSessionCoverageSummary,
  P2RunGroup,
} from "../api/types";
import type { TestRunResult } from "../modules/runner/runTypes";

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

type RuntimeEvidenceInput = {
  sessionKey?: string;
  leaseId?: string;
  leaseEpoch?: number;
  events: Array<{
    schemaVersion: "native-guard-1";
    eventId: string;
    type: "decision";
    leaseId: string;
    leaseEpoch: number;
    sessionKey: string;
    timestamp: string;
    detail: Record<string, unknown>;
  }>;
  reconciliation: {
    reconciled: boolean;
    coverageBreachCount: number;
    mismatchCount: number;
  };
  revokeError?: string;
  evidenceError?: string;
};

function guardedRunGroup(): P2RunGroup {
  const runGroup = createInitialE2ERunGroup({
    ...OPENCLAW_REQUEST,
    caseIds: ["case.resource_injection"],
  });
  runGroup.nativeGuardCoverage = {
    coverage: "conditional",
    eventsTotal: 0,
    reconciled: false,
    coverageBreachCount: 0,
    mismatchCount: 0,
    sessions: [],
    runtimeFailures: [],
  } as never;
  return runGroup;
}

function decisionEvent(input: {
  eventId: string;
  sessionKey: string;
  leaseId: string;
  leaseEpoch: number;
}): RuntimeEvidenceInput["events"][number] {
  return {
    schemaVersion: "native-guard-1",
    eventId: input.eventId,
    type: "decision",
    leaseId: input.leaseId,
    leaseEpoch: input.leaseEpoch,
    sessionKey: input.sessionKey,
    timestamp: "2026-08-07T00:00:00.000Z",
    detail: {},
  };
}

function recordCoverage(
  runGroup: P2RunGroup,
  evidence: RuntimeEvidenceInput,
  testRunId = "run.coverage.test",
): string | undefined {
  const candidate = (e2eRunServiceModule as unknown as {
    recordNativeGuardSessionCoverage?: (
      target: P2RunGroup,
      runtime: RuntimeEvidenceInput,
      testRunId: string,
    ) => string | undefined;
  }).recordNativeGuardSessionCoverage;
  assert.equal(typeof candidate, "function");
  return candidate!(runGroup, evidence, testRunId);
}

// @ts-expect-error authoritative session summaries require the complete identity.
const invalidAnonymousSessionSummary: NativeGuardSessionCoverageSummary = {
  eventsTotal: 0,
  reconciled: false,
  coverageBreachCount: 0,
  mismatchCount: 1,
};
void invalidAnonymousSessionSummary;

function resolveAttemptFailure(
  testRun: { status: "completed" | "failed"; error?: string },
  coverageFailure?: string,
): string | undefined {
  const candidate = (e2eRunServiceModule as unknown as {
    resolveDetectionAttemptFailure?: (
      run: { status: "completed" | "failed"; error?: string },
      guardFailure?: string,
    ) => string | undefined;
  }).resolveDetectionAttemptFailure;
  assert.equal(typeof candidate, "function");
  return candidate!(testRun, coverageFailure);
}

async function persistAttemptEvidence(input: {
  runGroup: P2RunGroup;
  result: Pick<TestRunResult, "testRun" | "trace" | "nativeGuardRuntime">;
  signal: AbortSignal;
  traceWriter: (trace: unknown) => Promise<void>;
}): Promise<string | undefined> {
  const candidate = (e2eRunServiceModule as unknown as {
    persistDetectionAttemptEvidence?: (options: typeof input) => Promise<string | undefined>;
  }).persistDetectionAttemptEvidence;
  assert.equal(typeof candidate, "function");
  return candidate!(input);
}

function completedAttemptResult(input: {
  runId: string;
  traceId: string;
  sessionKey: string;
  leaseId: string;
  leaseEpoch: number;
}): Pick<TestRunResult, "testRun" | "trace" | "nativeGuardRuntime"> {
  return {
    testRun: {
      runId: input.runId,
      status: "completed",
    } as TestRunResult["testRun"],
    trace: {
      traceId: input.traceId,
    } as TestRunResult["trace"],
    nativeGuardRuntime: {
      sessionKey: input.sessionKey,
      leaseId: input.leaseId,
      leaseEpoch: input.leaseEpoch,
      events: [decisionEvent({
        eventId: `event.${input.runId}`,
        sessionKey: input.sessionKey,
        leaseId: input.leaseId,
        leaseEpoch: input.leaseEpoch,
      })],
      reconciliation: {
        reconciled: true,
        coverageBreachCount: 0,
        mismatchCount: 0,
      },
    },
  };
}

test("single guarded session persists authoritative lease and reconciliation coverage", () => {
  const runGroup = guardedRunGroup();
  const sessionKey = "agent:main:run.coverage.single";
  const event = decisionEvent({
    eventId: "event.coverage.single",
    sessionKey,
    leaseId: "lease.single",
    leaseEpoch: 4,
  });

  assert.equal(recordCoverage(runGroup, {
    sessionKey,
    leaseId: "lease.single",
    leaseEpoch: 4,
    events: [event],
    reconciliation: {
      reconciled: true,
      coverageBreachCount: 0,
      mismatchCount: 0,
    },
  }), undefined);

  assert.deepEqual(runGroup.nativeGuardCoverage, {
    coverage: "conditional",
    eventsTotal: 1,
    reconciled: true,
    coverageBreachCount: 0,
    mismatchCount: 0,
    runtimeFailures: [],
    leaseId: "lease.single",
    leaseEpoch: 4,
    sessions: [{
      sessionKey,
      leaseId: "lease.single",
      leaseEpoch: 4,
      eventsTotal: 1,
      reconciled: true,
      coverageBreachCount: 0,
      mismatchCount: 0,
    }],
  });
});

test("cancellation after a completed agent run retains testRun and native guard summary", async () => {
  const runGroup = guardedRunGroup();
  const controller = new AbortController();
  controller.abort();
  let traceWrites = 0;
  const result = completedAttemptResult({
    runId: "run.coverage.cancelled-after-drain",
    traceId: "trace.coverage.cancelled-after-drain",
    sessionKey: "agent:main:run.coverage.cancelled-after-drain",
    leaseId: "lease.cancelled-after-drain",
    leaseEpoch: 2,
  });

  await assert.rejects(
    persistAttemptEvidence({
      runGroup,
      result,
      signal: controller.signal,
      async traceWriter() { traceWrites += 1; },
    }),
    /cancelled/i,
  );

  assert.deepEqual(runGroup.testRunIds, [result.testRun.runId]);
  assert.deepEqual(runGroup.traceIds, []);
  assert.equal(traceWrites, 0);
  assert.equal(runGroup.nativeGuardCoverage?.sessions[0]?.sessionKey, result.nativeGuardRuntime?.sessionKey);
  assert.equal(runGroup.nativeGuardCoverage?.sessions[0]?.eventsTotal, 1);
});

test("trace write failure retains evidence and a retry does not duplicate associations", async () => {
  const runGroup = guardedRunGroup();
  const result = completedAttemptResult({
    runId: "run.coverage.trace-write-failure",
    traceId: "trace.coverage.trace-write-failure",
    sessionKey: "agent:main:run.coverage.trace-write-failure",
    leaseId: "lease.trace-write-failure",
    leaseEpoch: 4,
  });
  let shouldFail = true;
  const traceWriter = async () => {
    if (shouldFail) throw new Error("trace disk unavailable");
  };

  await assert.rejects(
    persistAttemptEvidence({
      runGroup,
      result,
      signal: new AbortController().signal,
      traceWriter,
    }),
    /trace disk unavailable/,
  );
  assert.deepEqual(runGroup.testRunIds, [result.testRun.runId]);
  assert.deepEqual(runGroup.traceIds, []);
  assert.equal(runGroup.nativeGuardCoverage?.sessions[0]?.eventsTotal, 1);

  shouldFail = false;
  await persistAttemptEvidence({
    runGroup,
    result,
    signal: new AbortController().signal,
    traceWriter,
  });
  assert.deepEqual(runGroup.testRunIds, [result.testRun.runId]);
  assert.deepEqual(runGroup.traceIds, [result.trace.traceId]);
  assert.equal(runGroup.nativeGuardCoverage?.sessions[0]?.eventsTotal, 1);
});

test("multiple guarded sessions keep distinct leases and first-session top-level compatibility", () => {
  const runGroup = guardedRunGroup();
  for (const [index, leaseEpoch] of [2, 7].entries()) {
    const sessionKey = `agent:main:run.coverage.${String(index + 1)}`;
    const leaseId = `lease.${String(index + 1)}`;
    recordCoverage(runGroup, {
      sessionKey,
      leaseId,
      leaseEpoch,
      events: [decisionEvent({
        eventId: `event.coverage.${String(index + 1)}`,
        sessionKey,
        leaseId,
        leaseEpoch,
      })],
      reconciliation: {
        reconciled: true,
        coverageBreachCount: 0,
        mismatchCount: index,
      },
    });
  }

  assert.equal(runGroup.nativeGuardCoverage?.eventsTotal, 2);
  assert.equal(runGroup.nativeGuardCoverage?.mismatchCount, 1);
  assert.equal(runGroup.nativeGuardCoverage?.leaseId, "lease.1");
  assert.equal(runGroup.nativeGuardCoverage?.leaseEpoch, 2);
  assert.deepEqual(
    runGroup.nativeGuardCoverage?.sessions.map((session) => ({
      sessionKey: session.sessionKey,
      leaseId: session.leaseId,
      leaseEpoch: session.leaseEpoch,
    })),
    [
      { sessionKey: "agent:main:run.coverage.1", leaseId: "lease.1", leaseEpoch: 2 },
      { sessionKey: "agent:main:run.coverage.2", leaseId: "lease.2", leaseEpoch: 7 },
    ],
  );
});

test("a second lease for the same session preserves first identity and accumulates both summaries", () => {
  const runGroup = guardedRunGroup();
  const sessionKey = "agent:main:run.coverage.reused";
  recordCoverage(runGroup, {
    sessionKey,
    leaseId: "lease.first",
    leaseEpoch: 2,
    events: [1, 2].map((index) => decisionEvent({
      eventId: `event.coverage.first.${String(index)}`,
      sessionKey,
      leaseId: "lease.first",
      leaseEpoch: 2,
    })),
    reconciliation: {
      reconciled: true,
      coverageBreachCount: 1,
      mismatchCount: 1,
    },
  });

  const failure = recordCoverage(runGroup, {
    sessionKey,
    leaseId: "lease.second",
    leaseEpoch: 8,
    events: [1, 2, 3].map((index) => decisionEvent({
      eventId: `event.coverage.second.${String(index)}`,
      sessionKey,
      leaseId: "lease.second",
      leaseEpoch: 8,
    })),
    reconciliation: {
      reconciled: true,
      coverageBreachCount: 2,
      mismatchCount: 2,
    },
  });

  assert.match(failure ?? "", /^NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/);
  assert.deepEqual(runGroup.nativeGuardCoverage, {
    coverage: "conditional",
    eventsTotal: 5,
    reconciled: false,
    coverageBreachCount: 3,
    mismatchCount: 4,
    runtimeFailures: [],
    leaseId: "lease.first",
    leaseEpoch: 2,
    sessions: [{
      sessionKey,
      leaseId: "lease.first",
      leaseEpoch: 2,
      eventsTotal: 5,
      reconciled: false,
      coverageBreachCount: 3,
      mismatchCount: 4,
      evidenceError: "Native guard runtime lease identity conflict for session.",
      leaseIdentityConflict: {
        expected: { sessionKey, leaseId: "lease.first", leaseEpoch: 2 },
        observed: [{ sessionKey, leaseId: "lease.second", leaseEpoch: 8 }],
      },
    }],
  });
});

test("conflicting lease identities inside one session fail closed without selecting event identity", () => {
  const runGroup = guardedRunGroup();
  const sessionKey = "agent:main:run.coverage.conflict";
  const failure = recordCoverage(runGroup, {
    sessionKey,
    leaseId: "lease.activated",
    leaseEpoch: 5,
    events: [
      decisionEvent({
        eventId: "event.coverage.expected",
        sessionKey,
        leaseId: "lease.activated",
        leaseEpoch: 5,
      }),
      decisionEvent({
        eventId: "event.coverage.conflict",
        sessionKey,
        leaseId: "lease.conflict",
        leaseEpoch: 9,
      }),
    ],
    reconciliation: {
      reconciled: true,
      coverageBreachCount: 0,
      mismatchCount: 0,
    },
  });

  assert.match(failure ?? "", /^NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/);
  assert.equal(runGroup.nativeGuardCoverage?.reconciled, false);
  assert.equal(runGroup.nativeGuardCoverage?.mismatchCount, 1);
  assert.deepEqual(runGroup.nativeGuardCoverage?.sessions[0] && {
    leaseId: runGroup.nativeGuardCoverage.sessions[0].leaseId,
    leaseEpoch: runGroup.nativeGuardCoverage.sessions[0].leaseEpoch,
  }, { leaseId: "lease.activated", leaseEpoch: 5 });
  assert.match(runGroup.nativeGuardCoverage?.sessions[0]?.evidenceError ?? "", /identity conflict/i);
});

test("native guard evidence failure takes precedence over a retryable agent error", () => {
  assert.equal(
    resolveAttemptFailure(
      { status: "failed", error: "429 Too many requests" },
      "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: lease identity conflict",
    ),
    "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: lease identity conflict",
  );
});

test("revoke failures are scrubbed into the failed session coverage summary", () => {
  const runGroup = guardedRunGroup();
  const sessionKey = "agent:main:run.coverage.revoke";
  const failure = recordCoverage(runGroup, {
    sessionKey,
    leaseId: "lease.revoke",
    leaseEpoch: 1,
    events: [],
    reconciliation: {
      reconciled: true,
      coverageBreachCount: 0,
      mismatchCount: 0,
    },
    revokeError: "gatewayToken=super-secret plugin did not acknowledge revoke",
  });

  assert.match(failure ?? "", /^NATIVE_GUARD_REVOKE_FAILED:/);
  assert.equal(runGroup.nativeGuardCoverage?.reconciled, false);
  assert.match(
    runGroup.nativeGuardCoverage?.sessions[0]?.revokeError ?? "",
    /gatewayToken=\[REDACTED\]/,
  );
  assert.doesNotMatch(
    runGroup.nativeGuardCoverage?.sessions[0]?.revokeError ?? "",
    /super-secret/,
  );
});

test("evidence failures are scrubbed into the failed session coverage summary", () => {
  const runGroup = guardedRunGroup();
  const failure = recordCoverage(runGroup, {
    sessionKey: "agent:main:run.coverage.evidence",
    leaseId: "lease.evidence",
    leaseEpoch: 2,
    events: [],
    reconciliation: {
      reconciled: false,
      coverageBreachCount: 0,
      mismatchCount: 0,
    },
    evidenceError: "OPENCLAW_GATEWAY_TOKEN=super-secret event store unavailable",
  });

  assert.match(failure ?? "", /^NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/);
  assert.match(
    runGroup.nativeGuardCoverage?.sessions[0]?.evidenceError ?? "",
    /OPENCLAW_GATEWAY_TOKEN=\[REDACTED\]/,
  );
  assert.doesNotMatch(
    runGroup.nativeGuardCoverage?.sessions[0]?.evidenceError ?? "",
    /super-secret/,
  );
});

test("missing lease identity persists original scrubbed evidence and revoke diagnostics", () => {
  const runGroup = guardedRunGroup();
  const failure = recordCoverage(runGroup, {
    sessionKey: "agent:main:run.coverage.identity-missing",
    events: [],
    reconciliation: {
      reconciled: true,
      coverageBreachCount: 0,
      mismatchCount: 0,
    },
    evidenceError: "OPENCLAW_GATEWAY_TOKEN=super-secret event store unavailable",
    revokeError: "gatewayToken=another-secret revoke failed",
  }, "run.coverage.identity-missing");

  assert.match(failure ?? "", /^NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/);
  assert.deepEqual(runGroup.nativeGuardCoverage, {
    coverage: "conditional",
    eventsTotal: 0,
    reconciled: false,
    coverageBreachCount: 0,
    mismatchCount: 1,
    leaseId: undefined,
    leaseEpoch: undefined,
    sessions: [],
    runtimeFailures: [{
      testRunId: "run.coverage.identity-missing",
      sessionKey: "agent:main:run.coverage.identity-missing",
      kind: "identity_missing",
      eventsTotal: 0,
      reconciled: false,
      coverageBreachCount: 0,
      mismatchCount: 1,
      identityMissing: true,
      evidenceError: "OPENCLAW_GATEWAY_TOKEN=[REDACTED] event store unavailable; Native guard session lease identity is missing.",
      revokeError: "gatewayToken=[REDACTED] revoke failed",
    }],
  });
});

test("Guard OFF does not create a coverage or session summary", () => {
  const runGroup = createInitialE2ERunGroup({
    adapterKind: "mock",
    agent: { name: "Guard off" },
    generateDefenseReport: false,
  });

  assert.equal(recordCoverage(runGroup, {
    sessionKey: "run.guard-off",
    leaseId: "lease.unexpected",
    leaseEpoch: 1,
    events: [],
    reconciliation: {
      reconciled: true,
      coverageBreachCount: 0,
      mismatchCount: 0,
    },
  }), undefined);
  assert.equal(runGroup.nativeGuardCoverage, undefined);
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
    fs.lstat(stateDir, { bigint: true }),
    fs.lstat(agentStateDir, { bigint: true }),
  ]);
  assert.deepEqual(receivedSeed.stateRootIdentity, {
    resolvedPath: path.resolve(stateDir),
    canonicalPath: await fs.realpath(stateDir),
    dev: stateRootStat.dev,
    ino: stateRootStat.ino,
    birthtimeNs: stateRootStat.birthtimeNs,
  });
  assert.deepEqual(receivedSeed.agentStateIdentity, {
    resolvedPath: path.resolve(agentStateDir),
    canonicalPath: await fs.realpath(agentStateDir),
    dev: agentStateStat.dev,
    ino: agentStateStat.ino,
    birthtimeNs: agentStateStat.birthtimeNs,
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
