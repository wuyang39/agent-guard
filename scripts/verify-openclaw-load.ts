import { execFile } from "node:child_process";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

type CliOptions = {
  apiBase: string;
  caseCounts: number[];
  pollMs: number;
  stageTimeoutMs: number;
  printPlan: boolean;
};

type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

function optionValue(args: string[], name: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseOptions(args: string[]): CliOptions {
  const rawCounts = optionValue(args, "--case-counts") ?? "5,30";
  const caseCounts = rawCounts.split(",").map((value) => positiveInteger(value.trim(), 0, "case count"));
  if (caseCounts.length === 0 || new Set(caseCounts).size !== caseCounts.length) {
    throw new Error("Case counts must be a non-empty unique list.");
  }
  if (caseCounts.some((count) => count > 120)) {
    throw new Error("OpenClaw load stages cannot exceed 120 cases.");
  }
  return {
    apiBase: optionValue(args, "--api-base") ?? "http://127.0.0.1:3100/api/v1",
    caseCounts,
    pollMs: positiveInteger(optionValue(args, "--poll-ms"), 5_000, "poll interval"),
    stageTimeoutMs: positiveInteger(
      optionValue(args, "--stage-timeout-ms"),
      4 * 60 * 60 * 1_000,
      "stage timeout",
    ),
    printPlan: args.includes("--print-plan"),
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(300_000),
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const envelope = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !envelope.ok || envelope.data === undefined) {
    throw new Error(
      `${envelope.error?.code ?? `HTTP_${response.status}`}: ${envelope.error?.message ?? "request failed"}`,
    );
  }
  return envelope.data;
}

async function assertNoResidualDockerResources(runGroupId: string): Promise<void> {
  for (const [kind, args] of [
    ["containers", ["ps", "-aq", "--no-trunc", "--filter", `label=agent-guard.run-group=${runGroupId}`]],
    ["networks", ["network", "ls", "-q", "--no-trunc", "--filter", `label=agent-guard.run-group=${runGroupId}`]],
  ] as const) {
    const result = await execFileAsync("docker", args, { windowsHide: true });
    if (result.stdout.trim()) {
      throw new Error(`Residual Docker ${kind} remain for ${runGroupId}.`);
    }
  }
}

async function appendEvidence(file: string, value: unknown): Promise<void> {
  await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...value as object })}\n`, "utf8");
}

async function runStage(input: {
  apiBase: string;
  caseCount: number;
  cliPath: string;
  pollMs: number;
  stageTimeoutMs: number;
  evidenceFile: string;
}): Promise<{ caseCount: number; selectionPlanId: string; runGroupId: string; durationMs: number }> {
  const startedAt = Date.now();
  const planData = await requestJson<{ plan: Record<string, unknown> }>(
    `${input.apiBase}/test-selection/plans`,
    {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: "mvp-1",
        agentId: "agent.openclaw.demo",
        targetProfile: "openclaw",
        selectionMode: "llm_assisted",
        maxCaseCount: input.caseCount,
        minCaseCount: input.caseCount,
        requiredAttackFamilies: ["prompt_injection", "data_leakage", "tool_hijack"],
        requiredTargetSurfaces: ["tool_call", "file_access"],
        includeExternalTools: true,
        adapterKind: "openclaw",
      }),
    },
  );
  const plan = planData.plan;
  const selectedCaseIds = Array.isArray(plan.selectedCaseIds) ? plan.selectedCaseIds : [];
  if (plan.status !== "ready" || selectedCaseIds.length !== input.caseCount) {
    throw new Error(`Selection plan did not return exactly ${input.caseCount} ready cases.`);
  }
  const selectionPlanId = String(plan.selectionPlanId);

  const runData = await requestJson<{ runGroup: Record<string, any> }>(
    `${input.apiBase}/test-runs/e2e?async=1`,
    {
      method: "POST",
      body: JSON.stringify({
        adapterKind: "openclaw",
        agent: {
          agentId: "agent.openclaw.demo",
          name: "OpenClaw CLI Agent",
          description: "Pinned Agent Guard OpenClaw fork",
        },
        connection: {
          cliPath: input.cliPath,
          launchMode: "external_running",
          timeoutMs: 180_000,
        },
        selectionPlanId,
        generateDefenseReport: false,
      }),
    },
  );
  let runGroup = runData.runGroup;
  const runGroupId = String(runGroup.runGroupId);
  await appendEvidence(input.evidenceFile, { event: "stage_started", caseCount: input.caseCount, selectionPlanId, runGroupId });
  console.log(`[${input.caseCount}] started ${runGroupId}`);

  let lastProgress = "";
  const deadline = Date.now() + input.stageTimeoutMs;
  while (!TERMINAL_STATUSES.has(String(runGroup.status))) {
    if (Date.now() >= deadline) {
      throw new Error(`${runGroupId} exceeded the ${input.stageTimeoutMs}ms stage timeout.`);
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollMs));
    const data = await requestJson<{ runGroup: Record<string, any> }>(
      `${input.apiBase}/test-runs/${encodeURIComponent(runGroupId)}`,
    );
    runGroup = data.runGroup;
    const snapshot = JSON.stringify({
      status: runGroup.status,
      phase: runGroup.phase,
      completed: runGroup.progress?.completedCases ?? 0,
      failed: runGroup.progress?.failedCases ?? 0,
      running: runGroup.progress?.runningCaseIds ?? [],
      coverage: runGroup.nativeGuardCoverage?.coverage,
      breaches: runGroup.nativeGuardCoverage?.coverageBreachCount ?? 0,
    });
    if (snapshot !== lastProgress) {
      lastProgress = snapshot;
      console.log(`[${input.caseCount}] ${snapshot}`);
      await appendEvidence(input.evidenceFile, { event: "progress", caseCount: input.caseCount, runGroupId, snapshot: JSON.parse(snapshot) });
    }
  }

  await appendEvidence(input.evidenceFile, { event: "stage_terminal", caseCount: input.caseCount, runGroupId, runGroup });
  await assertNoResidualDockerResources(runGroupId);
  if (runGroup.status !== "completed") {
    throw new Error(`${runGroupId} ended as ${runGroup.status}: ${runGroup.error ?? "unknown error"}`);
  }
  if (Number(runGroup.progress?.completedCases) !== input.caseCount) {
    throw new Error(`${runGroupId} completed count does not match ${input.caseCount}.`);
  }
  if (Number(runGroup.nativeGuardCoverage?.coverageBreachCount ?? 0) !== 0) {
    throw new Error(`${runGroupId} reported Native Guard coverage breaches.`);
  }
  if (Array.isArray(runGroup.nativeGuardCoverage?.runtimeFailures) && runGroup.nativeGuardCoverage.runtimeFailures.length > 0) {
    throw new Error(`${runGroupId} reported Native Guard runtime failures.`);
  }
  return { caseCount: input.caseCount, selectionPlanId, runGroupId, durationMs: Date.now() - startedAt };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.printPlan) {
    console.log(JSON.stringify({
      apiBase: options.apiBase,
      caseCounts: options.caseCounts,
      pollMs: options.pollMs,
      stageTimeoutMs: options.stageTimeoutMs,
      stopOnFailure: true,
      requireNoResidualDockerResources: true,
    }));
    return;
  }

  const repoRoot = path.resolve(import.meta.dirname, "..");
  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, "configs", "openclaw-distribution.json"), "utf8"),
  ) as { runtime: { forkDirectory: string } };
  const cliPath = process.env.OPENCLAW_CLI?.trim() || path.join(
    repoRoot,
    "outputs",
    manifest.runtime.forkDirectory,
    "openclaw.mjs",
  );
  const health = await requestJson<Record<string, unknown>>(`${options.apiBase}/system/status`);
  if (!health) throw new Error("Agent Guard API health check failed.");

  const evidenceDir = path.join(repoRoot, "outputs", "runs");
  await mkdir(evidenceDir, { recursive: true });
  const evidenceFile = path.join(
    evidenceDir,
    `portable-load-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.jsonl`,
  );
  const results = [];
  for (const caseCount of options.caseCounts) {
    results.push(await runStage({
      apiBase: options.apiBase,
      caseCount,
      cliPath,
      pollMs: options.pollMs,
      stageTimeoutMs: options.stageTimeoutMs,
      evidenceFile,
    }));
  }
  console.log(JSON.stringify({ ok: true, evidenceFile, stages: results }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
