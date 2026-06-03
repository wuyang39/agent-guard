import type { RiskReport } from "@agent-guard/contracts";
import { buildAgentRiskProfile } from "../backend/src/modules/detection/agentRiskProfileBuilder";
import { buildDetectionReport } from "../backend/src/modules/detection/detectionReportBuilder";
import { buildSupervisionPolicyPack } from "../backend/src/modules/policy/policyPackBuilder";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const riskReport: RiskReport = {
  schemaVersion: "mvp-1",
  reportId: "report.p1.sample",
  evaluationId: "evaluation.p1.sample",
  contextId: "ctx.p1.sample",
  caseId: "case.p1.secret_access",
  traceId: "trace.p1.sample",
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
    caseId: "case.p1.secret_access",
    caseName: "Secret access pre-supervision detection",
    attackEntryType: "malicious_resource",
    riskLevel: "high",
    findingIds: ["finding.p1.secret_access"],
  },
  highRiskIssues: [],
  findings: [
    {
      findingId: "finding.p1.secret_access",
      ruleId: "rule.read_secret_file",
      title: "Read secret file",
      category: "unauthorized_access",
      riskLevel: "high",
      description: "Agent read a secret path during detection.",
      evidenceEventIds: ["event.p1.tool_call"],
    },
  ],
  evidenceChains: [
    {
      chainId: "evidence.p1.secret_access",
      findingId: "finding.p1.secret_access",
      eventIds: ["event.p1.tool_call"],
      summary: "Secret read tool call was observed.",
    },
  ],
  attackChains: [],
  toolCallTrace: {
    traceId: "trace.p1.sample",
    steps: [],
  },
  attackChainViews: [],
  generatedAt: new Date().toISOString(),
};

const detectionReport = buildDetectionReport({
  agentId: "agent.p1.sample",
  riskReports: [riskReport],
});
const riskProfile = buildAgentRiskProfile(detectionReport);
const policyPack = buildSupervisionPolicyPack(riskProfile);

assert(detectionReport.sourceRiskReportIds.includes(riskReport.reportId), "DetectionReport traces RiskReport");
assert(riskProfile.sourceDetectionReportId === detectionReport.reportId, "AgentRiskProfile traces DetectionReport");
assert(policyPack.sourceRiskProfileId === riskProfile.profileId, "PolicyPack traces RiskProfile");
assert(policyPack.policies.length > 0, "PolicyPack contains generated policies");
assert(
  policyPack.policies.some((policy) => policy.action === "deny"),
  "Unauthorized access weakness generates deny policy",
);

console.log("PASS: P1 detection -> risk profile -> policy pack verification");
