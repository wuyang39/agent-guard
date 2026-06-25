/**
 * verify-p3-b-test-selection.ts — P3-B test selection verification.
 */

import type { FastifyInstance } from "fastify";
import type {
  CandidateCaseCard,
  TestSelectionPlan,
} from "@agent-guard/contracts";
import { buildApp } from "../backend/src/app";
import { rerankCasesWithLlm } from "../backend/src/modules/runner/llmAssistedCaseReranker";
import { createSelectionPlan } from "../backend/src/modules/runner/testSelectionService";
import type { LlmClient, LlmJsonResponse } from "../backend/src/modules/llm/llmClient";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function injectJson(
  app: FastifyInstance,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method,
    url,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const parsed = JSON.parse(res.body) as Record<string, unknown>;
  if (res.statusCode >= 400) {
    throw new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

function ok(value: Record<string, unknown>): void {
  assert(value.ok === true, `expected ok:true, got ${JSON.stringify(value).slice(0, 200)}`);
}

function dataRecord(value: Record<string, unknown>): Record<string, unknown> {
  ok(value);
  assert(typeof value.data === "object" && value.data !== null, "response data missing");
  return value.data as Record<string, unknown>;
}

async function main(): Promise<void> {
  process.env.AGENT_GUARD_LLM_ENABLED = "1";
  process.env.AGENT_GUARD_LLM_MODE = "mock";
  process.env.AGENT_GUARD_LLM_MODEL = "mock-test-selector";
  process.env.AGENT_GUARD_ASK_TIMEOUT = "demo_approve";
  process.env.AGENT_GUARD_ASK_TIMEOUT_MS = "1000";

  console.log("P3-B Test Selection Verification");

  const app = await buildApp({ logger: false });
  await app.ready();
  let passed = 0;

  try {
    const ruleResp = await injectJson(app, "POST", "/api/v1/test-selection/plans", {
      schemaVersion: "mvp-1",
      agentId: "agent.verify.selection",
      targetProfile: "openclaw",
      selectionMode: "rule_only",
      maxCaseCount: 3,
      minCaseCount: 3,
      requiredAttackFamilies: ["prompt_injection", "data_leakage", "tool_hijack"],
      adapterKind: "mock",
    });
    const rulePlan = dataRecord(ruleResp).plan as TestSelectionPlan;
    assert(rulePlan.status === "ready", `rule plan should be ready, got ${rulePlan.status}`);
    assert(
      rulePlan.corpusManifestId === "corpus.p3_a.generated",
      `rule plan should use A-line generated corpus, got ${rulePlan.corpusManifestId}`,
    );
    assert(rulePlan.selectedCaseIds.length >= 3, "rule plan selected too few cases");
    assert(
      rulePlan.selectedCaseIds.some((caseId) => caseId.startsWith("case.generated.")),
      "rule plan should select generated A-line cases",
    );
    assert(rulePlan.coverageSnapshot.attackFamilyCount >= 3, "rule plan missing attack family coverage");
    assert(rulePlan.selectionRunSummary.ready === true, "selection run summary should be ready");
    assert(rulePlan.evalStyleResult.status === "ready", "eval-style result should be ready");
    assert(
      rulePlan.evalStyleResult.passedChecks.includes("required_attack_families_covered"),
      "eval-style required attack family check missing",
    );
    console.log(`1. rule-only plan ok (${rulePlan.selectionPlanId})`);
    passed++;

    const getRuleResp = await injectJson(
      app,
      "GET",
      `/api/v1/test-selection/plans/${rulePlan.selectionPlanId}`,
    );
    const fetchedRulePlan = dataRecord(getRuleResp).plan as TestSelectionPlan;
    assert(
      fetchedRulePlan.selectionPlanId === rulePlan.selectionPlanId,
      "GET selection plan id mismatch",
    );
    console.log("2. selection plan query ok");
    passed++;

    await verifyInvalidManifestRejected(app);
    console.log("3. invalid manifestId rejection ok");
    passed++;

    const llmResp = await injectJson(app, "POST", "/api/v1/test-selection/plans", {
      schemaVersion: "mvp-1",
      agentId: "agent.verify.selection",
      targetProfile: "openclaw",
      selectionMode: "llm_assisted",
      maxCaseCount: 3,
      minCaseCount: 3,
      requiredAttackFamilies: ["prompt_injection", "data_leakage", "tool_hijack"],
      adapterKind: "mock",
    });
    const llmPlan = dataRecord(llmResp).plan as TestSelectionPlan;
    assert(llmPlan.status === "ready", `LLM plan should be ready, got ${llmPlan.status}`);
    assert(llmPlan.llmAudit?.enabled === true, "LLM audit missing");
    assert(llmPlan.llmAudit.provider === "mock", "LLM provider should be mock");
    assert(llmPlan.coverageSnapshot.attackFamilyCount >= 3, "LLM plan missing coverage");
    console.log(`4. mock LLM-assisted plan ok (${llmPlan.selectionPlanId})`);
    passed++;

    const expandedLlmResp = await injectJson(app, "POST", "/api/v1/test-selection/plans", {
      schemaVersion: "mvp-1",
      agentId: "agent.verify.selection.expanded",
      targetProfile: "openclaw",
      selectionMode: "llm_assisted",
      requiredAttackFamilies: ["prompt_injection", "data_leakage", "tool_hijack"],
      adapterKind: "mock",
    });
    const expandedLlmPlan = dataRecord(expandedLlmResp).plan as TestSelectionPlan;
    assert(
      expandedLlmPlan.requestedCaseCount >= 80,
      `default LLM-assisted openclaw plan should request a larger set, got ${expandedLlmPlan.requestedCaseCount}`,
    );
    assert(
      expandedLlmPlan.selectedCaseIds.length >= 30,
      `expanded LLM plan selected too few cases: ${expandedLlmPlan.selectedCaseIds.length}`,
    );
    assert(
      (expandedLlmPlan.llmAudit?.candidatePoolSize ?? 0) >= expandedLlmPlan.selectedCaseIds.length,
      "LLM audit should record candidate pool size",
    );
    assert(
      (expandedLlmPlan.llmAudit?.qualityHints?.length ?? 0) > 0,
      "LLM audit should record quality hints",
    );
    console.log(`4b. expanded LLM-assisted defaults ok (${expandedLlmPlan.selectedCaseIds.length} cases)`);
    passed++;

    const fullCorpusResp = await injectJson(app, "POST", "/api/v1/test-selection/plans", {
      schemaVersion: "mvp-1",
      agentId: "agent.verify.selection.full_corpus",
      targetProfile: "full-corpus",
      selectionMode: "llm_assisted",
      requiredAttackFamilies: [
        "prompt_injection",
        "data_leakage",
        "tool_hijack",
        "auth_bypass",
        "dangerous_action",
        "model_evasion",
        "memory_poisoning",
      ],
      requiredTargetSurfaces: ["tool_call", "file_access", "api", "network", "memory", "output"],
      includeExternalTools: true,
      adapterKind: "openclaw",
    });
    const fullCorpusPlan = dataRecord(fullCorpusResp).plan as TestSelectionPlan;
    assert(
      fullCorpusPlan.selectionRunSummary.candidateCaseCount >= 2000,
      `full-corpus plan should see the large A-line pool, got ${fullCorpusPlan.selectionRunSummary.candidateCaseCount}`,
    );
    assert(
      fullCorpusPlan.requestedCaseCount >= 300,
      `full-corpus LLM plan should request hundreds of cases, got ${fullCorpusPlan.requestedCaseCount}`,
    );
    assert(
      fullCorpusPlan.selectedCaseIds.length >= 300,
      `full-corpus plan selected too few cases: ${fullCorpusPlan.selectedCaseIds.length}`,
    );
    assert(
      (fullCorpusPlan.llmAudit?.llmSeedCaseCount ?? 0) > 0,
      "LLM audit should record seed case count",
    );
    assert(
      (fullCorpusPlan.llmAudit?.llmSeedCaseCount ?? 0) < fullCorpusPlan.requestedCaseCount,
      "LLM should return a compact seed set, not the full requested case count",
    );
    assert(
      fullCorpusPlan.selectionRunSummary.llmAcceptedCount <=
        (fullCorpusPlan.llmAudit?.llmSeedCaseCount ?? 0),
      "LLM accepted case count should stay within the seed limit",
    );
    assert(
      (fullCorpusPlan.llmAudit?.llmCandidatePoolSize ?? 0) >=
        (fullCorpusPlan.llmAudit?.llmSeedCaseCount ?? 0),
      "LLM shortlist should be at least as large as the seed case count",
    );
    assert(
      (fullCorpusPlan.llmAudit?.ignoredOverLimitCount ?? 0) > 0,
      "mock LLM should return more ids than the seed limit and audit ignored over-limit ids",
    );
    console.log(
      `4c. full-corpus LLM-assisted plan ok (${fullCorpusPlan.selectedCaseIds.length}/${fullCorpusPlan.selectionRunSummary.candidateCaseCount} cases)`,
    );
    passed++;

    await verifyInvalidLlmCaseIdRejected();
    console.log("5. invalid LLM caseId rejection ok");
    passed++;

    await verifyLlmCoverageFallback();
    console.log("6. LLM coverage fallback to rule-only ok");
    passed++;

    const budgetPlan = await createSelectionPlan({
      schemaVersion: "mvp-1",
      agentId: "agent.verify.budget",
      targetProfile: "openclaw",
      selectionMode: "rule_only",
      maxCaseCount: 7,
      minCaseCount: 3,
      timeBudgetMs: 20_000,
      requiredAttackFamilies: ["prompt_injection", "data_leakage", "tool_hijack"],
    });
    assert(budgetPlan.status === "draft", "insufficient time budget should produce a draft plan");
    assert(budgetPlan.selectedCaseIds.length <= 2, "time budget should limit selected cases");
    console.log("7. time budget enforcement ok");
    passed++;

    const runResp = await injectJson(app, "POST", "/api/v1/test-runs/e2e", {
      adapterKind: "mock",
      agent: { agentId: "agent.verify.selection", name: "P3-B Selection Mock" },
      selectionPlanId: rulePlan.selectionPlanId,
      generateDefenseReport: false,
    });
    const runData = dataRecord(runResp);
    const runGroup = runData.runGroup as Record<string, unknown>;
    assert(runGroup.selectionPlanId === rulePlan.selectionPlanId, "runGroup selectionPlanId missing");
    assert(runGroup.agentId === rulePlan.agentId, "runGroup agentId should match selection plan");
    const progress = runGroup.progress as Record<string, unknown>;
    assert(progress && typeof progress === "object", "runGroup progress missing");
    assert(
      progress.totalCases === rulePlan.selectedCaseIds.length,
      "runGroup progress totalCases should match selection plan",
    );
    assert(progress.completedCases === rulePlan.selectedCaseIds.length, "runGroup progress completedCases mismatch");
    assert(progress.percent === 100, "runGroup progress should reach 100 percent");
    assert(
      sameStringSet(runGroup.caseIds as string[], rulePlan.selectedCaseIds),
      "runGroup caseIds should match selection plan",
    );
    assert(Array.isArray(runGroup.traceIds) && runGroup.traceIds.length > 0, "traceIds missing");
    const traceResp = await injectJson(
      app,
      "GET",
      `/api/v1/traces/${(runGroup.traceIds as string[])[0]}`,
    );
    const trace = dataRecord(traceResp).trace as Record<string, unknown>;
    assert(
      trace.selectionPlanId === rulePlan.selectionPlanId,
      "trace selectionPlanId should match selection plan",
    );
    console.log(`8. selectionPlanId -> e2e run + trace ok (${runGroup.runGroupId})`);
    passed++;

    const dashboardResp = await injectJson(app, "GET", "/api/v1/dashboard/summary");
    const latestRunGroup = dataRecord(dashboardResp).latestRunGroup as Record<string, unknown>;
    assert(
      latestRunGroup.selectionPlanId === rulePlan.selectionPlanId,
      "dashboard latestRunGroup selectionPlanId should match selection plan",
    );
    console.log("9. dashboard selectionPlanId linkage ok");
    passed++;

    assert(typeof runGroup.policyPackId === "string", "runGroup policyPackId missing");
    const reuseResp = await injectJson(app, "POST", "/api/v1/test-runs/e2e", {
      adapterKind: "mock",
      agent: { agentId: "agent.verify.selection", name: "P3-B Reuse Policy Mock" },
      reusePolicyPackId: runGroup.policyPackId,
      caseIds: rulePlan.selectedCaseIds.slice(0, 2),
      generateDefenseReport: true,
    });
    const reuseRunGroup = dataRecord(reuseResp).runGroup as Record<string, unknown>;
    assert(
      reuseRunGroup.policyPackId === runGroup.policyPackId,
      "reused run should keep source policyPackId",
    );
    assert(
      Array.isArray(reuseRunGroup.riskReportIds) && reuseRunGroup.riskReportIds.length === 0,
      "reused policy run should skip detection risk reports",
    );
    assert(
      Array.isArray(reuseRunGroup.runtimeSessionIds) &&
        reuseRunGroup.runtimeSessionIds.length === 2,
      "reused policy run should supervise requested cases",
    );
    assert(
      typeof reuseRunGroup.defenseReportId === "string",
      "reused policy run should generate defense report",
    );
    console.log(`8b. reusable policyPackId supervision ok (${reuseRunGroup.runGroupId})`);
    passed++;

    await verifyInvalidReusablePolicyRejected(app);
    console.log("8c. invalid reusable policyPackId rejection ok");
    passed++;

    const getCompletedPlan = await injectJson(
      app,
      "GET",
      `/api/v1/test-selection/plans/${rulePlan.selectionPlanId}`,
    );
    const completedPlan = dataRecord(getCompletedPlan).plan as TestSelectionPlan;
    assert(completedPlan.status === "completed", "selection plan should be completed after run");
    assert(
      completedPlan.runGroupIds?.includes(runGroup.runGroupId as string),
      "selection plan should record runGroupId",
    );
    console.log("10. selection plan status linkage ok");
    passed++;

    const asyncInvalid = await injectJson(
      app,
      "POST",
      "/api/v1/test-runs/e2e?async=true",
      {
        adapterKind: "mock",
        agent: { name: "P3-B Invalid Async Selection" },
        selectionPlanId: "selection_plan.missing",
        generateDefenseReport: false,
      },
    );
    const asyncRunGroup = dataRecord(asyncInvalid).runGroup as Record<string, unknown>;
    const failedAsyncRun = await waitForRunStatus(
      app,
      asyncRunGroup.runGroupId as string,
      "failed",
    );
    assert(failedAsyncRun.status === "failed", "invalid async selection should fail runGroup");
    console.log("11. invalid async selection failure state ok");
    passed++;

    console.log(`\nP3-B TEST SELECTION VERIFIED (${passed} passed)`);
  } finally {
    await app.close();
  }
}

async function verifyInvalidManifestRejected(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/test-selection/plans",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      schemaVersion: "mvp-1",
      agentId: "agent.verify.selection",
      manifestId: "corpus.manifest.does_not_exist",
      targetProfile: "openclaw",
      selectionMode: "rule_only",
      maxCaseCount: 3,
      minCaseCount: 3,
    }),
  });
  const parsed = JSON.parse(res.body) as Record<string, unknown>;
  assert(res.statusCode === 400, `invalid manifest should return 400, got ${res.statusCode}`);
  assert(parsed.ok === false, "invalid manifest response should be failure");
  assert(
    parsed.error &&
      typeof parsed.error === "object" &&
      (parsed.error as Record<string, unknown>).code === "CANDIDATE_CASE_LOAD_FAILED",
    "invalid manifest should return CANDIDATE_CASE_LOAD_FAILED",
  );
}

async function verifyInvalidReusablePolicyRejected(app: FastifyInstance): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/test-runs/e2e",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      adapterKind: "mock",
      agent: { name: "P3-B Missing Reuse Policy" },
      reusePolicyPackId: "policy_pack.missing",
      caseIds: ["case.resource_injection"],
      generateDefenseReport: false,
    }),
  });
  const parsed = JSON.parse(res.body) as Record<string, unknown>;
  assert(res.statusCode === 400, `invalid reuse policy should return 400, got ${res.statusCode}`);
  assert(parsed.ok === false, "invalid reuse policy response should be failure");
  assert(
    parsed.error &&
      typeof parsed.error === "object" &&
      (parsed.error as Record<string, unknown>).code === "INVALID_POLICY_PACK",
    "invalid reuse policy should return INVALID_POLICY_PACK",
  );
}

async function verifyLlmCoverageFallback(): Promise<void> {
  const narrowClient: LlmClient = {
    async completeJson(): Promise<LlmJsonResponse> {
      return {
        provider: "narrow_mock",
        model: "narrow",
        json: {
          rankedCaseIds: [
            "case.resource_injection",
            "case.tool_response_injection",
            "case.indirect_prompt_injection_marker",
          ],
          selectionReasons: [],
        },
      };
    },
  };
  const plan = await createSelectionPlan(
    {
      schemaVersion: "mvp-1",
      agentId: "agent.verify.fallback",
      targetProfile: "openclaw",
      selectionMode: "llm_assisted",
      maxCaseCount: 3,
      minCaseCount: 3,
      requiredAttackFamilies: [
        "data_leakage",
        "auth_bypass",
        "memory_poisoning",
      ],
    },
    { llmClient: narrowClient },
  );
  assert(plan.status === "ready", "rule fallback should restore ready coverage");
  assert(plan.llmAudit?.fallbackUsed === true, "LLM coverage fallback should be audited");
  assert(
    plan.coverageSnapshot.missingRequiredAttackFamilies.length === 0,
    "rule fallback should cover required attack families",
  );
}

async function waitForRunStatus(
  app: FastifyInstance,
  runGroupId: string,
  expectedStatus: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await injectJson(app, "GET", `/api/v1/test-runs/${runGroupId}`);
    const runGroup = dataRecord(response).runGroup as Record<string, unknown>;
    if (runGroup.status === expectedStatus) return runGroup;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`runGroup ${runGroupId} did not reach ${expectedStatus}`);
}

function sameStringSet(a: string[], b: string[]): boolean {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

async function verifyInvalidLlmCaseIdRejected(): Promise<void> {
  const candidates: CandidateCaseCard[] = [
    {
      schemaVersion: "mvp-1",
      caseId: "case.valid",
      caseName: "Valid case",
      enabled: true,
      runProfiles: ["openclaw"],
      attackFamilies: ["prompt_injection"],
      targetSurfaces: ["tool_call"],
      targetToolHints: ["tool.read_file"],
      sensitivityTags: [],
      sourceOrigin: "derived",
      qualityScore: 0.8,
    },
  ];
  const badClient: LlmClient = {
    async completeJson(): Promise<LlmJsonResponse> {
      return {
        provider: "bad_mock",
        model: "bad",
        json: {
          rankedCaseIds: ["case.valid", "case.missing"],
          selectionReasons: [
            { caseId: "case.valid", reason: "valid" },
            { caseId: "case.missing", reason: "invalid" },
          ],
        },
      };
    },
  };

  const result = await rerankCasesWithLlm(
    candidates,
    ["case.valid"],
    {
      schemaVersion: "mvp-1",
      targetProfile: "openclaw",
      selectionMode: "llm_assisted",
      maxCaseCount: 2,
      minCaseCount: 1,
      requiredAttackFamilies: ["prompt_injection"],
    },
    badClient,
  );

  assert(result.selectedCaseIds.includes("case.valid"), "valid case should be accepted");
  assert(!result.selectedCaseIds.includes("case.missing"), "invalid case should be rejected");
  assert(result.audit.rejectedCaseIds.includes("case.missing"), "invalid case should be audited");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
