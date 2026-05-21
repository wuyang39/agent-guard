import type { AgentAdapterConfig, AgentUnderTest } from "../agent/agentTypes";
import type { TestContext } from "../config/schemas";
import type { InteractionTrace } from "../monitor/traceTypes";
import { NotImplementedError } from "../../shared/errors";
import type { TestRun } from "./runTypes";

export type TestRunResult = {
  testRun: TestRun;
  trace: InteractionTrace;
};

export async function runTestCase(
  _agent: AgentUnderTest,
  _adapterConfig: AgentAdapterConfig,
  _context: TestContext,
): Promise<TestRunResult> {
  throw new NotImplementedError("Test runner");
}
