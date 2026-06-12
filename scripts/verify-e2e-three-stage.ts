/**
 * verify-e2e-three-stage.ts
 *
 * 真·全链路端到端验证：三阶段数据从头流到尾，无 mock 数据。
 *
 * 阶段 1 (监督前检测):
 *   Config → TestContext → Runner (Agent+Monitor+Sandbox) → Trace
 *   → RiskEvaluation → RiskReport (全部真实运行数据)
 *
 * 阶段 2 (策略包生成 + 运行时监督):
 *   RiskReport[] → DetectionReport → AgentRiskProfile → SupervisionPolicyPack
 *   → 二次运行 Runner (带 PolicyPack) → RuntimeSupervisionRecord[] (真实监督记录)
 *
 * B-4 ask 通道: 验证脚本默认使用 demo_approve + 短超时，
 * 避免在没有前端接入时 hang 在人工确认。
 * 正式运行可通过 AGENT_GUARD_ASK_TIMEOUT 环境变量覆盖。
 *
 * 阶段 3 (防御报告):
 *   DetectionReport + RiskProfile + PolicyPack + RuntimeSupervisionRecord[]
 *   → DefenseReport → JSON + HTML 导出
 */

import path from "node:path";
import fs from "node:fs";
import type {
  AgentUnderTest,
  AgentAdapterConfig,
  RiskLevel,
  RiskReport,
} from "@agent-guard/contracts";
import { loadTestContexts } from "../backend/src/modules/config/loadTestContext";
import { runTestCase } from "../backend/src/modules/runner/testRunner";
import { evaluateRisk } from "../backend/src/modules/risk/riskEvaluator";
import { buildRiskReport } from "../backend/src/modules/report/reportBuilder";
import { buildDetectionReport } from "../backend/src/modules/detection/detectionReportBuilder";
import { buildAgentRiskProfile } from "../backend/src/modules/detection/agentRiskProfileBuilder";
import { buildSupervisionPolicyPack } from "../backend/src/modules/policy/policyPackBuilder";
import { buildDefenseReport } from "../backend/src/modules/defense/defenseReportBuilder";
import {
  exportDefenseJsonReport,
  exportDefenseHtmlReport,
} from "../backend/src/modules/defense/defenseReportExporter";

const ROOT_DIR = path.resolve(process.cwd());
const CONFIGS_DIR = path.resolve(ROOT_DIR, "configs");
const OUTPUT_DIR = path.resolve(ROOT_DIR, "outputs", "reports", "e2e");

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`❌ Assertion failed: ${message}`);
  }
}

const riskRank: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

async function main(): Promise<void> {
  // B-4 ask 通道: 验证脚本默认 demo_approve + 短超时
  if (!process.env.AGENT_GUARD_ASK_TIMEOUT) process.env.AGENT_GUARD_ASK_TIMEOUT = "demo_approve";
  if (!process.env.AGENT_GUARD_ASK_TIMEOUT_MS) process.env.AGENT_GUARD_ASK_TIMEOUT_MS = "5000";
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

  // ================================================================
  // 阶段 1: 监督前检测 — 加载配置，运行全链路，产出 RiskReport[]
  // ================================================================
  console.log("=".repeat(65));
  console.log("STAGE 1: Pre-Supervision Detection");
  console.log("=".repeat(65));

  const { contexts, testOracles } = await loadTestContexts(CONFIGS_DIR, agent);
  console.log(`Loaded ${contexts.length} TestContext(s), ${testOracles.length} TestOracle(s)\n`);

  const riskReports: RiskReport[] = [];
  let totalEvents = 0;
  const allEventTypes = new Set<string>();

  for (const context of contexts) {
    console.log(`  [Detect] Running: ${context.caseId} (${context.caseName})`);

    const { testRun, trace } = await runTestCase(agent, adapterConfig, context);

    assert(testRun.status === "completed", `${context.caseId}: status=${testRun.status}`);
    assert(trace.events.length > 0, `${context.caseId}: trace has events`);

    const evaluation = evaluateRisk(context, trace);
    const riskReport = buildRiskReport(context, evaluation, trace);
    riskReports.push(riskReport);

    for (const e of trace.events) {
      allEventTypes.add(e.type);
    }
    totalEvents += trace.events.length;

    console.log(
      `    → events=${trace.events.length}, findings=${evaluation.findings.length}, risk=${evaluation.riskLevel}`,
    );
  }

  console.log(
    `\n  Stage 1 Summary: ${riskReports.length} RiskReports, ${totalEvents} events, ` +
    `types=[${[...allEventTypes].sort().join(", ")}]`,
  );
  assert(riskReports.length === contexts.length, "one RiskReport per TestContext");

  // Oracle 交叉验证
  for (const oracle of testOracles) {
    const report = riskReports.find((r) => r.caseId === oracle.caseId);
    assert(!!report, `RiskReport exists for oracle ${oracle.caseId}`);

    if (oracle.expectedOutcome.shouldTriggerFinding) {
      assert(report.findings.length > 0, `${oracle.caseId}: should trigger findings`);
    }

    const actualRisk = riskRank[report.riskLevel];
    const expectedRisk = riskRank[oracle.expectedOutcome.expectedRiskLevel];
    assert(
      actualRisk >= expectedRisk,
      `${oracle.caseId}: risk ${report.riskLevel} >= ${oracle.expectedOutcome.expectedRiskLevel}`,
    );
  }
  console.log("  ✅ All oracles verified\n");

  // ================================================================
  // 阶段 2: 检测报告 → 风险画像 → 策略包 → 二次运行监督
  // ================================================================
  console.log("=".repeat(65));
  console.log("STAGE 2: Detection Report → Risk Profile → Policy Pack → Supervised Run");
  console.log("=".repeat(65));

  // 2a. 用阶段 1 的真实 RiskReport 构建 DetectionReport
  const detectionReport = buildDetectionReport({
    agentId: agent.agentId,
    riskReports,
  });
  console.log(
    `\n  DetectionReport: ${detectionReport.reportId}`,
  );
  console.log(
    `    sourceRiskReports: [${detectionReport.sourceRiskReportIds.join(", ")}]`,
  );
  console.log(
    `    scenarios: ${detectionReport.riskSummary.totalScenarios} total, ${detectionReport.riskSummary.failedScenarioCount} failed`,
  );
  console.log(
    `    findings: ${detectionReport.riskSummary.totalFindings}, highestRisk=${detectionReport.riskSummary.highestRiskLevel}`,
  );
  assert(
    detectionReport.sourceRiskReportIds.length === riskReports.length,
    "DetectionReport traces all RiskReports",
  );

  // 2b. 构建 AgentRiskProfile
  const riskProfile = buildAgentRiskProfile(detectionReport, riskReports);
  console.log(
    `\n  AgentRiskProfile: ${riskProfile.profileId}`,
  );
  console.log(`    weaknesses: ${riskProfile.weaknesses.length}`);
  for (const w of riskProfile.weaknesses) {
    console.log(`      - ${w.category}: ${w.title} (findings: ${w.sourceFindingIds.length})`);
  }
  console.log(`    confidence: ${riskProfile.confidence}`);
  assert(
    riskProfile.sourceDetectionReportId === detectionReport.reportId,
    "RiskProfile traces DetectionReport",
  );

  // 2c. 生成 SupervisionPolicyPack
  const policyPack = buildSupervisionPolicyPack(riskProfile);
  console.log(
    `\n  SupervisionPolicyPack: ${policyPack.policyPackId}`,
  );
  console.log(`    policies: ${policyPack.policies.length}`);
  for (const p of policyPack.policies) {
    console.log(`      - ${p.policyId}: ${p.action} ${p.targetType} (${p.riskLevel}) — ${p.name}`);
  }
  assert(
    policyPack.sourceRiskProfileId === riskProfile.profileId,
    "PolicyPack traces RiskProfile",
  );
  assert(policyPack.policies.length > 0, "PolicyPack has policies");

  // 2d. 二次运行：带 PolicyPack 的监督运行 → 产出真实 RuntimeSupervisionRecord[]
  console.log(`\n  --- Supervised Re-Run (with PolicyPack) ---\n`);

  const allSupervisionRecords: Awaited<
    ReturnType<typeof runTestCase>
  >["supervisionRecords"] = [];

  for (const context of contexts) {
    console.log(`  [Supervise] Running: ${context.caseId}`);

    const { testRun, trace, supervisionRecords } = await runTestCase(
      agent,
      adapterConfig,
      context,
      {
        supervisionPolicyPack: policyPack,
        runtimeSessionId: `session.e2e.${context.caseId}`,
      },
    );

    allSupervisionRecords.push(...supervisionRecords);

    const blockedCount = supervisionRecords.filter(
      (r) => r.action === "deny",
    ).length;
    const actions = [
      ...new Set(supervisionRecords.map((r) => r.action)),
    ].sort();

    console.log(
      `    → status=${testRun.status}, events=${trace.events.length}, ` +
      `supervision=${supervisionRecords.length} (${actions.join("/") || "none"}), blocked=${blockedCount}`,
    );
  }

  console.log(
    `\n  Stage 2 Summary: ${allSupervisionRecords.length} runtime supervision records`,
  );
  assert(
    allSupervisionRecords.length > 0,
    "At least one supervision record from real supervised run",
  );

  // ================================================================
  // 阶段 3: 防御报告 — 汇总三阶段证据，证明闭环
  // ================================================================
  console.log(`\n${"=".repeat(65)}`);
  console.log("STAGE 3: Defense Report");
  console.log("=".repeat(65));

  const defenseReport = buildDefenseReport({
    detectionReport,
    riskProfile,
    policyPack,
    runtimeRecords: allSupervisionRecords,
  });

  console.log(`\n  DefenseReport: ${defenseReport.defenseReportId}`);
  console.log(`  Traceability:`);
  console.log(`    detectionReport  → ${defenseReport.detectionReportId}`);
  console.log(`    riskProfile      → ${defenseReport.riskProfileId}`);
  console.log(`    policyPack       → ${defenseReport.policyPackId}`);
  console.log(`    runtimeSessions  → [${defenseReport.runtimeSessionIds.join(", ")}]`);
  console.log(`\n  Effectiveness:`);
  console.log(`    blockedHighRisk  = ${defenseReport.defenseEffectiveness.blockedHighRiskActionCount}`);
  console.log(`    alerts           = ${defenseReport.defenseEffectiveness.alertedActionCount}`);
  console.log(`    redactions       = ${defenseReport.defenseEffectiveness.redactedActionCount}`);
  console.log(`    askDecisions     = ${defenseReport.defenseEffectiveness.askDecisionCount}`);
  console.log(`    mitigatedWeaknessIds = [${defenseReport.defenseEffectiveness.mitigatedWeaknessIds.join(", ")}]`);
  console.log(`\n  Blocked Actions: ${defenseReport.blockedActions.length}`);
  for (const ba of defenseReport.blockedActions) {
    console.log(`    - ${ba.targetType}/${ba.targetId}: ${ba.reason}`);
  }
  console.log(`\n  Residual Risk: ${defenseReport.residualRisk.length}`);
  for (const rr of defenseReport.residualRisk) {
    console.log(`    - ${rr.category} (${rr.riskLevel}): ${rr.description}`);
  }

  // 关键断言：防御闭环
  assert(
    defenseReport.blockedActions.length > 0,
    "DefenseReport contains blocked actions from real supervision",
  );
  assert(
    defenseReport.defenseEffectiveness.blockedHighRiskActionCount > 0,
    "At least one high-risk action blocked",
  );

  // ================================================================
  // 导出报告
  // ================================================================
  console.log(`\n${"=".repeat(65)}`);
  console.log("EXPORT: Reports");
  console.log("=".repeat(65));

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const jsonArtifact = await exportDefenseJsonReport(
    defenseReport,
    path.join(OUTPUT_DIR, "defense-report.json"),
  );
  console.log(`\n  JSON → ${jsonArtifact.path}`);

  const htmlArtifact = await exportDefenseHtmlReport(
    defenseReport,
    path.join(OUTPUT_DIR, "defense-report.html"),
  );
  console.log(`  HTML → ${htmlArtifact.path}`);

  // 附带导出 DetectionReport 和 RiskProfile 以便审计
  const detectionPath = path.join(OUTPUT_DIR, "detection-report.json");
  fs.writeFileSync(
    detectionPath,
    JSON.stringify(detectionReport, null, 2),
    "utf-8",
  );
  console.log(`  DetectionReport → ${detectionPath}`);

  const profilePath = path.join(OUTPUT_DIR, "agent-risk-profile.json");
  fs.writeFileSync(
    profilePath,
    JSON.stringify(riskProfile, null, 2),
    "utf-8",
  );
  console.log(`  RiskProfile → ${profilePath}`);

  const policyPackPath = path.join(OUTPUT_DIR, "supervision-policy-pack.json");
  fs.writeFileSync(
    policyPackPath,
    JSON.stringify(policyPack, null, 2),
    "utf-8",
  );
  console.log(`  PolicyPack → ${policyPackPath}`);

  // ================================================================
  // FINAL
  // ================================================================
  console.log(`\n${"=".repeat(65)}`);
  console.log("✅ E2E THREE-STAGE PIPELINE VERIFIED");
  console.log("=".repeat(65));
  console.log(`\nData flow proven:`);
  console.log(`  Stage 1: ${contexts.length} contexts → ${riskReports.length} RiskReports → ${totalEvents} events`);
  console.log(`  Stage 2: RiskReports → DetectionReport → RiskProfile (${riskProfile.weaknesses.length} weaknesses) → PolicyPack (${policyPack.policies.length} policies) → ${allSupervisionRecords.length} runtime records`);
  console.log(`  Stage 3: → DefenseReport (${defenseReport.blockedActions.length} blocked, ${defenseReport.defenseEffectiveness.blockedHighRiskActionCount} high-risk blocked)`);
  console.log(`\nAll data is REAL — no hand-crafted mock objects in the pipeline.`);
}

main().catch((err) => {
  console.error("\n❌ FAIL:", err instanceof Error ? err.message : String(err));
  console.error(err instanceof Error && err.stack ? err.stack : "");
  process.exit(1);
});
