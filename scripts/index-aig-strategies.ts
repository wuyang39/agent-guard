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
await writeFile(
  join(layout.sourceDir, corpusSourceFiles.aigStrategies),
  `${JSON.stringify(indexes.aigStrategyIndex, null, 2)}\n`,
  "utf8",
);
console.log(`Indexed AIG strategies: ${indexes.aigStrategyIndex.strategies.length}`);
