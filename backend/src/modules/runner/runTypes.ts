import type { InteractionTrace, RuntimeSupervisionRecord, TestRun } from "@agent-guard/contracts";

export type { TestRun };

export type TestRunResult = {
  testRun: TestRun;
  trace: InteractionTrace;
  supervisionRecords: RuntimeSupervisionRecord[];
};
