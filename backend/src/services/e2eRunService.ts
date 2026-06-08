/**
 * e2eRunService — 编排完整的三阶段 E2E 检测+监督+防御链路
 *
 * 复用现有:
 *   loadTestContexts()  → 加载 TestContext + TestOracle
 *   runTestCase()       → Agent + Sandbox + Monitor + SupervisionBridge
 *   evaluateRisk()      → RiskEvaluationResult
 *   buildRiskReport()   → RiskReport
 *   buildDetectionReport()    → DetectionReport
 *   buildAgentRiskProfile()   → AgentRiskProfile
 *   buildSupervisionPolicyPack() → SupervisionPolicyPack
 *   buildDefenseReport() → DefenseReport
 *   exportDefenseJsonReport() / exportDefenseHtmlReport()
 */

import path from "node:path";
import { createId, nowIso } from "../shared";
import type {
  AgentUnderTest,
  AgentAdapterConfig,
  RiskLevel,
} from "@agent-guard/contracts";
import { loadTestContexts } from "../modules/config/loadTestContext";
import { runTestCase } from "../modules/runner/testRunner";
import { evaluateRisk } from "../modules/risk/riskEvaluator";
import { buildRiskReport } from "../modules/report/reportBuilder";
import { buildDetectionReport } from "../modules/detection/detectionReportBuilder";
import { buildAgentRiskProfile } from "../modules/detection/agentRiskProfileBuilder";
import { buildSupervisionPolicyPack } from "../modules/policy/policyPackBuilder";
import { buildDefenseReport } from "../modules/defense/defenseReportBuilder";
import {
  exportDefenseJsonReport,
  exportDefenseHtmlReport,
} from "../modules/defense/defenseReportExporter";
import type { RunE2ERequest, P2RunGroup, EntityLink } from "../api/types";
import { buildInitialRunGroup, saveRunGroup } from "../storage/fileRunStore";
import type { SupervisionSessionSummary } from "../storage/fileRunStore";
import { saveSessionRecords } from "../storage/fileRunStore";
import { indexReport, indexArtifact } from "../storage/fileReportStore";
import type { AgentAdapter } from "../modules/agent/agentAdapter";
import { HttpAgentAdapter } from "../modules/agent/httpAgentAdapter";

const CONFIGS_DIR = path.resolve(process.cwd(), "configs");
const OUTPUT_DIR = path.resolve(process.cwd(), "outputs", "reports");

export class CaseIdValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaseIdValidationError";
  }
}

// ---- helpers ----

function mapAdapterKind(kind: string): AgentUnderTest["adapterType"] {
  switch (kind) {
    case "http_sample":
      return "http_sample" as AgentUnderTest["adapterType"];
    case "openclaw":
      return "openclaw" as AgentUnderTest["adapterType"];
    default:
      return "mock";
  }
}

function buildCustomAdapter(request: RunE2ERequest): AgentAdapter | undefined {
  switch (request.adapterKind) {
    case "http_sample": {
      const endpointUrl =
        request.connection?.endpointUrl ??
        `http://localhost:${process.env.SAMPLE_AGENT_PORT ?? 7001}/agent/run`;
      return new HttpAgentAdapter({
        endpointUrl,
        timeoutMs: request.connection?.timeoutMs ?? 15_000,
        mode: "vulnerable",
      });
    }
    default:
      return undefined;
  }
}

// ---- public API ----

export type RunE2EResult = {
  runGroup: P2RunGroup;
  links: EntityLink[];
};

export async function runE2E(request: RunE2ERequest): Promise<RunE2EResult> {
  // P2 adapterKind 映射到 contracts adapterType + 自定义 adapter。
  const adapterType = mapAdapterKind(request.adapterKind);
  const customAdapter = buildCustomAdapter(request);

  const agent: AgentUnderTest = {
    schemaVersion: "mvp-1",
    agentId: request.agent.agentId ?? createId("agent"),
    name: request.agent.name,
    adapterType,
  };

  const adapterConfig: AgentAdapterConfig = {
    schemaVersion: "mvp-1",
    adapterId: createId("adapter"),
    agentId: agent.agentId,
    adapterType: agent.adapterType,
    timeoutMs: request.connection?.timeoutMs ?? 30000,
  };

  const runGroup = buildInitialRunGroup(request, agent.agentId);

  try {
    // ====== 阶段 1: 监督前检测 ======
    const { contexts } = await loadTestContexts(CONFIGS_DIR, agent);

    // caseIds 有效性校验：传入不存在的 caseId 时返回 400 级别错误
    if (request.caseIds && request.caseIds.length > 0) {
      const validIds = new Set(contexts.map((ctx) => ctx.caseId));
      const invalid = request.caseIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        throw new CaseIdValidationError(
          `Unknown caseIds: ${invalid.join(", ")}. ` +
          `Available: ${[...validIds].join(", ")}`,
        );
      }
    }

    const targetCases = request.caseIds
      ? contexts.filter((ctx: (typeof contexts)[number]) => request.caseIds!.includes(ctx.caseId))
      : contexts;

    if (targetCases.length === 0) {
      throw new CaseIdValidationError(
        "No test cases matched. Provide valid caseIds or omit the field to run all enabled cases.",
      );
    }

    runGroup.caseCount = targetCases.length;

    const riskReports: Awaited<
      ReturnType<typeof buildRiskReport>
    >[] = [];

    for (const context of targetCases) {
      const { testRun, trace } = await runTestCase(
        agent,
        adapterConfig,
        context,
        { customAdapter },
      );

      runGroup.testRunIds.push(testRun.runId);
      runGroup.traceIds.push(trace.traceId);

      if (testRun.status === "failed") {
        // 关键 testRun 失败 → 跳过此 case 的后续处理，记录到 runGroup
        runGroup.status = "failed";
        runGroup.error = testRun.error ?? "Detection test run failed";
        await saveRunGroup(runGroup);
        throw new Error(
          `Detection pass failed for ${context.caseId}: ${testRun.error ?? "unknown error"}`,
        );
      }

      const evaluation = evaluateRisk(context, trace);
      const riskReport = buildRiskReport(context, evaluation, trace);
      riskReports.push(riskReport);

      runGroup.riskReportIds.push(riskReport.reportId);
    }

    // ====== 阶段 2: 检测报告 → 画像 → 策略包 → 监督运行 ======
    const detectionReport = buildDetectionReport({
      agentId: agent.agentId,
      riskReports,
    });
    runGroup.detectionReportId = detectionReport.reportId;

    const riskProfile = buildAgentRiskProfile(detectionReport, riskReports);
    runGroup.riskProfileId = riskProfile.profileId;

    const policyPack = buildSupervisionPolicyPack(riskProfile);
    runGroup.policyPackId = policyPack.policyPackId;

    // 二次运行：带 PolicyPack，采集真实监督记录
    const allSupervisionRecords: Awaited<
      ReturnType<typeof runTestCase>
    >["supervisionRecords"] = [];

    for (const context of targetCases) {
      const runtimeSessionId = createId("session");
      const { testRun, supervisionRecords } = await runTestCase(
        agent,
        adapterConfig,
        context,
        {
          supervisionPolicyPack: policyPack,
          runtimeSessionId,
          customAdapter,
        },
      );

      allSupervisionRecords.push(...supervisionRecords);
      runGroup.runtimeSessionIds.push(runtimeSessionId);

      if (testRun.status === "failed") {
        // 监督 pass 失败：记录但继续处理其他 case，最后标记 runGroup failed
        runGroup.status = "failed";
        if (!runGroup.error) {
          runGroup.error = `Supervision pass failed for ${context.caseId}: ${testRun.error ?? "unknown error"}`;
        }
      }

      const actionCounts: Record<string, number> = {};
      let blockedCount = 0;
      let redactedCount = 0;
      let askCount = 0;

      for (const rec of supervisionRecords) {
        actionCounts[rec.action] = (actionCounts[rec.action] ?? 0) + 1;
        if (rec.action === "deny") blockedCount++;
        if (rec.action === "redact") redactedCount++;
        if (rec.action === "ask") askCount++;
      }

      const sessionSummary: SupervisionSessionSummary = {
        runtimeSessionId,
        runGroupId: runGroup.runGroupId,
        agentId: agent.agentId,
        policyPackId: policyPack.policyPackId,
        recordCount: supervisionRecords.length,
        blockedCount,
        redactedCount,
        askCount,
        actionCounts,
      };
      await saveSessionRecords(sessionSummary, supervisionRecords);
    }

    // ====== 阶段 3: 防御报告 ======
    if (request.generateDefenseReport) {
      const defenseReport = buildDefenseReport({
        detectionReport,
        riskProfile,
        policyPack,
        runtimeRecords: allSupervisionRecords,
      });
      runGroup.defenseReportId = defenseReport.defenseReportId;

      // 风险汇总
      let highestRisk: RiskLevel = "low";
      const rank: Record<string, number> = {
        low: 1,
        medium: 2,
        high: 3,
        critical: 4,
      };
      for (const r of riskReports) {
        if (rank[r.riskLevel] > rank[highestRisk]) {
          highestRisk = r.riskLevel;
        }
      }
      runGroup.highestRiskLevel = highestRisk;

      // 导出 reports
      const runOutputDir = path.join(OUTPUT_DIR, runGroup.runGroupId);
      const jsonArtifact = await exportDefenseJsonReport(
        defenseReport,
        path.join(runOutputDir, "defense-report.json"),
      );
      const htmlArtifact = await exportDefenseHtmlReport(
        defenseReport,
        path.join(runOutputDir, "defense-report.html"),
      );

      await indexArtifact(jsonArtifact, "Defense Report (JSON)");
      await indexArtifact(htmlArtifact, "Defense Report (HTML)");
      runGroup.artifactIds.push(jsonArtifact.artifactId, htmlArtifact.artifactId);

      // 索引报告
      await indexReport({
        reportId: defenseReport.defenseReportId,
        reportType: "defense_report",
        runGroupId: runGroup.runGroupId,
        artifactIds: [jsonArtifact.artifactId, htmlArtifact.artifactId],
        generatedAt: defenseReport.generatedAt,
      });
      await indexReport({
        reportId: detectionReport.reportId,
        reportType: "detection_report",
        runGroupId: runGroup.runGroupId,
        artifactIds: [],
        generatedAt: detectionReport.generatedAt,
      });
      await indexReport({
        reportId: riskProfile.profileId,
        reportType: "risk_profile",
        runGroupId: runGroup.runGroupId,
        artifactIds: [],
        generatedAt: riskProfile.generatedAt,
      });
      await indexReport({
        reportId: policyPack.policyPackId,
        reportType: "policy_pack",
        runGroupId: runGroup.runGroupId,
        artifactIds: [],
        generatedAt: policyPack.createdAt,
      });
    }

    // ====== Complete ======
    // runGroup.status 可能已被前面代码设为 "failed"，这里仅当仍为 "running" 时改 completed
    if (runGroup.status !== "failed") {
      runGroup.status = "completed";
    }
    runGroup.endedAt = nowIso();

    const links = buildLinks(runGroup);

    await saveRunGroup(runGroup);

    return { runGroup, links };
  } catch (err) {
    runGroup.status = "failed";
    runGroup.endedAt = nowIso();
    runGroup.error = err instanceof Error ? err.message : String(err);
    await saveRunGroup(runGroup);
    throw err;
  }
}

// ---- helpers ----

function buildLinks(runGroup: P2RunGroup): EntityLink[] {
  const links: EntityLink[] = [];

  for (const id of runGroup.testRunIds) {
    links.push({ kind: "test_run", id, label: `TestRun ${id}` });
  }
  for (const id of runGroup.traceIds) {
    links.push({ kind: "trace", id, label: `Trace ${id}` });
  }
  for (const id of runGroup.riskReportIds) {
    links.push({ kind: "risk_report", id, label: `RiskReport ${id}` });
  }
  if (runGroup.detectionReportId) {
    links.push({
      kind: "detection_report",
      id: runGroup.detectionReportId,
      label: "Detection Report",
    });
  }
  if (runGroup.riskProfileId) {
    links.push({
      kind: "risk_profile",
      id: runGroup.riskProfileId,
      label: "Agent Risk Profile",
    });
  }
  if (runGroup.policyPackId) {
    links.push({
      kind: "policy_pack",
      id: runGroup.policyPackId,
      label: "Supervision Policy Pack",
    });
  }
  for (const id of runGroup.runtimeSessionIds) {
    links.push({
      kind: "runtime_session",
      id,
      label: `Runtime Session ${id}`,
    });
  }
  if (runGroup.defenseReportId) {
    links.push({
      kind: "defense_report",
      id: runGroup.defenseReportId,
      label: "Defense Report",
    });
  }
  for (const id of runGroup.artifactIds) {
    links.push({ kind: "artifact", id, label: `Artifact ${id}` });
  }

  return links;
}

