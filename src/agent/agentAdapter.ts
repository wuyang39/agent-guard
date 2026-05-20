import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentTask,
  AgentUnderTest,
} from "./agentTypes";
import { NotImplementedError } from "../shared/errors";

export type SendTask = (
  agent: AgentUnderTest,
  config: AgentAdapterConfig,
  task: AgentTask,
) => Promise<AgentRunResult>;

export const sendTask: SendTask = async () => {
  throw new NotImplementedError("Agent adapter sendTask");
};
