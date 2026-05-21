import type {
  AttackEntryType,
  JsonValue,
  RiskCategory,
  RiskLevel,
  SchemaVersion,
} from "./common";
import type { TraceEventType } from "./trace";

export type RiskRule = {
  ruleId: string;
  ruleVersion: SchemaVersion;
  name: string;
  category: RiskCategory;
  riskLevel: RiskLevel;
  description: string;
  match: RuleMatchCondition;
  evidenceRequired: boolean;
};

export type RuleMatchCondition = {
  relation: "all" | "any";
  eventTypes?: TraceEventType[];
  attackEntryTypes?: AttackEntryType[];
  riskTagIds?: string[];
  matchers?: FieldMatcher[];
};

export type MatchOperator =
  | "exists"
  | "equals"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "in"
  | "regex";

export type FieldMatcher = {
  fieldPath: string;
  operator: MatchOperator;
  value?: JsonValue;
  caseSensitive?: boolean;
  normalize?: "none" | "lowercase" | "trim" | "url_decode";
};

export type RiskEvaluationResult = {
  schemaVersion: SchemaVersion;
  evaluationId: string;
  contextId: string;
  caseId: string;
  traceId: string;
  riskLevel: RiskLevel;
  findings: Finding[];
  evidenceChains: EvidenceChain[];
  attackChains: AttackChain[];
  evaluatedAt: string;
};

export type Finding = {
  findingId: string;
  ruleId: string;
  title: string;
  category: RiskCategory;
  riskLevel: RiskLevel;
  description: string;
  evidenceEventIds: string[];
};

export type EvidenceChain = {
  chainId: string;
  findingId: string;
  eventIds: string[];
  summary: string;
};

export type AttackChain = {
  chainId: string;
  findingId: string;
  entryType: AttackEntryType;
  steps: AttackChainStep[];
  summary: string;
};

export type AttackChainStep = {
  stepId: string;
  sequence: number;
  eventId: string;
  title: string;
  description: string;
};
