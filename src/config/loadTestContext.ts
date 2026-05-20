import type {
  AgentUnderTest,
  TestContext,
  TestOracle,
} from "../shared/contracts";
import { NotImplementedError } from "../shared/errors";
import type { ConfigRepository } from "./configRepository";

export type LoadedConfigRepository = ConfigRepository;

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
