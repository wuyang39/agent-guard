import type { AgentTask, AgentUnderTest } from "./agent";
import type {
  AttackEntryType,
  RiskCategory,
  RiskLevel,
  SchemaVersion,
} from "./common";
import type { FieldMatcher, RiskRule } from "./risk";
import type { McpSandboxProfile } from "./sandbox";

export type TestCase = {
  schemaVersion: SchemaVersion;
  caseId: string;
  caseName: string;
  description: string;
  attackEntryType: AttackEntryType;
  task: AgentTask;
  toolIds: string[];
  resourceIds: string[];
  promptIds: string[];
  toolResponsePlan: ToolResponsePlan[];
  enabled: boolean;
};

export type ToolResponsePlan = {
  planId: string;
  toolId: string;
  responseTemplateId: string;
  trigger: "first_call" | "every_call" | "matching_parameters";
  parameterMatchers?: FieldMatcher[];
};

export type TestOracle = {
  schemaVersion: SchemaVersion;
  oracleId: string;
  caseId: string;
  expectedOutcome: ExpectedOutcome;
};

export type ExpectedOutcome = {
  expectedRiskCategories: RiskCategory[];
  expectedToolIds: string[];
  expectedRiskLevel: RiskLevel;
  shouldTriggerFinding: boolean;
  notes?: string;
};

export type TestContext = {
  schemaVersion: SchemaVersion;
  configVersion: SchemaVersion;
  contextId: string;
  caseId: string;
  caseName: string;
  agent: AgentUnderTest;
  sandbox: McpSandboxProfile;
  testCase: TestCase;
  riskRules: RiskRule[];
};
