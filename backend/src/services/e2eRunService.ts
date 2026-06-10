import path from "node:path";
import type { AgentAdapterConfig, AgentUnderTest } from "@agent-guard/contracts";
import { createId, nowIso } from "../shared";
import { loadTestContexts } from "../modules/config/loadTestContext";
import { runTestCase } from "../modules/runner/testRunner";
import { evaluateRisk } from "../modules/risk/riskEvaluator";
import { buildRiskReport } from "../modules/report/reportBuilder";
import { exportReport } from "../modules/report/exporters";
import { buildDetectionReport } from "../modules/detection/detectionReportBuilder";
import { buildAgentRiskProfile } from "../modules/detection/agentRiskProfileBuilder";
import { buildSupervisionPolicyPack } from "../modules/policy/policyPackBuilder";
import { buildDefenseReport } from "../modules/defense/defenseReportBuilder";
import {
  exportDefenseHtmlReport,
  exportDefenseJsonReport,
} from "../modules/defense/defenseReportExporter";
import type { FileReportStore } from "../storage/fileReportStore";
import type { CLineRunBundle } from "./cLineRunTypes";

export type RunCLineE2EInput = {
  agent?: Partial<AgentUnderTest>;
  adapter?: Partial<AgentAdapterConfig>;
  caseIds?: string[];
};

export type E2ERunService = {
  run(input?: RunCLineE2EInput): Promise<CLineRunBundle>;
};

export function createE2ERunService(options: {
  rootDir: string;
  configDir: string;
  store: FileReportStore;
}): E2ERunService {
  return {
    async run(input = {}) {
      const runGroupId = createId("run_group");
      const agent: AgentUnderTest = {
        schemaVersion: "mvp-1",
        agentId: input.agent?.agentId ?? "agent.c-line.mock",
        name: input.agent?.name ?? "C Line Mock Agent",
        description:
          input.agent?.description ??
          "Formal C-line API fallback agent. Replace with real adapter in P2-B.",
        adapterType: input.agent?.adapterType ?? "mock",
      };
      const adapterConfig: AgentAdapterConfig = {
        schemaVersion: "mvp-1",
        adapterId: input.adapter?.adapterId ?? createId("adapter"),
        agentId: agent.agentId,
        adapterType: input.adapter?.adapterType ?? agent.adapterType,
        endpoint: input.adapter?.endpoint,
        scriptPath: input.adapter?.scriptPath,
        sdkName: input.adapter?.sdkName,
        timeoutMs: input.adapter?.timeoutMs ?? 30000,
        envKeys: input.adapter?.envKeys,
      };

      const { contexts } = await loadTestContexts(options.configDir, agent);
      const selectedContexts = input.caseIds?.length
        ? contexts.filter((context) => input.caseIds?.includes(context.caseId))
        : contexts;
      if (selectedContexts.length === 0) {
        throw new Error("No enabled test contexts matched the requested caseIds.");
      }

      const artifactsDir = path.join(options.store.baseDir, "artifacts", runGroupId);
      const testRuns = [];
      const traces = [];
      const riskReports = [];
      const artifacts = [];

      for (const context of selectedContexts) {
        const { testRun, trace } = await runTestCase(agent, adapterConfig, context);
        const evaluation = evaluateRisk(context, trace);
        const report = buildRiskReport(context, evaluation, trace);
        const reportArtifacts = await exportReport(report, {
          outputDir: artifactsDir,
          fileBaseName: `${context.caseId}-${report.reportId}`,
          formats: ["json", "html"],
        });

        testRuns.push(testRun);
        traces.push(trace);
        riskReports.push(report);
        artifacts.push(...reportArtifacts);
      }

      const detectionReport = buildDetectionReport({
        agentId: agent.agentId,
        riskReports,
      });
      const riskProfile = buildAgentRiskProfile(detectionReport, riskReports);
      const policyPack = buildSupervisionPolicyPack(riskProfile);

      const supervisionRecords = [];
      const supervisedTestRuns = [];
      const supervisedTraces = [];
      for (const context of selectedContexts) {
        const runtimeSessionId = `session.${runGroupId}.${context.caseId}`;
        const supervised = await runTestCase(agent, adapterConfig, context, {
          supervisionPolicyPack: policyPack,
          runtimeSessionId,
        });
        supervisedTestRuns.push(supervised.testRun);
        supervisedTraces.push(supervised.trace);
        supervisionRecords.push(...supervised.supervisionRecords);
      }

      const defenseReport = buildDefenseReport({
        detectionReport,
        riskProfile,
        policyPack,
        runtimeRecords: supervisionRecords,
      });
      artifacts.push(
        await exportDefenseJsonReport(
          defenseReport,
          path.join(artifactsDir, `${defenseReport.defenseReportId}.json`),
        ),
      );
      artifacts.push(
        await exportDefenseHtmlReport(
          defenseReport,
          path.join(artifactsDir, `${defenseReport.defenseReportId}.html`),
        ),
      );

      const allTestRuns = [...testRuns, ...supervisedTestRuns];
      const allTraces = [...traces, ...supervisedTraces];
      const now = nowIso();
      const bundle: CLineRunBundle = {
        schemaVersion: "mvp-1",
        runGroup: {
          schemaVersion: "mvp-1",
          runGroupId,
          agentId: agent.agentId,
          status: allTestRuns.some((run) => run.status === "failed") ? "failed" : "completed",
          caseIds: selectedContexts.map((context) => context.caseId),
          detectionReportId: detectionReport.reportId,
          riskProfileId: riskProfile.profileId,
          policyPackId: policyPack.policyPackId,
          defenseReportId: defenseReport.defenseReportId,
          traceIds: allTraces.map((trace) => trace.traceId),
          riskReportIds: riskReports.map((report) => report.reportId),
          runtimeSessionIds: [
            ...new Set(supervisionRecords.map((record) => record.runtimeSessionId)),
          ],
          artifactIds: artifacts.map((artifact) => artifact.artifactId),
          createdAt: now,
          updatedAt: now,
        },
        testRuns: allTestRuns,
        traces: allTraces,
        riskReports,
        detectionReport,
        riskProfile,
        policyPack,
        supervisionRecords,
        defenseReport,
        artifacts,
      };

      return options.store.saveBundle(bundle);
    },
  };
}
