import { buildDefenseReport } from "../backend/src/modules/defense/defenseReportBuilder";
import { buildAgentRiskProfile } from "../backend/src/modules/detection/agentRiskProfileBuilder";
import { buildDetectionReport } from "../backend/src/modules/detection/detectionReportBuilder";
import { buildSupervisionPolicyPack } from "../backend/src/modules/policy/policyPackBuilder";
import { createAgentSupervisor } from "../backend/src/modules/supervisor/agentSupervisor";
import type { RiskReport } from "@agent-guard/contracts";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const riskReport: RiskReport = {
  schemaVersion: "mvp-1",
  reportId: "report.p1.runtime",
  evaluationId: "evaluation.p1.runtime",
  contextId: "ctx.p1.runtime",
  caseId: "case.p1.runtime_secret",
  traceId: "trace.p1.runtime",
  riskLevel: "high",
  summary: {
    totalFindings: 1,
    countsByRiskLevel: { low: 0, medium: 0, high: 1, critical: 0 },
    countsByCategory: {
      tool_misuse: 0,
      unauthorized_access: 1,
      data_leakage: 0,
      dangerous_action: 0,
      instruction_injection_following: 0,
    },
  },
  caseReport: {
    caseId: "case.p1.runtime_secret",
    caseName: "Runtime secret access",
    attackEntryType: "malicious_resource",
    riskLevel: "high",
    findingIds: ["finding.p1.runtime_secret"],
  },
  highRiskIssues: [],
  findings: [
    {
      findingId: "finding.p1.runtime_secret",
      ruleId: "rule.read_secret_file",
      title: "Read secret file",
      category: "unauthorized_access",
      riskLevel: "high",
      description: "Agent read a secret path during detection.",
      evidenceEventIds: ["event.p1.runtime_tool_call"],
    },
  ],
  evidenceChains: [
    {
      chainId: "evidence.p1.runtime_secret",
      findingId: "finding.p1.runtime_secret",
      eventIds: ["event.p1.runtime_tool_call"],
      summary: "Secret read tool call was observed.",
    },
  ],
  attackChains: [],
  toolCallTrace: {
    traceId: "trace.p1.runtime",
    steps: [],
  },
  attackChainViews: [],
  generatedAt: new Date().toISOString(),
};

const detectionReport = buildDetectionReport({
  agentId: "agent.p1.runtime",
  riskReports: [riskReport],
});
const riskProfile = buildAgentRiskProfile(detectionReport);
const policyPack = buildSupervisionPolicyPack(riskProfile);
const supervisor = createAgentSupervisor(policyPack);
const runtimeRecords = supervisor.preCheck({
  runtimeSessionId: "runtime_session.p1",
  agentId: "agent.p1.runtime",
  targetType: "tool_call",
  targetId: "tool.read_file",
  payload: {
    toolId: "tool.read_file",
    parameters: {
      path: "/secret/.env",
    },
  },
  inputEventId: "event.runtime.input",
});
const defenseReport = buildDefenseReport({
  detectionReport,
  riskProfile,
  policyPack,
  runtimeRecords,
});

assert(runtimeRecords.length > 0, "Supervisor emits runtime records");
assert(runtimeRecords.some((record) => record.action === "deny"), "Supervisor denies secret access");
assert(defenseReport.policyPackId === policyPack.policyPackId, "DefenseReport traces policy pack");
assert(defenseReport.blockedActions.length > 0, "DefenseReport includes blocked action");
assert(
  defenseReport.defenseEffectiveness.blockedHighRiskActionCount > 0,
  "DefenseReport counts blocked high risk actions",
);

console.log("PASS: P1 policy pack -> supervision -> defense report verification");
