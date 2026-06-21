import type { JsonObject, RiskLevel, SchemaVersion } from "./common";
import type { GatewayRuntimeContext } from "./gateway";
import type { SupervisionAction, SupervisionTargetType } from "./policy";

export type RuntimeSupervisionRecord = {
  schemaVersion: SchemaVersion;
  recordId: string;
  runtimeSessionId: string;
  agentId: string;
  policyPackId: string;
  policyId: string;
  action: SupervisionAction;
  decisionReason: string;
  targetType: SupervisionTargetType;
  targetId?: string;
  inputEventId?: string;
  outputEventId?: string;
  gateway?: GatewayRuntimeContext;
  createdAt: string;
};

export type RuntimeAlert = {
  alertId: string;
  recordId: string;
  riskLevel: RiskLevel;
  title: string;
  message: string;
  createdAt: string;
};

export type BlockedAction = {
  blockedActionId: string;
  recordId: string;
  policyId: string;
  targetType: SupervisionTargetType;
  targetId?: string;
  reason: string;
  createdAt: string;
};

export type RuntimeActionPayload =
  | RuntimeToolCallPayload
  | RuntimeResourceAccessPayload
  | RuntimeApiCallPayload
  | RuntimeFileWritePayload
  | RuntimeEmailSendPayload
  | RuntimeCodeExecutionPayload
  | RuntimeAgentMessagePayload;

export type RuntimeToolCallPayload = {
  toolId: string;
  toolName?: string;
  parameters: JsonObject;
};

export type RuntimeResourceAccessPayload = {
  resourceId: string;
  path?: string;
};

export type RuntimeApiCallPayload = {
  method: string;
  url: string;
  data?: string;
  headers?: JsonObject;
};

export type RuntimeFileWritePayload = {
  path: string;
  contentPreview?: string;
};

export type RuntimeEmailSendPayload = {
  to: string[];
  subject: string;
  bodyPreview?: string;
};

export type RuntimeCodeExecutionPayload = {
  language: string;
  codePreview: string;
};

export type RuntimeAgentMessagePayload = {
  message: string;
};

export type SupervisionRuntimeAction = {
  runtimeSessionId: string;
  agentId: string;
  targetType: SupervisionTargetType;
  targetId?: string;
  payload: RuntimeActionPayload;
  inputEventId?: string;
  gateway?: GatewayRuntimeContext;
};
