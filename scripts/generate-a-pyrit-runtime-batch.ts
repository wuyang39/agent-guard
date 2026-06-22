import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CorpusRunProfileId, PyritAttackMethod } from "@agent-guard/contracts";
import {
  buildPyritRuntimeRequest,
  loadGeneratedCorpusProfile,
  resolvePyritRuntimeEnv,
  runPyritPythonBridge,
} from "../backend/src/modules/corpus";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profileId = (process.env.PYRIT_RUNTIME_PROFILE ?? "regression") as CorpusRunProfileId;
const maxItems = parsePositiveInt(process.env.PYRIT_RUNTIME_MAX_ITEMS, 8);
const timeoutMs = parsePositiveInt(process.env.PYRIT_RUNTIME_TIMEOUT_MS, 180_000);
const maxTurns = parsePositiveInt(process.env.PYRIT_RUNTIME_MAX_TURNS, 3);
const evaluatorSync = process.env.PYRIT_RUNTIME_EVALUATOR_SYNC === "1";
const required = process.env.VERIFY_PYRIT_RUNTIME_REQUIRED === "1";
const methods = parseMethods(process.env.PYRIT_RUNTIME_METHODS);
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outputDir = join(projectRoot, "outputs", "pyrit-runs", runId);

await mkdir(outputDir, { recursive: true });

const runtime = resolvePyritRuntimeEnv(projectRoot);
console.log(`PyRIT runtime python: ${runtime.displayName}`);
console.log(
  `Model env: endpoint=${runtime.hasEndpoint ? "set" : "missing"}, key=${runtime.hasKey ? "set" : "missing"}, model=${runtime.hasModel ? "set" : "missing"}`,
);

const selection = await loadGeneratedCorpusProfile(projectRoot, profileId);
const request = buildPyritRuntimeRequest({
  profileId,
  testCases: selection.testCases,
  maxItems,
  methods,
  outputDir,
  timeoutMs,
  maxTurns,
  evaluatorSync,
});

await writeFile(join(outputDir, "bridge_request.json"), `${JSON.stringify(request, null, 2)}\n`, "utf8");
const result = await runPyritPythonBridge({
  projectRoot,
  request,
  timeoutMs: timeoutMs * Math.max(1, request.items.length),
});
await writeFile(join(outputDir, "bridge_result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");

const statusSummary = result.items.reduce<Record<string, number>>((summary, item) => {
  summary[item.status] = (summary[item.status] ?? 0) + 1;
  return summary;
}, {});
console.log(
  `PyRIT runtime batch: profile=${profileId}, requested=${request.items.length}, status=${JSON.stringify(statusSummary)}, output=${outputDir}`,
);

const executed = result.items.filter((item) => item.status === "ok" && item.runtimeUsed === "pyrit").length;
const skippedForModel = !result.modelConfigured && result.items.every((item) => item.status === "skipped");
if (skippedForModel) {
  const message = `SKIP: PyRIT runtime model target is not fully configured. Missing: ${runtime.missingModelEnv.join(", ") || "unknown"}.`;
  if (required) {
    throw new Error(message);
  }
  console.log(message);
} else if (required && executed === 0) {
  throw new Error("PyRIT runtime was required but no attack item completed with runtimeUsed=pyrit.");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMethods(value: string | undefined): PyritAttackMethod[] | undefined {
  if (!value) return undefined;
  const methods = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean) as PyritAttackMethod[];
  return methods.length > 0 ? methods : undefined;
}
