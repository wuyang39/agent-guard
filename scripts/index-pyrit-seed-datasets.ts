import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  buildCorpusSourceIndexes,
  corpusSourceFiles,
  resolveCorpusLayout,
} from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const layout = resolveCorpusLayout(projectRoot);
await mkdir(layout.sourceDir, { recursive: true });
const indexes = await buildCorpusSourceIndexes(projectRoot);
await writeJson(corpusSourceFiles.pyritSeedDatasets, indexes.pyritSeedDatasetIndex);
await writeJson(corpusSourceFiles.pyritExecutors, indexes.pyritExecutorTemplateIndex);
await writeJson(corpusSourceFiles.pyritScorers, indexes.pyritScorerTemplateIndex);
console.log(
  `Indexed PyRIT sources: datasets=${indexes.pyritSeedDatasetIndex.datasets.length}, executors=${indexes.pyritExecutorTemplateIndex.executors.length}, scorers=${indexes.pyritScorerTemplateIndex.scorers.length}`,
);

async function writeJson(fileName: string, value: unknown): Promise<void> {
  await writeFile(join(layout.sourceDir, fileName), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
