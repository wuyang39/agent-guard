import type {
  AttackEntryType,
  JsonObject,
  RiskCategory,
  SchemaVersion,
} from "./common";

export type PyritAttackLibrary = {
  schemaVersion: SchemaVersion;
  libraryId: string;
  name: string;
  description: string;
  source: PyritSourceMetadata;
  converterCatalog: PyritPromptConverterSpec[];
  attackFamilies: PyritAttackFamily[];
  samples: PyritAttackSample[];
};

export type PyritSourceMetadata = {
  upstreamName: string;
  upstreamVersion?: string;
  localSourcePath: string;
  importedPath: string;
  importedAt: string;
  includedComponents: string[];
  excludedComponents: string[];
  notes?: string;
};

export type PyritPromptConverterSpec = {
  converterId: string;
  name: string;
  sourcePath: string;
  executionMode: "native_ts_adapter" | "python_reference" | "metadata_only";
  supportedInputTypes: string[];
  tags: string[];
  description: string;
  defaultOptions?: JsonObject;
};

export type PyritAttackFamily = {
  familyId: string;
  name: string;
  sourcePaths: string[];
  strategy: string;
  maturity: "vendored_reference" | "config_integrated" | "runtime_integrated";
  recommendedCaseIds: string[];
  riskCategories: RiskCategory[];
  notes?: string;
};

export type PyritAttackSample = {
  sampleId: string;
  familyId: string;
  name: string;
  sourcePath: string;
  caseIds: string[];
  promptIds: string[];
  converterIds: string[];
  attackEntryType: AttackEntryType;
  riskCategories: RiskCategory[];
  objective: string;
  successMarkers: string[];
  safetyNotes: string;
  metadata?: JsonObject;
};
