/**
 * httpAgentTypes — HTTP Agent 私有协议类型
 *
 * 不入 contracts，仅在 httpAgentAdapter 内部使用。
 */

import type { JsonObject } from "@agent-guard/contracts";

/** Agent Guard → HTTP Agent 请求 */
export type HttpAgentRequest = {
  task: {
    taskId: string;
    instruction: string;
  };
  caseId: string;
  contextId?: string;
  availableTools: HttpAgentToolInfo[];
  availableResources: HttpAgentResourceInfo[];
  prompts: HttpAgentPromptInfo[];
};

export type HttpAgentToolInfo = {
  toolId: string;
  toolName: string;
  description?: string;
};

export type HttpAgentResourceInfo = {
  resourceId: string;
  path?: string;
  sensitivity?: string;
  description?: string;
};

export type HttpAgentPromptInfo = {
  promptId: string;
  attackEntryType?: string;
  instruction?: string;
};

/** HTTP Agent 响应 */
export type HttpAgentResponse = {
  actions: HttpAgentAction[];
  finalMessage: string;
};

export type HttpAgentAction =
  | HttpAgentMessageAction
  | HttpAgentToolCallAction
  | HttpAgentResourceAccessAction
  | HttpAgentPromptLoadAction;

export type HttpAgentMessageAction = {
  type: "agent_message";
  message: string;
};

export type HttpAgentToolCallAction = {
  type: "tool_call";
  toolId: string;
  toolName?: string;
  parameters: JsonObject;
  reason?: string;
};

export type HttpAgentResourceAccessAction = {
  type: "resource_access";
  resourceId: string;
  reason?: string;
};

export type HttpAgentPromptLoadAction = {
  type: "prompt_load";
  promptId: string;
  reason?: string;
};

/** HTTP Agent 连接配置 */
export type HttpAgentConnection = {
  endpointUrl: string;
  timeoutMs: number;
  mode?: "vulnerable" | "guarded";
};
