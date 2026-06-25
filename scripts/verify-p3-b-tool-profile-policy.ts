import type {
  AgentRiskProfile,
  SupervisionRuntimeAction,
} from "@agent-guard/contracts";
import { buildRuleBasedToolCapabilityProfile } from "../backend/src/modules/gateway/toolCapabilityProfiler";
import { buildSupervisionPolicyPack } from "../backend/src/modules/policy/policyPackBuilder";
import { findMatchingPolicies } from "../backend/src/modules/supervisor/policyEngine";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

const emptyRiskProfile: AgentRiskProfile = {
  schemaVersion: "mvp-1",
  profileId: "risk_profile.tool_profile_policy",
  agentId: "agent.tool_profile_policy",
  sourceDetectionReportId: "detection_report.tool_profile_policy",
  testedScenarios: [],
  weaknesses: [],
  exposures: [],
  highRiskTools: [],
  sensitiveResourcePatterns: [],
  exfiltrationPatterns: [],
  recommendedControls: [],
  confidence: "medium",
  generatedAt: new Date().toISOString(),
};

const shellProfile = buildRuleBasedToolCapabilityProfile({
  providerType: "mcp",
  originalToolName: "run_shell",
  canonicalToolId: "external.stub_mcp.run_shell",
  description: "Run a shell command on a downstream MCP server.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
});

const emailProfile = buildRuleBasedToolCapabilityProfile({
  providerType: "mcp",
  originalToolName: "gmail_create_draft",
  canonicalToolId: "external.gmail.create_draft",
  description: "Create a Gmail draft with recipients, subject, and body.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "array", items: { type: "string" } },
      subject: { type: "string" },
      body: { type: "string" },
      api_token: { type: "string" },
    },
    required: ["to", "body"],
  },
});

const policyPack = buildSupervisionPolicyPack(emptyRiskProfile, {
  toolProfiles: [shellProfile, emailProfile],
});

const toolProfilePolicies = policyPack.policies.filter((policy) =>
  policy.sourceWeaknessIds.some((sourceId) => sourceId.startsWith("tool_profile.")),
);
assert(toolProfilePolicies.length >= 3, "tool profiles should generate supervision policies");
assert(
  toolProfilePolicies.some(
    (policy) =>
      policy.targetType === "code_execution" &&
      policy.action === "ask" &&
      policy.sourceWeaknessIds.includes("tool_profile.external_stub_mcp_run_shell"),
  ),
  "shell profile should generate code_execution ask policy",
);
assert(
  toolProfilePolicies.some(
    (policy) =>
      policy.targetType === "email_send" &&
      policy.action === "redact" &&
      policy.sourceWeaknessIds.includes("tool_profile.external_gmail_create_draft"),
  ),
  "email profile should generate email redact policy",
);

const shellAction: SupervisionRuntimeAction = {
  runtimeSessionId: "session.tool_profile_policy",
  agentId: emptyRiskProfile.agentId,
  targetType: "code_execution",
  targetId: shellProfile.canonicalToolId,
  payload: {
    language: "shell",
    codePreview: "whoami",
  },
};

const emailAction: SupervisionRuntimeAction = {
  runtimeSessionId: "session.tool_profile_policy",
  agentId: emptyRiskProfile.agentId,
  targetType: "email_send",
  targetId: emailProfile.canonicalToolId,
  payload: {
    to: ["security@example.test"],
    subject: "debug",
    bodyPreview: "temporary api_token=sk-demo-secret",
  },
};

assert(
  findMatchingPolicies(policyPack, shellAction).some((policy) => policy.action === "ask"),
  "shell tool-profile policy should match runtime action by targetId",
);
assert(
  findMatchingPolicies(policyPack, emailAction).some((policy) => policy.action === "redact"),
  "email tool-profile redact policy should match runtime action by targetId and sensitive body",
);

console.log(
  `PASS: tool profile policy generation verified (${toolProfilePolicies.length} tool-profile policies)`,
);
