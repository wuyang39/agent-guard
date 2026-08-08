import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentUnderTest,
  TestContext,
} from "@agent-guard/contracts";
import type { AgentAdapter, AgentSession } from "../agent/agentAdapter";
import { runTestCase } from "./testRunner";

const AGENT: AgentUnderTest = {
  schemaVersion: "mvp-1",
  agentId: "agent.native-guard-test",
  name: "Native guard evidence test",
  adapterType: "mock",
};

const ADAPTER_CONFIG: AgentAdapterConfig = {
  schemaVersion: "mvp-1",
  adapterId: "adapter.native-guard-test",
  agentId: AGENT.agentId,
  adapterType: "mock",
  timeoutMs: 1_000,
};

const CONTEXT = {
  schemaVersion: "mvp-1",
  configVersion: "mvp-1",
  contextId: "context.native-guard-test",
  caseId: "case.native-guard-test",
  caseName: "Native guard evidence test",
  agent: AGENT,
  sandbox: {
    schemaVersion: "mvp-1",
    sandboxId: "sandbox.native-guard-test",
    name: "Native guard evidence test",
    tools: [],
    resources: [],
    prompts: [],
    toolResponseTemplates: [],
  },
  testCase: {
    schemaVersion: "mvp-1",
    caseId: "case.native-guard-test",
    caseName: "Native guard evidence test",
    description: "Exercises the runtime evidence contract.",
    attackEntryType: "malicious_user_prompt",
    task: {
      taskId: "task.native-guard-test",
      caseId: "case.native-guard-test",
      instruction: "Complete without calling a tool.",
      promptIds: [],
      resourceIds: [],
    },
    toolIds: [],
    resourceIds: [],
    promptIds: [],
    toolResponsePlan: [],
    enabled: true,
  },
  riskRules: [],
} as TestContext;

function completedRun(): AgentRunResult {
  return {
    schemaVersion: "mvp-1",
    runId: "run.native-guard-test",
    agentId: AGENT.agentId,
    caseId: CONTEXT.caseId,
    status: "completed",
    finalMessage: "done",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };
}

function adapterWithSession(
  sessionOverrides: Partial<AgentSession>,
): AgentAdapter {
  return {
    adapterType: "mock",
    async createSession(agent, config) {
      return {
        agent,
        config,
        async sendTask() {
          return completedRun();
        },
        ...sessionOverrides,
      };
    },
  };
}

test("runtime evidence drain failure remains non-fatal when evidence is not required", async () => {
  const result = await runTestCase(AGENT, ADAPTER_CONFIG, CONTEXT, {
    customAdapter: adapterWithSession({
      async drainRuntimeEvidence() {
        throw new Error("store unavailable");
      },
    }),
  });

  assert.equal(result.testRun.status, "completed");
  assert.equal(result.nativeGuardRuntime, undefined);
});

test("agent failures are scrubbed before entering the test run and trace", async () => {
  const result = await runTestCase(AGENT, ADAPTER_CONFIG, CONTEXT, {
    customAdapter: adapterWithSession({
      async sendTask() {
        throw new Error(
          "gatewayToken=super-secret OPENAI_API_KEY=sk-test-secret request failed",
        );
      },
    }),
  });

  const serializedTrace = JSON.stringify(result.trace);
  assert.equal(result.testRun.status, "failed");
  assert.match(result.testRun.error ?? "", /gatewayToken=\[REDACTED\]/);
  assert.match(result.testRun.error ?? "", /OPENAI_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(result.testRun.error ?? "", /super-secret|sk-test-secret/);
  assert.match(serializedTrace, /gatewayToken=\[REDACTED\]/);
  assert.match(serializedTrace, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(serializedTrace, /super-secret|sk-test-secret/);
});

test("required runtime evidence drain failure is fatal and scrubbed", async () => {
  const result = await runTestCase(AGENT, ADAPTER_CONFIG, CONTEXT, {
    requireNativeGuardRuntimeEvidence: true,
    customAdapter: adapterWithSession({
      async drainRuntimeEvidence() {
        throw new Error("OPENCLAW_GATEWAY_TOKEN=super-secret store unavailable");
      },
    }),
  });

  assert.equal(result.testRun.status, "failed");
  assert.match(result.testRun.error ?? "", /^NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/);
  assert.doesNotMatch(result.testRun.error ?? "", /super-secret/);
  assert.match(result.nativeGuardRuntime?.evidenceError ?? "", /OPENCLAW_GATEWAY_TOKEN=\[REDACTED\]/);
});

test("required runtime evidence without reconciliation is fatal", async () => {
  const result = await runTestCase(AGENT, ADAPTER_CONFIG, CONTEXT, {
    requireNativeGuardRuntimeEvidence: true,
    customAdapter: adapterWithSession({
      async drainRuntimeEvidence() {
        return { nativeGuardEvents: [], supervisionRecords: [] };
      },
    }),
  });

  assert.equal(result.testRun.status, "failed");
  assert.match(result.testRun.error ?? "", /^NATIVE_GUARD_EVIDENCE_UNAVAILABLE:/);
  assert.match(result.nativeGuardRuntime?.evidenceError ?? "", /reconciliation/i);
});

test("provider failure before a session result is not replaced by missing reconciliation", async () => {
  const providerError =
    "GatewayClientRequestError: FailoverError: LLM request failed: network connection error.";
  const result = await runTestCase(AGENT, ADAPTER_CONFIG, CONTEXT, {
    requireNativeGuardRuntimeEvidence: true,
    customAdapter: adapterWithSession({
      async sendTask() {
        return {
          ...completedRun(),
          status: "failed",
          error: providerError,
          finalMessage: providerError,
        };
      },
      async drainRuntimeEvidence() {
        return {
          sessionKey: "agent:main:run.native-guard-test",
          leaseId: "lease.provider-failure",
          leaseEpoch: 1,
          nativeGuardEvents: [],
          supervisionRecords: [],
        };
      },
    }),
  });

  assert.equal(result.testRun.status, "failed");
  assert.equal(result.testRun.error, providerError);
  assert.equal(result.nativeGuardRuntime?.evidenceError, undefined);
});

test("required runtime evidence makes a scrubbed revoke error fatal", async () => {
  const result = await runTestCase(AGENT, ADAPTER_CONFIG, CONTEXT, {
    requireNativeGuardRuntimeEvidence: true,
    customAdapter: adapterWithSession({
      async drainRuntimeEvidence() {
        return {
          nativeGuardEvents: [],
          supervisionRecords: [],
          reconciliation: { reconciled: true, coverageBreachCount: 0, mismatchCount: 0 },
          revokeError: "gatewayToken=super-secret plugin did not acknowledge revoke",
        };
      },
    }),
  });

  assert.equal(result.testRun.status, "failed");
  assert.match(result.testRun.error ?? "", /^NATIVE_GUARD_REVOKE_FAILED:/);
  assert.doesNotMatch(result.testRun.error ?? "", /super-secret/);
  assert.match(result.nativeGuardRuntime?.revokeError ?? "", /gatewayToken=\[REDACTED\]/);
});

test("runtime evidence preserves projector mismatch counts", async () => {
  const result = await runTestCase(AGENT, ADAPTER_CONFIG, CONTEXT, {
    requireNativeGuardRuntimeEvidence: true,
    customAdapter: adapterWithSession({
      async drainRuntimeEvidence() {
        return {
          sessionKey: "agent:main:run.native-guard-test",
          leaseId: "lease.mismatch",
          leaseEpoch: 3,
          nativeGuardEvents: [],
          supervisionRecords: [],
          reconciliation: {
            reconciled: false,
            coverageBreachCount: 0,
            mismatchCount: 2,
          },
        } as never;
      },
    }),
  });

  assert.deepEqual(result.nativeGuardRuntime, {
    sessionKey: "agent:main:run.native-guard-test",
    leaseId: "lease.mismatch",
    leaseEpoch: 3,
    events: [],
    reconciliation: {
      reconciled: false,
      coverageBreachCount: 0,
      mismatchCount: 2,
    },
    revokeError: undefined,
    evidenceError: undefined,
  });
});
