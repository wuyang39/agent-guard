import type { InteractionTrace, RuntimeSupervisionRecord, TestRun } from "@agent-guard/contracts";

export type { TestRun };

export type TestRunResult = {
  testRun: TestRun;
  trace: InteractionTrace;
  supervisionRecords: RuntimeSupervisionRecord[];
  /** Task 14: Native guard runtime evidence drained after the run. */
  nativeGuardRuntime?: {
    events: import("@agent-guard/contracts").NativeGuardEvent[];
    reconciliation?: { reconciled: boolean; coverageBreachCount: number };
    revokeError?: string;
  };
};
