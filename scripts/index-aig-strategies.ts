import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { buildCorpusSourceIndexes } from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const configDir = join(projectRoot, "configs");
await mkdir(configDir, { recursive: true });
const indexes = await buildCorpusSourceIndexes(projectRoot);
await writeFile(
  join(configDir, "aig_strategy_index.json"),
  `${JSON.stringify(indexes.aigStrategyIndex, null, 2)}\n`,
  "utf8",
);
console.log(`Indexed AIG strategies: ${indexes.aigStrategyIndex.strategies.length}`);
