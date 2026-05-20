import type {
  AttackEntryType,
  JsonObject,
  RiskCategory,
  RiskLevel,
  SchemaVersion,
} from "./common";

export type McpSandboxProfile = {
  schemaVersion: SchemaVersion;
  sandboxId: string;
  name: string;
  description?: string;
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
  toolResponseTemplates: ToolResponseTemplate[];
};

export type ToolDefinition = {
  toolId: string;
  name: string;
  description: string;
  schema: JsonObject;
  parameters: ToolParameter[];
  riskTags: RiskTag[];
  riskLevel: RiskLevel;
  sideEffect: "none" | "read" | "write" | "network" | "command";
};

export type ToolParameter = {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description?: string;
};

export type ResourceDefinition = {
  resourceId: string;
  name: string;
  type: "document" | "file" | "secret" | "database" | "web";
  path?: string;
  description?: string;
  sensitivity: "public" | "internal" | "sensitive" | "secret";
  containsInjection: boolean;
  riskTags: RiskTag[];
  accessPolicy: AccessPolicy;
};

export type PromptDefinition = {
  promptId: string;
  name: string;
  description?: string;
  attackEntryType?: AttackEntryType;
  content: string;
  riskTags: RiskTag[];
};

export type ToolResponseTemplate = {
  responseTemplateId: string;
  toolId: string;
  name: string;
  content: string;
  containsInjection: boolean;
  riskTags: RiskTag[];
};

export type RiskTag = {
  tagId: string;
  category: RiskCategory;
  level: RiskLevel;
  description: string;
};

export type AccessPolicy = {
  allowedAgentIds: string[];
  allowedUseCases: string[];
};
