import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { buildCorpusSourceIndexes } from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configDir = join(projectRoot, "configs");
await mkdir(configDir, { recursive: true });
const indexes = await buildCorpusSourceIndexes(projectRoot);
await writeJson("pyrit_seed_dataset_index.json", indexes.pyritSeedDatasetIndex);
await writeJson("pyrit_executor_template_index.json", indexes.pyritExecutorTemplateIndex);
await writeJson("pyrit_scorer_template_index.json", indexes.pyritScorerTemplateIndex);
console.log(
  `Indexed PyRIT sources: datasets=${indexes.pyritSeedDatasetIndex.datasets.length}, executors=${indexes.pyritExecutorTemplateIndex.executors.length}, scorers=${indexes.pyritScorerTemplateIndex.scorers.length}`,
);

async function writeJson(fileName: string, value: unknown): Promise<void> {
  await writeFile(join(configDir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
