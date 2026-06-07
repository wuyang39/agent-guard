/**
 * verify-full-pipeline.ts
 *
 * 全链路验证：Config 加载 → TestContext → Runner (Agent+Monitor+Sandbox) → Trace
 * 串通计划中的三个模块：Agent、Monitor、Sandbox
 */
import path from "node:path";
import fs from "node:fs";
import type {
  AgentUnderTest,
  AgentAdapterConfig,
  RiskLevel,
} from "@agent-guard/contracts";
import { loadTestContexts } from "../backend/src/modules/config/loadTestContext";
import { runTestCase } from "../backend/src/modules/runner/testRunner";
import { evaluateRisk } from "../backend/src/modules/risk/riskEvaluator";

const ROOT_DIR = path.resolve(process.cwd());
const CONFIGS_DIR = path.resolve(ROOT_DIR, "configs");
const TRACES_DIR = path.resolve(ROOT_DIR, "outputs", "traces");

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

async function main(): Promise<void> {
  const agent: AgentUnderTest = {
    schemaVersion: "mvp-1",
    agentId: "agent.demo",
    name: "Demo Agent",
    adapterType: "mock",
  };

  const adapterConfig: AgentAdapterConfig = {
    schemaVersion: "mvp-1",
    adapterId: "adapter.mock",
    agentId: "agent.demo",
    adapterType: "mock",
    timeoutMs: 30000,
  };

  // ============================================================
  // 第一步：用新的 Config 加载模块创建 TestContext
  // ============================================================
  console.log("=".repeat(60));
  console.log("Step 1: Loading configs via loadTestContexts()...");
  const { contexts, testOracles } = await loadTestContexts(CONFIGS_DIR, agent);

  console.log(`  Loaded ${contexts.length} TestContext(s)`);
  console.log(`  Loaded ${testOracles.length} TestOracle(s)`);
  assert(contexts.length > 0, "at least one TestContext loaded");
  assert(testOracles.length > 0, "at least one TestOracle loaded");

  for (const ctx of contexts) {
    console.log(`    - ${ctx.caseId}: ${ctx.caseName}`);
    console.log(`      sandbox: ${ctx.sandbox.tools.length} tools, ${ctx.sandbox.resources.length} resources`);
    console.log(`      riskRules: ${ctx.riskRules.length}`);
  }

  // ============================================================
  // 第二步：遍历每个 TestContext，送入 Runner 执行完整链路
  // ============================================================
  console.log(`\n${"=".repeat(60)}`);
  console.log("Step 2: Running full pipeline (Agent→Monitor→Sandbox→Trace)...\n");

  const allEventTypes = new Set<string>();
  let totalEvents = 0;
  let allTraces: Awaited<ReturnType<typeof runTestCase>>[] = [];
  const evaluationsByCaseId = new Map<string, ReturnType<typeof evaluateRisk>>();

  for (const context of contexts) {
    console.log(`--- Running: ${context.caseId} (${context.caseName}) ---`);

    const { testRun, trace } = await runTestCase(agent, adapterConfig, context);

    // 验证 Run 状态
    assert(
      testRun.status === "completed",
      `testRun.status=${testRun.status}, expected=completed`,
    );
    assert(testRun.runId.startsWith("run."), "runId format");
    assert(testRun.startedAt !== undefined, "startedAt set");
    assert(testRun.endedAt !== undefined, "endedAt set");

    // 验证 Trace
    assert(trace.traceId.startsWith("trace."), "traceId format");
    assert(trace.events.length > 0, "trace has events");
    assert(trace.status === "completed", "trace status=completed");

    const evaluation = evaluateRisk(context, trace);
    evaluationsByCaseId.set(context.caseId, evaluation);

    // 统计事件类型
    for (const e of trace.events) {
      allEventTypes.add(e.type);
    }

    // 验证 tool_call → tool_result 配对
    const toolCalls = trace.events.filter((e) => e.type === "tool_call");
    const toolResults = trace.events.filter((e) => e.type === "tool_result");
    for (const tc of toolCalls) {
      const callId = (tc.payload as Record<string, unknown>).callId;
      const match = toolResults.find(
        (tr) => (tr.payload as Record<string, unknown>).callId === callId,
      );
      assert(!!match, `tool_result matches tool_call callId=${callId}`);
    }

    const eventTypes = [...new Set(trace.events.map((e) => e.type))];
    console.log(`  Events: ${trace.events.length}, Types: ${eventTypes.join(", ")}`);
    console.log(`  Findings: ${evaluation.findings.length}, Risk: ${evaluation.riskLevel}`);
    console.log(`  Status: ${testRun.status}`);
    totalEvents += trace.events.length;
    allTraces.push({ testRun, trace });

    // 写出 Trace 文件
    fs.mkdirSync(TRACES_DIR, { recursive: true });
    const traceFile = path.join(
      TRACES_DIR,
      `${context.caseId}-trace_${trace.traceId}.json`,
    );
    fs.writeFileSync(traceFile, JSON.stringify(trace, null, 2), "utf-8");
    console.log(`  Trace saved: ${traceFile}`);
  }

  // ============================================================
  // 第三步：汇总验证
  // ============================================================
  console.log(`\n${"=".repeat(60)}`);
  console.log("Step 3: Summary\n");
  console.log(`Total test runs: ${allTraces.length}`);
  console.log(`Total events: ${totalEvents}`);
  console.log(`Event types covered: ${[...allEventTypes].sort().join(", ")}`);

  const expectedTypes = [
    "test_started",
    "task_sent",
    "agent_message",
    "tool_call",
    "tool_result",
    "resource_access",
    "prompt_load",
    "system_error",
  ];
  const covered = expectedTypes.filter((t) => allEventTypes.has(t));
  const missing = expectedTypes.filter((t) => !allEventTypes.has(t));
  console.log(`Covered ${covered.length}/${expectedTypes.length} event types`);
  if (missing.length > 0) {
    console.log(`Missing: ${missing.join(", ")} (acceptable for P0 — only triggered on error paths)`);
  }

  // 验证与 TestOracle 的对照（离线比对能力）
  console.log(`\nTestOracle cross-check:`);
  for (const oracle of testOracles) {
    const runResult = allTraces.find(
      (t) => t.testRun.caseId === oracle.caseId,
    );
    const evaluation = evaluationsByCaseId.get(oracle.caseId);
    assert(!!runResult, `trace exists for oracle case ${oracle.caseId}`);
    assert(!!evaluation, `risk evaluation exists for oracle case ${oracle.caseId}`);

    const findingCategories = new Set(
      evaluation.findings.map((finding) => finding.category),
    );
    const observedToolIds = new Set(
      runResult.trace.events
        .filter((event) => event.type === "tool_call")
        .map((event) => (event.payload as Record<string, unknown>).toolId)
        .filter((toolId): toolId is string => typeof toolId === "string"),
    );

    if (oracle.expectedOutcome.shouldTriggerFinding) {
      assert(
        evaluation.findings.length > 0,
        `${oracle.caseId} should trigger at least one finding`,
      );
    }
    for (const category of oracle.expectedOutcome.expectedRiskCategories) {
      assert(
        findingCategories.has(category),
        `${oracle.caseId} should trigger category ${category}`,
      );
    }
    for (const toolId of oracle.expectedOutcome.expectedToolIds) {
      assert(
        observedToolIds.has(toolId),
        `${oracle.caseId} should call expected tool ${toolId}`,
      );
    }
    assert(
      riskRank[evaluation.riskLevel] >= riskRank[oracle.expectedOutcome.expectedRiskLevel],
      `${oracle.caseId} risk level ${evaluation.riskLevel} should cover expected ${oracle.expectedOutcome.expectedRiskLevel}`,
    );

    console.log(
      `  ${oracle.caseId}: expectedFinding=${oracle.expectedOutcome.shouldTriggerFinding}, ` +
        `traceStatus=${runResult.trace.status}, findings=${evaluation.findings.length}, risk=${evaluation.riskLevel}`,
    );
  }

  console.log("\n✅ PASS: Full pipeline verification (Config→Runner→Trace→Risk)");
}

main().catch((err) => {
  console.error("❌ FAIL:", err instanceof Error ? err.message : String(err));
  console.error(err instanceof Error && err.stack ? err.stack : "");
  process.exit(1);
});
