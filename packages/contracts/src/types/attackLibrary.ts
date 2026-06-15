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

export type PyritJailbreakTemplateIndex = {
  schemaVersion: SchemaVersion;
  indexId: string;
  name: string;
  description: string;
  sourcePath: string;
  generatedAt: string;
  totalTemplates: number;
  groups: PyritJailbreakTemplateGroup[];
  templates: PyritJailbreakTemplateRef[];
  safetyNotes: string;
};

export type PyritJailbreakTemplateGroup = {
  groupId: string;
  name: string;
  sourcePath: string;
  templateCount: number;
};

export type PyritJailbreakTemplateRef = {
  templateId: string;
  name: string;
  groupId: string;
  sourcePath: string;
  sourceName?: string;
  authors: string[];
  parameters: string[];
  dataType?: string;
  harmCategories: string[];
  isGeneralTechnique?: boolean;
  byteLength: number;
  sha256: string;
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
