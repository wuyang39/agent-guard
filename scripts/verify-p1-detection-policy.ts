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
const passedRiskReport: RiskReport = {
  ...riskReport,
  reportId: "report.p1.passed_probe",
  evaluationId: "evaluation.p1.passed_probe",
  contextId: "ctx.p1.passed_probe",
  caseId: "case.p1.passed_tool_probe",
  traceId: "trace.p1.passed_probe",
  riskLevel: "low",
  summary: {
    totalFindings: 0,
    countsByRiskLevel: { low: 0, medium: 0, high: 0, critical: 0 },
    countsByCategory: {
      tool_misuse: 0,
      unauthorized_access: 0,
      data_leakage: 0,
      dangerous_action: 0,
      instruction_injection_following: 0,
    },
  },
  caseReport: {
    caseId: "case.p1.passed_tool_probe",
    caseName: "Passed tool abuse probe",
    attackEntryType: "malicious_user_prompt",
    riskLevel: "low",
    findingIds: [],
  },
  findings: [],
  evidenceChains: [],
  attackChains: [],
  highRiskIssues: [],
  toolCallTrace: {
    traceId: "trace.p1.passed_probe",
    steps: [],
  },
  attackChainViews: [],
};
const passedDetectionReport = buildDetectionReport({
  agentId: "agent.p1.sample",
  riskReports: [passedRiskReport],
});
const passedRiskProfile = buildAgentRiskProfile(passedDetectionReport, [passedRiskReport]);
const passedPolicyPack = buildSupervisionPolicyPack(passedRiskProfile);
const emptyDetectionReport = buildDetectionReport({
  agentId: "agent.p1.empty",
  riskReports: [],
});
const emptyRiskProfile = buildAgentRiskProfile(emptyDetectionReport, []);
const emptyPolicyPack = buildSupervisionPolicyPack(emptyRiskProfile);

assert(detectionReport.sourceRiskReportIds.includes(riskReport.reportId), "DetectionReport traces RiskReport");
assert(riskProfile.sourceDetectionReportId === detectionReport.reportId, "AgentRiskProfile traces DetectionReport");
assert(riskProfile.exposures.length > 0, "AgentRiskProfile records observed exposures");
assert(policyPack.sourceRiskProfileId === riskProfile.profileId, "PolicyPack traces RiskProfile");
assert(policyPack.policies.length > 0, "PolicyPack contains generated policies");
assert(
  policyPack.policies.some((policy) => policy.action === "deny"),
  "Unauthorized access weakness generates deny policy",
);
assert(passedRiskProfile.weaknesses.length === 0, "Passed probe does not create observed weakness");
assert(passedRiskProfile.exposures.length > 0, "Passed probe still creates tested exposure");
assert(
  passedRiskProfile.exposures.some((exposure) => exposure.status === "tested_no_finding"),
  "Passed probe exposure is marked tested_no_finding",
);
assert(passedPolicyPack.policies.length > 0, "Passed probe exposure generates baseline policies");
assert(
  passedPolicyPack.policies.every((policy) => policy.sourceWeaknessIds.length > 0),
  "Baseline policies keep source traceability",
);
assert(emptyRiskProfile.weaknesses.length === 0, "Empty probe has no observed weaknesses");
assert(emptyRiskProfile.exposures.length === 0, "Empty probe has no exposure evidence");
assert(emptyPolicyPack.policies.length > 0, "Empty profile receives fallback baseline policies");
assert(
  emptyPolicyPack.policies.some((policy) =>
    policy.sourceWeaknessIds.some((sourceId) => sourceId.startsWith("baseline.global.")),
  ),
  "Fallback baseline policies keep source traceability",
);

console.log("PASS: P1 detection -> risk profile -> policy pack verification");
