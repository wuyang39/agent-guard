import type {
  AttackCaseCard,
  CaseQualityReport,
  CorpusManifest,
  CoverageTaxonomy,
  LlmSelectionCatalogItem,
  TestCase,
} from "@agent-guard/contracts";

export type AttackCaseCardValidationIssue = {
  severity: "warning" | "error";
  code: string;
  path: string;
  message: string;
};

export type AttackCaseCardValidationInput = {
  attackCaseCards: AttackCaseCard[];
  llmSelectionCatalog: LlmSelectionCatalogItem[];
  coverageTaxonomy: CoverageTaxonomy;
  caseQualityReport: CaseQualityReport;
  testCases: TestCase[];
  manifest: CorpusManifest;
};

const requiredOpenClawFamilies = ["prompt_injection", "data_leakage", "tool_hijack", "auth_bypass"] as const;
const openClawSurfaceBaseline = ["file_access", "code_execution", "network", "api"] as const;
const forbiddenCatalogKeys = [
  "instruction",
  "content",
  "expectedOutcome",
  "runtimeObjectivePayloadPreview",
  "toolResponsePlan",
  "resourceIds",
] as const;

export function validateAttackCaseCards(input: AttackCaseCardValidationInput): AttackCaseCardValidationIssue[] {
  const issues: AttackCaseCardValidationIssue[] = [];
  const testCaseIds = new Set(input.testCases.map((testCase) => testCase.caseId));
  const manifestCaseIds = new Set(
    input.manifest.items
      .filter((item) => item.itemType === "test_case" && item.caseId)
      .map((item) => item.caseId as string),
  );
  const cardIds = new Set<string>();

  if (input.attackCaseCards.length !== input.testCases.length) {
    issues.push(error(
      "card_count_mismatch",
      "attack_case_cards.generated.json",
      `AttackCaseCard count ${input.attackCaseCards.length} does not match test case count ${input.testCases.length}.`,
    ));
  }
  if (input.llmSelectionCatalog.length !== input.attackCaseCards.length) {
    issues.push(error(
      "catalog_count_mismatch",
      "llm_selection_catalog.generated.json",
      `LLM catalog count ${input.llmSelectionCatalog.length} does not match card count ${input.attackCaseCards.length}.`,
    ));
  }
  if (input.coverageTaxonomy.totalCards !== input.attackCaseCards.length) {
    issues.push(error(
      "taxonomy_total_mismatch",
      "coverage_taxonomy.generated.json",
      `Coverage taxonomy totalCards ${input.coverageTaxonomy.totalCards} does not match card count ${input.attackCaseCards.length}.`,
    ));
  }
  if (input.caseQualityReport.totalCards !== input.attackCaseCards.length) {
    issues.push(error(
      "quality_total_mismatch",
      "case_quality_report.generated.json",
      `Case quality report totalCards ${input.caseQualityReport.totalCards} does not match card count ${input.attackCaseCards.length}.`,
    ));
  }

  input.attackCaseCards.forEach((card, index) => {
    const path = `attack_case_cards.generated.json[${index}]`;
    if (cardIds.has(card.caseId)) {
      issues.push(error("duplicate_card_case_id", `${path}.caseId`, `Duplicate AttackCaseCard caseId ${card.caseId}.`));
    }
    cardIds.add(card.caseId);
    if (!testCaseIds.has(card.caseId)) {
      issues.push(error("unknown_card_case_id", `${path}.caseId`, `AttackCaseCard ${card.caseId} has no generated TestCase.`));
    }
    if (!manifestCaseIds.has(card.caseId)) {
      issues.push(error("missing_manifest_case_item", `${path}.caseId`, `AttackCaseCard ${card.caseId} has no CorpusManifest test_case item.`));
    }
    if (card.attackFamilies.length === 0) {
      issues.push(error("missing_attack_family", `${path}.attackFamilies`, `AttackCaseCard ${card.caseId} has no attack family.`));
    }
    if (card.targetSurfaces.length === 0) {
      issues.push(error("missing_target_surface", `${path}.targetSurfaces`, `AttackCaseCard ${card.caseId} has no target surface.`));
    }
    if (card.runProfiles.length === 0) {
      issues.push(error("missing_run_profile", `${path}.runProfiles`, `AttackCaseCard ${card.caseId} has no run profile.`));
    }
    if (!/^[0-9a-f]{64}$/.test(card.digest)) {
      issues.push(error("invalid_digest", `${path}.digest`, `AttackCaseCard ${card.caseId} digest is not a SHA-256 hex string.`));
    }
    for (const summaryField of ["promptSummary", "payloadRiskSummary", "oracleSummary"] as const) {
      const value = card[summaryField];
      if (containsSecretLikeText(value)) {
        issues.push(error("unsafe_summary_text", `${path}.${summaryField}`, `AttackCaseCard ${card.caseId} ${summaryField} contains secret-like or payload-like text.`));
      }
      if (value.length > 320) {
        issues.push(error("summary_too_long", `${path}.${summaryField}`, `AttackCaseCard ${card.caseId} ${summaryField} is too long for selection metadata.`));
      }
    }
  });

  validateOpenClawCoverage(input.attackCaseCards, issues);
  validateCatalog(input.llmSelectionCatalog, cardIds, issues);
  validateStableOrdering(input.attackCaseCards, issues);

  return issues;
}

function validateOpenClawCoverage(
  cards: AttackCaseCard[],
  issues: AttackCaseCardValidationIssue[],
): void {
  const openClawCards = cards.filter((card) => card.enabled && card.runProfiles.includes("openclaw"));
  if (openClawCards.length < 30) {
    issues.push(error(
      "openclaw_card_count_below_baseline",
      "attack_case_cards.generated.json",
      `OpenClaw profile has ${openClawCards.length} enabled cards; expected at least 30.`,
    ));
  }

  const familySet = new Set(openClawCards.flatMap((card) => card.attackFamilies));
  for (const family of requiredOpenClawFamilies) {
    if (!familySet.has(family)) {
      issues.push(error(
        "openclaw_family_gap",
        "attack_case_cards.generated.json",
        `OpenClaw profile does not cover required attack family ${family}.`,
      ));
    }
  }

  const surfaceSet = new Set(openClawCards.flatMap((card) => card.targetSurfaces));
  const coveredBaselineSurfaces = openClawSurfaceBaseline.filter((surface) => surfaceSet.has(surface));
  if (coveredBaselineSurfaces.length < 3) {
    issues.push(error(
      "openclaw_surface_gap",
      "attack_case_cards.generated.json",
      `OpenClaw profile covers ${coveredBaselineSurfaces.length} of file/code/network/api surfaces; expected at least 3.`,
    ));
  }
}

function validateCatalog(
  catalog: LlmSelectionCatalogItem[],
  cardIds: Set<string>,
  issues: AttackCaseCardValidationIssue[],
): void {
  catalog.forEach((item, index) => {
    const path = `llm_selection_catalog.generated.json[${index}]`;
    if (!cardIds.has(item.caseId)) {
      issues.push(error("catalog_unknown_case_id", `${path}.caseId`, `Catalog item ${item.caseId} has no matching AttackCaseCard.`));
    }
    for (const key of forbiddenCatalogKeys) {
      if (Object.hasOwn(item, key)) {
        issues.push(error("catalog_forbidden_field", `${path}.${key}`, `LLM selection catalog must not expose ${key}.`));
      }
    }
    const serialized = JSON.stringify(item);
    if (containsSecretLikeText(serialized)) {
      issues.push(error("catalog_unsafe_text", path, `Catalog item ${item.caseId} contains secret-like or payload-like text.`));
    }
  });
}

function validateStableOrdering(
  cards: AttackCaseCard[],
  issues: AttackCaseCardValidationIssue[],
): void {
  for (let index = 1; index < cards.length; index += 1) {
    if (compareCardOrder(cards[index - 1], cards[index]) > 0) {
      issues.push(error(
        "unstable_card_order",
        `attack_case_cards.generated.json[${index}]`,
        `AttackCaseCard ${cards[index].caseId} is not in stable selection order.`,
      ));
      return;
    }
  }
}

function compareCardOrder(left: AttackCaseCard, right: AttackCaseCard): number {
  const profileDelta = profileRank(left.runProfiles) - profileRank(right.runProfiles);
  if (profileDelta !== 0) return profileDelta;
  const qualityDelta = right.qualityScore - left.qualityScore;
  if (qualityDelta !== 0) return qualityDelta;
  return left.caseId.localeCompare(right.caseId);
}

function profileRank(runProfiles: readonly string[]): number {
  const order = ["smoke", "openclaw", "regression", "full-corpus"];
  const ranks = runProfiles.map((profileId) => order.indexOf(profileId)).filter((index) => index >= 0);
  return ranks.length > 0 ? Math.min(...ranks) : Number.POSITIVE_INFINITY;
}

function containsSecretLikeText(value: string): boolean {
  return /sk-[A-Za-z0-9_\-]{12,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._\-]{20,}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}|\b[A-Za-z0-9+/]{180,}={0,2}\b|\b[0-9a-fA-F]{180,}\b/i.test(value);
}

function error(code: string, path: string, message: string): AttackCaseCardValidationIssue {
  return { severity: "error", code, path, message };
}
