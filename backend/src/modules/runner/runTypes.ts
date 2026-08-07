import type { InteractionTrace, RuntimeSupervisionRecord, TestRun } from "@agent-guard/contracts";
import type { NativeGuardReconciliationSummary } from "../agent/agentAdapter";

export type { TestRun };

export type TestRunResult = {
  testRun: TestRun;
  trace: InteractionTrace;
  supervisionRecords: RuntimeSupervisionRecord[];
  /** Task 14: Native guard runtime evidence drained after the run. */
  nativeGuardRuntime?: {
    sessionKey?: string;
    leaseId?: string;
    leaseEpoch?: number;
    events: import("@agent-guard/contracts").NativeGuardEvent[];
    reconciliation?: NativeGuardReconciliationSummary;
    revokeError?: string;
    evidenceError?: string;
  };
};
