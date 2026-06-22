import type { SchemaVersion } from "./common";

export type TestSelectionProfile =
  | "smoke"
  | "openclaw"
  | "regression"
  | "full-corpus";

export type TestSelectionMode = "rule_only" | "llm_assisted" | "replay";

export type TestSelectionStatus =
  | "draft"
  | "ready"
  | "running"
  | "completed"
  | "failed";

export type CandidateCaseSourceOrigin =
  | "pyrit"
  | "aig"
  | "manual"
  | "user_supplied"
  | "synthetic"
  | "derived";

export type CandidateCaseCard = {
  schemaVersion: SchemaVersion;
  caseId: string;
  caseName: string;
  enabled: boolean;
  runProfiles: TestSelectionProfile[];
  attackFamilies: string[];
  targetSurfaces: string[];
  targetToolHints: string[];
  sensitivityTags: string[];
  estimatedDurationMs?: number;
  requiresExternalTool?: boolean;
  requiresOpenClaw?: boolean;
  sourceOrigin: CandidateCaseSourceOrigin;
  promptSummary?: string;
  payloadRiskSummary?: string;
  expectedSafeBehaviorSummary?: string;
  qualityScore: number;
};

export type SelectedCaseSummary = {
  caseId: string;
  caseName: string;
  attackFamilies: string[];
  targetSurfaces: string[];
  qualityScore: number;
  reason: string;
};

export type CoverageSnapshot = {
  attackFamilyCount: number;
  targetSurfaceCount: number;
  selectedCaseCount: number;
  coveredAttackFamilies: string[];
  coveredTargetSurfaces: string[];
  missingRequiredAttackFamilies: string[];
  missingRequiredTargetSurfaces: string[];
  blockingIssues: string[];
  warnings: string[];
  ready: boolean;
};

export type SelectionCoverageRequirements = {
  minCaseCount: number;
  minAttackFamilyCount: number;
  requiredAttackFamilies: string[];
  requiredTargetSurfaces: string[];
};

export type SelectionProfileSummary = {
  profileId: string;
  targetProfile: TestSelectionProfile;
  selectionMode: TestSelectionMode;
  adapterKind?: "mock" | "http_sample" | "openclaw";
  maxCaseCount: number;
  timeBudgetMs?: number;
};

export type SelectionRunSummary = {
  candidateCaseCount: number;
  selectedCaseCount: number;
  ruleSelectedCount: number;
  llmAcceptedCount: number;
  llmRejectedCount: number;
  fallbackUsed: boolean;
  ready: boolean;
};

export type SelectionEvalStyleResult = {
  status: "ready" | "needs_review";
  passedChecks: string[];
  failedChecks: string[];
  warnings: string[];
};

export type SelectionReason = {
  caseId: string;
  reason: string;
  source: "rule" | "llm" | "validator";
};

export type LlmSelectionAudit = {
  enabled: boolean;
  provider: string;
  model?: string;
  promptTemplateVersion: string;
  inputDigest: string;
  outputDigest?: string;
  durationMs?: number;
  acceptedCaseIds: string[];
  rejectedCaseIds: string[];
  validationWarnings: string[];
  fallbackUsed: boolean;
};

export type TestSelectionPlan = {
  schemaVersion: SchemaVersion;
  selectionPlanId: string;
  agentId: string;
  corpusManifestId: string;
  status: TestSelectionStatus;
  mode: TestSelectionMode;
  targetProfile: TestSelectionProfile;
  selectionProfile: SelectionProfileSummary;
  coverageRequirements: SelectionCoverageRequirements;
  requestedCaseCount: number;
  selectedCaseIds: string[];
  selectedCasesSummary: SelectedCaseSummary[];
  coverageSnapshot: CoverageSnapshot;
  selectionRunSummary: SelectionRunSummary;
  evalStyleResult: SelectionEvalStyleResult;
  selectionReasons: SelectionReason[];
  llmAudit?: LlmSelectionAudit;
  fallbackReasons: string[];
  runGroupIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type TestSelectionRequest = {
  schemaVersion: SchemaVersion;
  agentId?: string;
  manifestId?: string;
  targetProfile: TestSelectionProfile;
  selectionMode: Exclude<TestSelectionMode, "replay">;
  maxCaseCount?: number;
  minCaseCount?: number;
  timeBudgetMs?: number;
  requiredAttackFamilies?: string[];
  requiredTargetSurfaces?: string[];
  includeExternalTools?: boolean;
  adapterKind?: "mock" | "http_sample" | "openclaw";
};
