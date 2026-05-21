import type { AttackEntryType, JsonObject, JsonValue, RunStatus } from "./common";

export type TestRun = {
  schemaVersion: "mvp-1";
  runId: string;
  contextId: string;
  caseId: string;
  agentId: string;
  sandboxId: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  error?: string;
};

export type InteractionTrace = {
  schemaVersion: "mvp-1";
  traceId: string;
  runId: string;
  contextId: string;
  caseId: string;
  agentId: string;
  sandboxId: string;
  events: TraceEvent[];
  startedAt: string;
  endedAt?: string;
  status: RunStatus;
};

export type TraceEventType =
  | "test_started"
  | "task_sent"
  | "agent_message"
  | "tool_call"
  | "tool_result"
  | "resource_access"
  | "prompt_load"
  | "system_error";

export type TraceActor = "agent" | "mcp_server" | "monitor" | "system";

export type TraceEvent = {
  eventId: string;
  traceId: string;
  runId: string;
  caseId: string;
  timestamp: string;
  sequence: number;
  type: TraceEventType;
  actor: TraceActor;
  payload: TraceEventPayload;
};

export type TraceEventPayload =
  | TestStartedPayload
  | TaskSentPayload
  | AgentMessagePayload
  | ToolCallPayload
  | ToolResultPayload
  | ResourceAccessPayload
  | PromptLoadPayload
  | SystemErrorPayload;

export type TestStartedPayload = {
  contextId: string;
  sandboxId: string;
};

export type TaskSentPayload = {
  taskId: string;
  instruction: string;
};

export type AgentMessagePayload = {
  message: string;
};

export type ToolCallPayload = {
  callId: string;
  toolId: string;
  toolName: string;
  parameters: JsonObject;
  isHighRiskTool: boolean;
};

export type ToolResultPayload = {
  callId: string;
  toolId: string;
  result: JsonValue;
  containsInjection: boolean;
  riskTagIds: string[];
};

export type ResourceAccessPayload = {
  resourceId: string;
  path?: string;
  sensitivity: "public" | "internal" | "sensitive" | "secret";
  authorized: boolean;
  containsInjection: boolean;
  riskTagIds: string[];
};

export type PromptLoadPayload = {
  promptId: string;
  attackEntryType?: AttackEntryType;
  riskTagIds: string[];
};

export type SystemErrorPayload = {
  code: string;
  message: string;
  detail?: JsonObject;
};
