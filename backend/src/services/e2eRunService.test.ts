import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type {
  DetectionSandboxEvidence,
  DetectionSandboxManager,
} from "../modules/openclaw/detectionSandboxManager";
import type { DetectionProfileSeed } from "../modules/openclaw/detectionProfileSeed";
import { loadTestContexts } from "../modules/config/loadTestContext";
import type { AgentAdapter } from "../modules/agent/agentAdapter";
import {
  DetectionRunConflictError,
  classifyDetectionError,
  createInitialE2ERunGroup,
  finalizeGuardedDetectionSession,
  finalizeDetectionRunReservation,
  releaseDetectionRunReservation,
  reserveDetectionRun,
  runDetectionCasesConcurrently,
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
import type { AgentAdapterConfig, AgentUnderTest } from "@agent-guard/contracts";

const OPENCLAW_REQUEST = {
  adapterKind: "openclaw",
  agent: { name: "Native guard test" },
  generateDefenseReport: false,
} as const;

test("OpenClaw competition detection uses bounded default attempt budgets", (t) => {
  const previousAttempts = process.env.AGENT_GUARD_OPENCLAW_CASE_MAX_ATTEMPTS;
  const previousRetryBase = process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS;
  delete process.env.AGENT_GUARD_OPENCLAW_CASE_MAX_ATTEMPTS;
  delete process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS;
  t.after(() => {
    if (previousAttempts === undefined) delete process.env.AGENT_GUARD_OPENCLAW_CASE_MAX_ATTEMPTS;
    else process.env.AGENT_GUARD_OPENCLAW_CASE_MAX_ATTEMPTS = previousAttempts;
    if (previousRetryBase === undefined) delete process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS;
    else process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS = previousRetryBase;
  });
  const performance = e2eRunServiceModule as unknown as {
    getOpenClawDetectionTimeoutMs?: (request: typeof OPENCLAW_REQUEST & {
      connection?: { timeoutMs?: number };
    }) => number;
    getDetectionMaxAttempts?: (request: typeof OPENCLAW_REQUEST) => number;
    getDetectionRetryDelayMs?: (attempt: number) => number;
  };

  assert.equal(performance.getOpenClawDetectionTimeoutMs?.(OPENCLAW_REQUEST), 90_000);
  assert.equal(performance.getOpenClawDetectionTimeoutMs?.({
    ...OPENCLAW_REQUEST,
    connection: { timeoutMs: 45_000 },
  }), 45_000);
  assert.equal(performance.getDetectionMaxAttempts?.(OPENCLAW_REQUEST), 2);
  assert.equal(performance.getDetectionRetryDelayMs?.(1), 3_000);
  assert.equal(performance.getDetectionRetryDelayMs?.(2), 6_000);
});

test("OpenClaw execution stably defers encoded and obfuscated cases", () => {
  const orderCases = (e2eRunServiceModule as unknown as {
    orderDetectionCasesForExecution?: <T>(cases: T[]) => T[];
  }).orderDetectionCasesForExecution;
  assert.equal(typeof orderCases, "function");
  const cases = [
    detectionOrderCase("case.normal.first", "manual.frame.safe_fixture"),
    detectionOrderCase("case.encoded.base32", "pyrit.converter.base32"),
    detectionOrderCase("case.normal.second", "pyrit.executor.role_play"),
    detectionOrderCase("case.obfuscated.math", "pyrit.converter.math_obfuscation"),
    detectionOrderCase("case.encoded.smuggling", "aig.encoding.ascii_smuggling"),
  ];

  const ordered = orderCases!(cases);
  assert.deepEqual(ordered.map((item) => item.caseId), [
    "case.normal.first",
    "case.normal.second",
    "case.encoded.base32",
    "case.obfuscated.math",
    "case.encoded.smuggling",
  ]);
  assert.deepEqual(cases.map((item) => item.caseId), [
    "case.normal.first",
    "case.encoded.base32",
    "case.normal.second",
    "case.obfuscated.math",
    "case.encoded.smuggling",
  ]);
});

function detectionOrderCase(caseId: string, operatorId: string) {
  return {
    caseId,
    caseName: caseId,
    testCase: {
      caseId,
      caseName: caseId,
      description: caseId,
      task: { metadata: { operatorId } },
    },
  };
}

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

async function retryAfterTraceWriteFailure(input: {
  runGroup: P2RunGroup;
  result: Pick<TestRunResult, "testRun" | "trace" | "nativeGuardRuntime">;
}): Promise<string | undefined> {
  let shouldFail = true;
  const traceWriter = async () => {
    if (shouldFail) throw new Error("trace disk unavailable");
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    persistAttemptEvidence({
      ...input,
      signal,
      traceWriter,
    }),
    /trace disk unavailable/,
  );
  shouldFail = false;
  return persistAttemptEvidence({
    ...input,
    signal,
    traceWriter,
  });
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

function cleanedSandboxEvidence(sessionKey: string): DetectionSandboxEvidence {
  return {
    runGroupId: "run_group.finalizer",
    image: `openclaw@sha256:${"a".repeat(64)}`,
    imageId: "sha256:finalized",
    openclawVersion: "2026.8.0",
    profileRoot: "C:\\sandbox\\profile",
    configPath: "C:\\sandbox\\profile\\openclaw.json",
    configDigest: `sha256:${sessionKey}`,
    networkMode: "none",
    containerId: "a".repeat(64),
    status: "cleaned",
  };
}

async function guardedDetectionFixture() {
  const agent = {
    schemaVersion: "mvp-1",
    agentId: "agent.finalizer",
    name: "Finalizer fixture",
    adapterType: "openclaw" as AgentUnderTest["adapterType"],
  } satisfies AgentUnderTest;
  const adapterConfig = {
    schemaVersion: "mvp-1",
    adapterId: "adapter.finalizer",
    agentId: agent.agentId,
    adapterType: agent.adapterType,
    timeoutMs: 1_000,
  } satisfies AgentAdapterConfig;
  const { contexts } = await loadTestContexts(path.resolve("configs"), agent);
  const context = contexts.find((item) => item.caseId === "case.resource_injection");
  assert.ok(context);
  return { agent, adapterConfig, context };
}

function guardedAttemptAdapter(input: {
  results: Array<{ status: "completed" | "failed"; error?: string }>;
  onDrain?: (input: { attempt: number; runId: string; sessionKey: string }) => void;
}): AgentAdapter {
  let sessionIndex = 0;
  return {
    adapterType: "openclaw" as AgentAdapter["adapterType"],
    async createSession(agent, config) {
      const attempt = sessionIndex++;
      let runId = "";
      return {
        agent,
        config,
        async sendTask(_task, _bridge, runMeta) {
          assert.ok(runMeta);
          runId = runMeta.runId;
          const configured = input.results[attempt] ?? input.results.at(-1)!;
          return {
            schemaVersion: "mvp-1",
            runId,
            agentId: agent.agentId,
            caseId: runMeta.caseId,
            status: configured.status,
            finalMessage: configured.status === "completed" ? "completed" : undefined,
            error: configured.error,
            startedAt: "2026-08-09T00:00:00.000Z",
            endedAt: "2026-08-09T00:00:01.000Z",
          };
        },
        async drainRuntimeEvidence() {
          assert.ok(runId);
          const sessionKey = `agent:main:${runId}`;
          input.onDrain?.({ attempt, runId, sessionKey });
          return {
            sessionKey,
            leaseId: `lease.finalizer.${String(attempt + 1)}`,
            leaseEpoch: attempt + 1,
            nativeGuardEvents: [],
            supervisionRecords: [],
            reconciliation: {
              reconciled: true,
              coverageBreachCount: 0,
              mismatchCount: 0,
            },
          };
        },
      };
    },
  };
}

test("guarded case finalization updates sandbox evidence before accepting risk", async () => {
  const { agent, adapterConfig, context } = await guardedDetectionFixture();
  const runGroup = guardedRunGroup();
  const order: string[] = [];
  const finalized: Array<{ caseId: string; runId: string; sessionKey: string }> = [];

  const result = await runDetectionCasesConcurrently({
    targetCases: [context],
    agent,
    adapterConfig,
    customAdapter: guardedAttemptAdapter({
      results: [{ status: "completed" }],
      onDrain() { order.push("evidence_drained"); },
    }),
    runGroup,
    request: { ...OPENCLAW_REQUEST, caseIds: [context.caseId] },
    signal: new AbortController().signal,
    async guardedSessionFinalizer(input) {
      order.push("finalized");
      finalized.push(input);
      assert.deepEqual(runGroup.testRunIds, [input.runId]);
      assert.equal(runGroup.traceIds.length, 1);
      assert.deepEqual(runGroup.riskReportIds, []);
      assert.equal(runGroup.progress?.completedCases, 0);
      return cleanedSandboxEvidence(input.sessionKey);
    },
  });
  order.push("risk_accepted");

  assert.deepEqual(order, ["evidence_drained", "finalized", "risk_accepted"]);
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0]?.caseId, context.caseId);
  assert.equal(finalized[0]?.sessionKey, `agent:main:${finalized[0]?.runId}`);
  assert.equal(result.completedCases, 1);
  assert.equal(result.riskReports.length, 1);
  assert.equal(runGroup.riskReportIds.length, 1);
  assert.deepEqual(runGroup.sandboxEvidence && {
    preflightPassed: runGroup.sandboxEvidence.preflightPassed,
    attested: runGroup.sandboxEvidence.attested,
    containerId: runGroup.sandboxEvidence.containerId,
  }, {
    preflightPassed: true,
    attested: true,
    containerId: "a".repeat(64),
  });
});

test("guarded finalizer failure is fatal without retry, risk report, or success count", async (t) => {
  const previousRetryBase = process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS;
  process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS = "0";
  t.after(() => restoreEnv("AGENT_GUARD_OPENCLAW_RETRY_BASE_MS", previousRetryBase));
  const { agent, adapterConfig, context } = await guardedDetectionFixture();
  const runGroup = guardedRunGroup();
  let drainedAttempts = 0;
  let finalizerCalls = 0;

  await assert.rejects(
    runDetectionCasesConcurrently({
      targetCases: [context],
      agent,
      adapterConfig,
      customAdapter: guardedAttemptAdapter({
        results: [{ status: "completed" }],
        onDrain() { drainedAttempts += 1; },
      }),
      runGroup,
      request: { ...OPENCLAW_REQUEST, caseIds: [context.caseId] },
      signal: new AbortController().signal,
      async guardedSessionFinalizer() {
        finalizerCalls += 1;
        throw new Error("sandbox cleanup timed out");
      },
    }),
    /Detection pass failed.*NATIVE_GUARD_EVIDENCE_UNAVAILABLE.*sandbox cleanup timed out/,
  );

  assert.equal(drainedAttempts, 1);
  assert.equal(finalizerCalls, 1);
  assert.equal(runGroup.testRunIds.length, 1);
  assert.equal(runGroup.traceIds.length, 1);
  assert.deepEqual(runGroup.riskReportIds, []);
  assert.equal(runGroup.progress?.completedCases, 0);
  assert.equal(runGroup.progress?.failedCases, 1);
  assert.deepEqual(runGroup.progress?.caseFailures?.map((failure) => ({
    caseId: failure.caseId,
    reason: failure.reason,
    category: failure.category,
    skipped: failure.skipped,
  })), [{
    caseId: context.caseId,
    reason: "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: Guarded session finalization failed: sandbox cleanup timed out",
    category: "native_guard_evidence_unavailable",
    skipped: false,
  }]);
});

test("a successful retry finalizes its new guarded session exactly once", async (t) => {
  const previousRetryBase = process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS;
  process.env.AGENT_GUARD_OPENCLAW_RETRY_BASE_MS = "0";
  t.after(() => restoreEnv("AGENT_GUARD_OPENCLAW_RETRY_BASE_MS", previousRetryBase));
  const { agent, adapterConfig, context } = await guardedDetectionFixture();
  const runGroup = guardedRunGroup();
  const drained: string[] = [];
  const finalized: string[] = [];

  const result = await runDetectionCasesConcurrently({
    targetCases: [context],
    agent,
    adapterConfig,
    customAdapter: guardedAttemptAdapter({
      results: [
        { status: "failed", error: "429 Too many requests" },
        { status: "completed" },
      ],
      onDrain({ sessionKey }) { drained.push(sessionKey); },
    }),
    runGroup,
    request: { ...OPENCLAW_REQUEST, caseIds: [context.caseId] },
    signal: new AbortController().signal,
    async guardedSessionFinalizer(input) {
      finalized.push(input.sessionKey);
      return cleanedSandboxEvidence(input.sessionKey);
    },
  });

  assert.equal(result.completedCases, 1);
  assert.equal(result.retriedCases, 1);
  assert.equal(drained.length, 2);
  assert.notEqual(drained[0], drained[1]);
  assert.deepEqual(finalized, [drained[1]]);
  assert.equal(runGroup.testRunIds.length, 2);
  assert.equal(runGroup.traceIds.length, 2);
  assert.equal(runGroup.riskReportIds.length, 1);
});

test("guarded detection finalizes only after runtime evidence persistence", async () => {
  const runGroup = guardedRunGroup();
  const result = completedAttemptResult({
    runId: "run.finalizer.order",
    traceId: "trace.finalizer.order",
    sessionKey: "agent:main:run.finalizer.order",
    leaseId: "lease.finalizer.order",
    leaseEpoch: 3,
  });
  const order: string[] = [];
  let traceWriteAttempts = 0;
  const traceWriter = async () => {
    traceWriteAttempts += 1;
    if (traceWriteAttempts === 1) {
      throw new Error("trace disk unavailable");
    }
    order.push("persisted");
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
  await persistAttemptEvidence({
    runGroup,
    result,
    signal: new AbortController().signal,
    traceWriter,
  });

  let finalizerCalls = 0;
  const evidence = await finalizeGuardedDetectionSession({
    caseId: "case.resource_injection",
    result,
    async guardedSessionFinalizer(input) {
      finalizerCalls += 1;
      order.push("finalized");
      assert.deepEqual(input, {
        caseId: "case.resource_injection",
        runId: "run.finalizer.order",
        sessionKey: "agent:main:run.finalizer.order",
      });
      assert.deepEqual(runGroup.testRunIds, ["run.finalizer.order"]);
      assert.deepEqual(runGroup.traceIds, ["trace.finalizer.order"]);
      return cleanedSandboxEvidence(input.sessionKey);
    },
  });
  order.push("risk_accepted");

  assert.equal(evidence?.status, "cleaned");
  assert.equal(finalizerCalls, 1);
  assert.deepEqual(order, ["persisted", "finalized", "risk_accepted"]);
});

test("optional guarded finalizer leaves an unguarded attempt unchanged", async () => {
  assert.equal(
    await finalizeGuardedDetectionSession({
      caseId: "case.unguarded",
      result: {
        testRun: { runId: "run.unguarded", status: "completed" } as TestRunResult["testRun"],
      },
    }),
    undefined,
  );
});

test("classified finalizer failures preserve category without leaking secrets", async () => {
  const result = completedAttemptResult({
    runId: "run.finalizer.scrubbed-error",
    traceId: "trace.finalizer.scrubbed-error",
    sessionKey: "agent:main:run.finalizer.scrubbed-error",
    leaseId: "lease.finalizer.scrubbed-error",
    leaseEpoch: 6,
  });

  await assert.rejects(
    finalizeGuardedDetectionSession({
      caseId: "case.resource_injection",
      result,
      async guardedSessionFinalizer() {
        throw new Error(
          "NATIVE_GUARD_REVOKE_FAILED: gatewayToken=super-secret revoke unavailable",
        );
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /^NATIVE_GUARD_REVOKE_FAILED: gatewayToken=\[REDACTED\] revoke unavailable$/,
      );
      assert.doesNotMatch(error.message, /super-secret/);
      return true;
    },
  );
});

for (const invalidRuntime of [
  {
    name: "missing runtime evidence",
    patch(result: ReturnType<typeof completedAttemptResult>) {
      result.nativeGuardRuntime = undefined;
    },
    expected: /NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/,
  },
  {
    name: "missing session identity",
    patch(result: ReturnType<typeof completedAttemptResult>) {
      result.nativeGuardRuntime!.sessionKey = undefined;
    },
    expected: /NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/,
  },
  {
    name: "missing reconciliation",
    patch(result: ReturnType<typeof completedAttemptResult>) {
      result.nativeGuardRuntime!.reconciliation = undefined;
    },
    expected: /NATIVE_GUARD_COVERAGE_BREACH: 0\b/,
  },
  {
    name: "unreconciled runtime",
    patch(result: ReturnType<typeof completedAttemptResult>) {
      result.nativeGuardRuntime!.reconciliation = {
        reconciled: false,
        coverageBreachCount: 4,
        mismatchCount: 1,
      };
    },
    expected: /NATIVE_GUARD_COVERAGE_BREACH: 4\b/,
  },
  {
    name: "evidence error",
    patch(result: ReturnType<typeof completedAttemptResult>) {
      result.nativeGuardRuntime!.reconciliation!.reconciled = false;
      result.nativeGuardRuntime!.evidenceError = "event store unavailable";
    },
    expected: /NATIVE_GUARD_EVIDENCE_UNAVAILABLE: event store unavailable/,
  },
  {
    name: "revoke error",
    patch(result: ReturnType<typeof completedAttemptResult>) {
      result.nativeGuardRuntime!.reconciliation!.reconciled = false;
      result.nativeGuardRuntime!.revokeError = "lease revoke unavailable";
    },
    expected: /NATIVE_GUARD_REVOKE_FAILED: lease revoke unavailable/,
  },
] as const) {
  test(`guarded finalization fails closed for ${invalidRuntime.name}`, async () => {
    const result = completedAttemptResult({
      runId: `run.finalizer.${invalidRuntime.name.replaceAll(" ", ".")}`,
      traceId: `trace.finalizer.${invalidRuntime.name.replaceAll(" ", ".")}`,
      sessionKey: `agent:main:run.finalizer.${invalidRuntime.name.replaceAll(" ", ".")}`,
      leaseId: "lease.finalizer.invalid",
      leaseEpoch: 5,
    });
    invalidRuntime.patch(result);
    let finalizerCalls = 0;

    await assert.rejects(
      finalizeGuardedDetectionSession({
        caseId: "case.resource_injection",
        result,
        async guardedSessionFinalizer(input) {
          finalizerCalls += 1;
          return cleanedSandboxEvidence(input.sessionKey);
        },
      }),
      invalidRuntime.expected,
    );
    assert.equal(finalizerCalls, 0);
  });
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
      testRunIds: ["run.coverage.test"],
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
  const retryFailure = await retryAfterTraceWriteFailure({ runGroup, result });
  assert.equal(retryFailure, undefined);
  assert.deepEqual(runGroup.testRunIds, [result.testRun.runId]);
  assert.deepEqual(runGroup.traceIds, [result.trace.traceId]);
  assert.equal(runGroup.nativeGuardCoverage?.sessions[0]?.eventsTotal, 1);
});

test("identity-missing failure survives trace write retry", async () => {
  const runGroup = guardedRunGroup();
  const result = completedAttemptResult({
    runId: "run.coverage.retry.identity-missing",
    traceId: "trace.coverage.retry.identity-missing",
    sessionKey: "agent:main:run.coverage.retry.identity-missing",
    leaseId: "lease.identity-will-be-removed",
    leaseEpoch: 1,
  });
  result.nativeGuardRuntime = {
    sessionKey: "agent:main:run.coverage.retry.identity-missing",
    events: [],
    reconciliation: {
      reconciled: true,
      coverageBreachCount: 0,
      mismatchCount: 0,
    },
    evidenceError: "event store unavailable",
  };

  const retryFailure = await retryAfterTraceWriteFailure({ runGroup, result });
  assert.equal(
    retryFailure,
    "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: event store unavailable; Native guard session lease identity is missing.",
  );
  assert.equal(runGroup.nativeGuardCoverage?.sessions.length, 0);
  assert.equal(runGroup.nativeGuardCoverage?.runtimeFailures[0]?.testRunId, result.testRun.runId);
});

test("lease identity conflict survives trace write retry", async () => {
  const runGroup = guardedRunGroup();
  const result = completedAttemptResult({
    runId: "run.coverage.retry.lease-conflict",
    traceId: "trace.coverage.retry.lease-conflict",
    sessionKey: "agent:main:run.coverage.retry.lease-conflict",
    leaseId: "lease.expected",
    leaseEpoch: 3,
  });
  result.nativeGuardRuntime!.events[0] = {
    ...result.nativeGuardRuntime!.events[0]!,
    leaseId: "lease.observed",
    leaseEpoch: 9,
  };

  const retryFailure = await retryAfterTraceWriteFailure({ runGroup, result });
  assert.equal(
    retryFailure,
    "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: Native guard event lease identity conflict for session (1 event(s)).",
  );
  assert.deepEqual(runGroup.nativeGuardCoverage?.sessions[0]?.testRunIds, [result.testRun.runId]);
  assert.equal(runGroup.nativeGuardCoverage?.sessions[0]?.eventsTotal, 1);
});

for (const diagnostic of [
  {
    name: "evidence",
    patch: { evidenceError: "event store unavailable" },
    expected: "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: event store unavailable",
  },
  {
    name: "revoke",
    patch: { revokeError: "plugin did not acknowledge revoke" },
    expected: "NATIVE_GUARD_REVOKE_FAILED: plugin did not acknowledge revoke",
  },
] as const) {
  test(`${diagnostic.name} failure survives trace write retry`, async () => {
    const runGroup = guardedRunGroup();
    const result = completedAttemptResult({
      runId: `run.coverage.retry.${diagnostic.name}`,
      traceId: `trace.coverage.retry.${diagnostic.name}`,
      sessionKey: `agent:main:run.coverage.retry.${diagnostic.name}`,
      leaseId: `lease.${diagnostic.name}`,
      leaseEpoch: 5,
    });
    Object.assign(result.nativeGuardRuntime!, diagnostic.patch);

    const retryFailure = await retryAfterTraceWriteFailure({ runGroup, result });
    assert.equal(retryFailure, diagnostic.expected);
    assert.deepEqual(runGroup.nativeGuardCoverage?.sessions[0]?.testRunIds, [result.testRun.runId]);
    assert.equal(runGroup.nativeGuardCoverage?.sessions[0]?.eventsTotal, 1);
  });
}

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
      testRunIds: ["run.coverage.test"],
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
