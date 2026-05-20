import type {
  AgentUnderTest,
  McpSandboxProfile,
  RiskRule,
  TestCase,
  TestContext,
  TestOracle,
} from "../shared/contracts";
import { NotImplementedError } from "../shared/errors";

export type LoadedConfigRepository = {
  sandbox: McpSandboxProfile;
  testCases: TestCase[];
  testOracles: TestOracle[];
  riskRules: RiskRule[];
};

export type LoadTestContextResult = {
  contexts: TestContext[];
  testOracles: TestOracle[];
};

export async function loadConfigRepository(
  _configDir: string,
): Promise<LoadedConfigRepository> {
  throw new NotImplementedError("Config repository loading");
}

export async function loadTestContexts(
  _configDir: string,
  _agent: AgentUnderTest,
): Promise<LoadTestContextResult> {
  throw new NotImplementedError("TestContext construction");
}
