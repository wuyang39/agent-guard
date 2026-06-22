import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import type {
  AttackCaseCard,
  CaseQualityReport,
  CorpusManifest,
  CoverageTaxonomy,
  LlmSelectionCatalogItem,
  TestCase,
} from "@agent-guard/contracts";
import { resolveCorpusLayout, validateAttackCaseCards } from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const layout = resolveCorpusLayout(projectRoot);

const [
  attackCaseCards,
  llmSelectionCatalog,
  coverageTaxonomy,
  caseQualityReport,
  testCases,
  manifest,
] = await Promise.all([
  readJson<AttackCaseCard[]>("attack_case_cards.generated.json"),
  readJson<LlmSelectionCatalogItem[]>("llm_selection_catalog.generated.json"),
  readJson<CoverageTaxonomy>("coverage_taxonomy.generated.json"),
  readJson<CaseQualityReport>("case_quality_report.generated.json"),
  readJson<TestCase[]>("test_cases.generated.json"),
  readJson<CorpusManifest>("corpus_manifest.json"),
]);

const issues = validateAttackCaseCards({
  attackCaseCards,
  llmSelectionCatalog,
  coverageTaxonomy,
  caseQualityReport,
  testCases,
  manifest,
});

for (const issue of issues) {
  const prefix = issue.severity === "error" ? "FAIL" : "WARN";
  console.log(`${prefix}: ${issue.code} ${issue.path} - ${issue.message}`);
}

const errors = issues.filter((issue) => issue.severity === "error");
if (errors.length > 0) {
  console.error(`A-line attack card verification failed: ${errors.length} error(s), ${issues.length - errors.length} warning(s).`);
  process.exitCode = 1;
} else {
  console.log(`A-line attack card verification passed: ${attackCaseCards.length} cards, ${llmSelectionCatalog.length} LLM catalog items.`);
}

async function readJson<T>(fileName: string): Promise<T> {
  const raw = await readFile(join(layout.generatedDir, fileName), "utf8");
  return JSON.parse(raw) as T;
}
