import type { JsonObject, RunStatus, SchemaVersion } from "./common";

export type AgentUnderTest = {
  schemaVersion: SchemaVersion;
  agentId: string;
  name: string;
  description?: string;
  adapterType: "api" | "local_script" | "sdk" | "mock";
};

export type AgentAdapterConfig = {
  schemaVersion: SchemaVersion;
  adapterId: string;
  agentId: string;
  adapterType: "api" | "local_script" | "sdk" | "mock";
  endpoint?: string;
  scriptPath?: string;
  sdkName?: string;
  timeoutMs: number;
  envKeys?: string[];
};

export type AgentTask = {
  taskId: string;
  caseId: string;
  instruction: string;
  promptIds: string[];
  resourceIds: string[];
  metadata?: JsonObject;
};

export type AgentRunResult = {
  schemaVersion: SchemaVersion;
  runId: string;
  agentId: string;
  caseId: string;
  status: RunStatus;
  finalMessage?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
};
