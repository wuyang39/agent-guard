import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentTask,
  AgentUnderTest,
} from "./agentTypes";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type { ToolCallPayload, ToolResultPayload } from "../monitor/traceTypes";
import { NotImplementedError } from "../../shared/errors";

export type AgentToolBridge = {
  handleToolCall(call: ToolCallPayload): Promise<ToolResultPayload>;
};

export type AgentRunMeta = {
  runId: string;
  caseId: string;
  agentId: string;
};

export type AgentSession = {
  agent: AgentUnderTest;
  config: AgentAdapterConfig;
  sendTask(
    task: AgentTask,
    bridge?: AgentMcpBridge,
    runMeta?: AgentRunMeta,
  ): Promise<AgentRunResult>;
  close?(): Promise<void>;
};

export type AgentAdapter = {
  adapterType: AgentUnderTest["adapterType"];
  createSession(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
  ): Promise<AgentSession>;
};

export type AgentAdapterRegistry = {
  register(adapter: AgentAdapter): void;
  get(adapterType: AgentUnderTest["adapterType"]): AgentAdapter | undefined;
};

export type SendTask = (
  agent: AgentUnderTest,
  config: AgentAdapterConfig,
  task: AgentTask,
  bridge?: AgentMcpBridge,
) => Promise<AgentRunResult>;

export const sendTask: SendTask = async () => {
  throw new NotImplementedError("Agent adapter sendTask");
};

export function createAgentAdapterRegistry(): AgentAdapterRegistry {
  const adapters = new Map<AgentUnderTest["adapterType"], AgentAdapter>();

  return {
    register(adapter) {
      adapters.set(adapter.adapterType, adapter);
    },
    get(adapterType) {
      return adapters.get(adapterType);
    },
  };
}
