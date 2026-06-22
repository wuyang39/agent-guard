export type SchemaVersion = "mvp-1" | "p3-a-1";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type RiskCategory =
  | "tool_misuse"
  | "unauthorized_access"
  | "data_leakage"
  | "dangerous_action"
  | "instruction_injection_following";

export type AttackEntryType =
  | "malicious_user_prompt"
  | "malicious_resource"
  | "tool_response_injection"
  | "multi_turn_induction";

export type ReportFormat = "json" | "html" | "markdown" | "pdf";

export type RunStatus = "running" | "completed" | "failed";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

export type JsonObject = {
  [key: string]: JsonValue;
};

export type JsonArray = JsonValue[];
