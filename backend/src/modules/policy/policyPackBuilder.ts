import type {
  AgentRiskExposure,
  AgentRiskProfile,
  AgentWeakness,
} from "../detection/detectionTypes";
import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type {
  PolicyTemplate,
  RiskCategory,
  RiskLevel,
  SupervisionAction,
  SupervisionPolicy,
  SupervisionPolicyPack,
  SupervisionTargetType,
  ToolCapabilityProfile,
} from "@agent-guard/contracts";

export type BuildSupervisionPolicyPackOptions = {
  policyTemplates?: PolicyTemplate[];
  toolProfiles?: ToolCapabilityProfile[];
};

const FALLBACK_BASELINE_CATEGORIES: RiskCategory[] = [
  "unauthorized_access",
  "data_leakage",
  "dangerous_action",
  "tool_misuse",
];

export function buildSupervisionPolicyPack(
  riskProfile: AgentRiskProfile,
  options: BuildSupervisionPolicyPackOptions = {},
): SupervisionPolicyPack {
  const policyTemplates = options.policyTemplates ?? [];
  const weaknessPolicies = riskProfile.weaknesses.flatMap((weakness) =>
    toSupervisionPolicies(weakness, policyTemplates),
  );
  const baselinePolicies = buildBaselinePolicies(riskProfile, policyTemplates);
  const toolProfilePolicies = buildToolProfilePolicies(options.toolProfiles ?? []);
  return {
    schemaVersion: SCHEMA_VERSION,
    policyPackId: createId("policy_pack"),
    agentId: riskProfile.agentId,
    sourceDetectionReportId: riskProfile.sourceDetectionReportId,
    sourceRiskProfileId: riskProfile.profileId,
    policies: dedupePolicies([...weaknessPolicies, ...baselinePolicies, ...toolProfilePolicies]),
    defaultAction: "allow",
    createdAt: nowIso(),
    expiresAt: buildExpiryIso(7),
  };
}

function toSupervisionPolicies(
  weakness: AgentWeakness,
  policyTemplates: PolicyTemplate[],
): SupervisionPolicy[] {
  const templates = selectPolicyTemplates(weakness, policyTemplates);
  if (templates.length > 0) {
    return templates.map((template) => buildPolicyFromTemplate(weakness, template));
  }

  return policyDefaultsForCategory(weakness.category).map((defaults) =>
    buildLegacyPolicy(weakness, defaults),
  );
}

function buildBaselinePolicies(
  riskProfile: AgentRiskProfile,
  policyTemplates: PolicyTemplate[],
): SupervisionPolicy[] {
  const exposures = (riskProfile.exposures ?? []).filter(
    (exposure) => exposure.status !== "observed_weakness",
  );
  const policies = exposures.flatMap((exposure) =>
    toBaselinePolicies(exposure, policyTemplates),
  );

  for (const toolId of riskProfile.highRiskTools ?? []) {
    policies.push(...baselinePoliciesForTool(toolId));
  }

  if (policies.length === 0 && riskProfile.weaknesses.length === 0) {
    policies.push(...buildFallbackBaselinePolicies());
  }

  return policies;
}

function toBaselinePolicies(
  exposure: AgentRiskExposure,
  policyTemplates: PolicyTemplate[],
): SupervisionPolicy[] {
  const templates = selectExposurePolicyTemplates(exposure, policyTemplates);
  if (templates.length > 0) {
    return templates.map((template) => buildBaselinePolicyFromTemplate(exposure, template));
  }

  return baselineDefaultsForCategory(exposure.category).map((defaults) =>
    buildBaselinePolicy(exposure, defaults),
  );
}

function baselineDefaultsForCategory(category: RiskCategory): {
  targetType: SupervisionTargetType;
  action: SupervisionAction;
  riskLevel: SupervisionPolicy["riskLevel"];
  match: SupervisionPolicy["match"];
  name: string;
  description: string;
  reason: string;
}[] {
  switch (category) {
    case "data_leakage":
      return [
        {
          targetType: "api_call",
          action: "deny",
          riskLevel: "critical",
          name: "Baseline deny obvious exfiltration",
          description: "Baseline hardening for data leakage exposure.",
          reason: "Baseline exposure control: block obvious exfiltration endpoints even when detection observed no failure.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.url",
                operator: "regex",
                value: "https?://(evil|attacker|exfil)",
                caseSensitive: false,
              },
            ],
          },
        },
        {
          targetType: "api_call",
          action: "redact",
          riskLevel: "high",
          name: "Baseline redact sensitive outbound API payload",
          description: "Baseline hardening for outbound API data.",
          reason: "Baseline exposure control: redact token-like outbound API payloads.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.data",
                operator: "regex",
                value: "(token|secret|password|credential|private[_-]?key|api[_-]?key)",
                caseSensitive: false,
              },
            ],
          },
        },
        {
          targetType: "email_send",
          action: "redact",
          riskLevel: "high",
          name: "Baseline redact sensitive email body",
          description: "Baseline hardening for email sends.",
          reason: "Baseline exposure control: redact token-like email content.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.bodyPreview",
                operator: "regex",
                value: "(token|secret|password|credential|private[_-]?key|api[_-]?key)",
                caseSensitive: false,
              },
            ],
          },
        },
      ];
    case "dangerous_action":
      return [
        {
          targetType: "file_write",
          action: "ask",
          riskLevel: "high",
          name: "Baseline ask before file write",
          description: "Baseline hardening for write-capable tools.",
          reason: "Baseline exposure control: file writes require human confirmation.",
          match: {
            relation: "all",
            matchers: [{ fieldPath: "payload.path", operator: "exists" }],
          },
        },
        {
          targetType: "code_execution",
          action: "ask",
          riskLevel: "high",
          name: "Baseline ask before code execution",
          description: "Baseline hardening for execution-capable tools.",
          reason: "Baseline exposure control: code execution requires human confirmation.",
          match: {
            relation: "all",
            matchers: [{ fieldPath: "payload.codePreview", operator: "exists" }],
          },
        },
      ];
    case "tool_misuse":
      return [
        {
          targetType: "tool_call",
          action: "ask",
          riskLevel: "medium",
          name: "Baseline ask before high-risk tool call",
          description: "Baseline hardening for broad tool misuse exposure.",
          reason: "Baseline exposure control: high-risk generic tool calls require confirmation.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.toolId",
                operator: "in",
                value: [
                  "tool.write_file",
                  "tool.execute_code",
                  "tool.call_api",
                  "tool.send_request",
                  "tool.send_email",
                ],
              },
            ],
          },
        },
        {
          targetType: "tool_call",
          action: "ask",
          riskLevel: "medium",
          name: "Baseline ask before external gateway tool call",
          description: "Baseline hardening for unclassified external MCP tools.",
          reason: "Baseline exposure control: external gateway tool calls require confirmation until classified by evidence.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "gateway.providerId",
                operator: "exists",
              },
            ],
          },
        },
      ];
    case "unauthorized_access":
      return [
        {
          targetType: "tool_call",
          action: "deny",
          riskLevel: "high",
          name: "Baseline deny secret-path reads",
          description: "Baseline hardening for unauthorized access exposure.",
          reason: "Baseline exposure control: deny reads under secret paths.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.parameters.path",
                operator: "starts_with",
                value: "/secret/",
              },
            ],
          },
        },
        {
          targetType: "resource_access",
          action: "deny",
          riskLevel: "high",
          name: "Baseline deny secret resources",
          description: "Baseline hardening for secret resource access.",
          reason: "Baseline exposure control: deny resources marked as secret.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.resourceId",
                operator: "contains",
                value: "secret",
              },
            ],
          },
        },
      ];
    case "instruction_injection_following":
      return [
        {
          targetType: "agent_message",
          action: "warn",
          riskLevel: "medium",
          name: "Baseline warn on injection-like agent message",
          description: "Baseline hardening for prompt-injection exposure.",
          reason: "Baseline exposure control: warn on override-style instruction language.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.message",
                operator: "regex",
                value: "(ignore|override|developer|system|instruction|secret|exfiltrate|credential)",
                caseSensitive: false,
              },
            ],
          },
        },
      ];
  }
}

function policyDefaultsForCategory(category: RiskCategory): {
  targetType: SupervisionTargetType;
  action: SupervisionAction;
  riskLevel: SupervisionPolicy["riskLevel"];
  match: SupervisionPolicy["match"];
  name: string;
  reason: string;
}[] {
  switch (category) {
    case "unauthorized_access":
      return [
        {
          targetType: "tool_call",
          action: "deny",
          riskLevel: "high",
          name: "Deny secret-path tool access",
          reason: "Detected unauthorized access weakness: block tool reads under /secret/.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.parameters.path",
                operator: "starts_with",
                value: "/secret/",
              },
            ],
          },
        },
        {
          targetType: "resource_access",
          action: "deny",
          riskLevel: "high",
          name: "Deny secret resource access",
          reason: "Detected unauthorized access weakness: block resources marked as secret.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.resourceId",
                operator: "contains",
                value: "secret",
              },
            ],
          },
        },
      ];
    case "data_leakage":
      return [
        {
          targetType: "api_call",
          action: "deny",
          riskLevel: "critical",
          name: "Deny obvious external exfiltration",
          reason: "Detected data leakage weakness: block outbound calls to obvious exfiltration endpoints.",
          match: {
            relation: "all",
            matchers: [
              {
                fieldPath: "payload.url",
                operator: "regex",
                value: "https?://(evil|attacker|exfil)",
                caseSensitive: false,
              },
            ],
          },
        },
        {
          targetType: "api_call",
          action: "redact",
          riskLevel: "high",
          name: "Redact sensitive API payload",
          reason: "Detected data leakage weakness: redact token-like data before outbound API calls.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.data",
                operator: "regex",
                value: "(token|secret|password|credential)",
                caseSensitive: false,
              },
            ],
          },
        },
        {
          targetType: "email_send",
          action: "redact",
          riskLevel: "high",
          name: "Redact sensitive email body",
          reason: "Detected data leakage weakness: redact token-like content before sending email.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.bodyPreview",
                operator: "regex",
                value: "(token|secret|password|credential)",
                caseSensitive: false,
              },
            ],
          },
        },
      ];
    case "dangerous_action":
      return [
        {
          targetType: "file_write",
          action: "ask",
          riskLevel: "high",
          name: "Ask before file write",
          reason: "Detected dangerous action weakness: require confirmation before file writes.",
          match: {
            relation: "all",
            matchers: [{ fieldPath: "payload.path", operator: "exists" }],
          },
        },
        {
          targetType: "code_execution",
          action: "ask",
          riskLevel: "high",
          name: "Ask before code execution",
          reason: "Detected dangerous action weakness: require confirmation before code execution.",
          match: {
            relation: "all",
            matchers: [{ fieldPath: "payload.codePreview", operator: "exists" }],
          },
        },
      ];
    case "instruction_injection_following":
      return [
        {
          targetType: "agent_message",
          action: "warn",
          riskLevel: "medium",
          name: "Warn on injection-following message",
          reason: "Detected instruction injection weakness: warn when the agent repeats override-style instructions.",
          match: {
            relation: "any",
            matchers: [
              {
                fieldPath: "payload.message",
                operator: "regex",
                value: "(ignore|override|developer|system|instruction|secret)",
                caseSensitive: false,
              },
            ],
          },
        },
      ];
    case "tool_misuse":
      return [
        {
          targetType: "tool_call",
          action: "ask",
          riskLevel: "medium",
          name: "Ask before broad tool call",
          reason: "Detected tool misuse weakness: require confirmation before matching tool calls.",
          match: {
            relation: "all",
            matchers: [{ fieldPath: "payload.toolId", operator: "exists" }],
          },
        },
      ];
  }
}

function selectPolicyTemplates(
  weakness: AgentWeakness,
  policyTemplates: PolicyTemplate[],
): PolicyTemplate[] {
  const byId = new Map(
    policyTemplates.map((template) => [template.policyTemplateId, template]),
  );
  const fromWeakness = weakness.recommendedPolicyTemplateIds
    .map((templateId) => byId.get(templateId))
    .filter((template): template is PolicyTemplate =>
      Boolean(template && template.riskCategory === weakness.category),
    );

  if (fromWeakness.length > 0) {
    return uniqueTemplates(fromWeakness);
  }

  return uniqueTemplates(
    policyTemplates.filter((template) => template.riskCategory === weakness.category),
  );
}

function selectExposurePolicyTemplates(
  exposure: AgentRiskExposure,
  policyTemplates: PolicyTemplate[],
): PolicyTemplate[] {
  const byId = new Map(
    policyTemplates.map((template) => [template.policyTemplateId, template]),
  );
  const fromExposure = exposure.recommendedPolicyTemplateIds
    .map((templateId) => byId.get(templateId))
    .filter((template): template is PolicyTemplate =>
      Boolean(template && template.riskCategory === exposure.category),
    );

  if (fromExposure.length > 0) {
    return uniqueTemplates(fromExposure);
  }

  return uniqueTemplates(
    policyTemplates.filter((template) => template.riskCategory === exposure.category),
  );
}

function uniqueTemplates(templates: PolicyTemplate[]): PolicyTemplate[] {
  const seen = new Set<string>();
  return templates.filter((template) => {
    if (seen.has(template.policyTemplateId)) return false;
    seen.add(template.policyTemplateId);
    return true;
  });
}

function buildPolicyFromTemplate(
  weakness: AgentWeakness,
  template: PolicyTemplate,
): SupervisionPolicy {
  return {
    policyId: createId("policy"),
    sourcePolicyTemplateId: template.policyTemplateId,
    sourceWeaknessIds: [weakness.weaknessId],
    name: template.name,
    description: `${template.description} Source weakness: ${weakness.description}`,
    targetType: template.targetType,
    action: template.action,
    riskLevel: riskLevelForTemplate(template),
    match: template.match,
    reason: `${template.reasonTemplate} Source weakness: ${weakness.weaknessId}.`,
  };
}

function buildBaselinePolicyFromTemplate(
  exposure: AgentRiskExposure,
  template: PolicyTemplate,
): SupervisionPolicy {
  return {
    policyId: createId("policy"),
    sourcePolicyTemplateId: template.policyTemplateId,
    sourceWeaknessIds: [exposure.exposureId],
    name: `Baseline ${template.name}`,
    description: `${template.description} Source exposure: ${exposure.description}`,
    targetType: template.targetType,
    action: template.action,
    riskLevel: riskLevelForTemplate(template),
    match: template.match,
    reason: `${template.reasonTemplate} Source exposure: ${exposure.exposureId}.`,
  };
}

function buildLegacyPolicy(
  weakness: AgentWeakness,
  defaults: ReturnType<typeof policyDefaultsForCategory>[number],
): SupervisionPolicy {
  return {
    policyId: createId("policy"),
    sourceWeaknessIds: [weakness.weaknessId],
    name: defaults.name,
    description: weakness.description,
    targetType: defaults.targetType,
    action: defaults.action,
    riskLevel: defaults.riskLevel,
    match: defaults.match,
    reason: `${defaults.reason} Source weakness: ${weakness.weaknessId}.`,
  };
}

function buildBaselinePolicy(
  exposure: AgentRiskExposure,
  defaults: ReturnType<typeof baselineDefaultsForCategory>[number],
): SupervisionPolicy {
  return {
    policyId: createId("policy"),
    sourceWeaknessIds: [exposure.exposureId],
    name: defaults.name,
    description: `${defaults.description} Source exposure: ${exposure.title}.`,
    targetType: defaults.targetType,
    action: defaults.action,
    riskLevel: strongerRiskLevel(defaults.riskLevel, exposure.riskLevel),
    match: defaults.match,
    reason: `${defaults.reason} Source exposure: ${exposure.exposureId}.`,
  };
}

function buildFallbackBaselinePolicies(): SupervisionPolicy[] {
  return FALLBACK_BASELINE_CATEGORIES.flatMap((category) =>
    baselineDefaultsForCategory(category).map((defaults) => ({
      policyId: createId("policy"),
      sourceWeaknessIds: [`baseline.global.${category}`],
      name: defaults.name,
      description: `${defaults.description} Source baseline: no findings or exposure records were available.`,
      targetType: defaults.targetType,
      action: defaults.action,
      riskLevel: defaults.riskLevel,
      match: defaults.match,
      reason: `${defaults.reason} Source baseline: baseline.global.${category}.`,
    })),
  );
}

function buildToolProfilePolicies(
  toolProfiles: ToolCapabilityProfile[],
): SupervisionPolicy[] {
  return dedupeToolProfiles(toolProfiles).flatMap((profile) => {
    const policies: SupervisionPolicy[] = [];
    const targetType = targetTypeForToolProfile(profile);
    const sourceId = `tool_profile.${safeId(profile.canonicalToolId)}`;
    const base = {
      sourceWeaknessIds: [sourceId],
      targetType,
      match: targetMatchForToolProfile(profile),
    };

    if (shouldAskForToolProfile(profile)) {
      policies.push({
        policyId: createId("policy"),
        ...base,
        action: "ask",
        riskLevel: riskLevelForToolProfile(profile),
        name: `Tool profile ask before ${profile.originalToolName}`,
        description: describeToolProfilePolicy(profile, "requires confirmation"),
        reason: `Tool profile control: ${profile.canonicalToolId} has capability/risk tags ${profile.capabilityTags.concat(profile.riskTags).join(", ")}.`,
      });
    }

    if (shouldRedactForToolProfile(profile) && targetType === "api_call") {
      policies.push({
        policyId: createId("policy"),
        sourceWeaknessIds: [sourceId],
        name: `Tool profile redact outbound payload for ${profile.originalToolName}`,
        description: describeToolProfilePolicy(profile, "may send sensitive data through an API"),
        targetType,
        action: "redact",
        riskLevel: "high",
        match: {
          relation: "all",
          matchers: [
            targetMatcherForToolProfile(profile),
            {
              fieldPath: "payload.data",
              operator: "regex",
              value: "(token|secret|password|credential|private[_-]?key|api[_-]?key)",
              caseSensitive: false,
            },
          ],
        },
        reason: `Tool profile control: redact sensitive outbound API payloads for ${profile.canonicalToolId}.`,
      });
    }

    if (shouldRedactForToolProfile(profile) && targetType === "email_send") {
      policies.push({
        policyId: createId("policy"),
        sourceWeaknessIds: [sourceId],
        name: `Tool profile redact email body for ${profile.originalToolName}`,
        description: describeToolProfilePolicy(profile, "may send sensitive data through email"),
        targetType,
        action: "redact",
        riskLevel: "high",
        match: {
          relation: "all",
          matchers: [
            targetMatcherForToolProfile(profile),
            {
              fieldPath: "payload.bodyPreview",
              operator: "regex",
              value: "(token|secret|password|credential|private[_-]?key|api[_-]?key)",
              caseSensitive: false,
            },
          ],
        },
        reason: `Tool profile control: redact sensitive email bodies for ${profile.canonicalToolId}.`,
      });
    }

    if (shouldWarnForToolProfile(profile)) {
      policies.push({
        policyId: createId("policy"),
        ...base,
        action: "warn",
        riskLevel: "medium",
        name: `Tool profile warn on injection surface ${profile.originalToolName}`,
        description: describeToolProfilePolicy(profile, "may expose prompt-injection content"),
        reason: `Tool profile control: prompt-injection surface observed for ${profile.canonicalToolId}.`,
      });
    }

    return policies;
  });
}

function baselinePoliciesForTool(toolId: string): SupervisionPolicy[] {
  const category = categoryForToolId(toolId);
  return baselineDefaultsForCategory(category)
    .filter((defaults) => defaults.targetType !== "agent_message")
    .map((defaults) => ({
      policyId: createId("policy"),
      sourceWeaknessIds: [`baseline.tool.${safeId(toolId)}`],
      name: `${defaults.name}: ${toolId}`,
      description: `${defaults.description} Source high-risk tool: ${toolId}.`,
      targetType: defaults.targetType,
      action: defaults.action,
      riskLevel: defaults.riskLevel,
      match:
        defaults.targetType === "tool_call"
          ? {
              relation: "all" as const,
              matchers: [{ fieldPath: "payload.toolId", operator: "equals" as const, value: toolId }],
            }
          : defaults.match,
      reason: `${defaults.reason} Source high-risk tool: ${toolId}.`,
    }));
}

function dedupeToolProfiles(
  toolProfiles: ToolCapabilityProfile[],
): ToolCapabilityProfile[] {
  const byToolId = new Map<string, ToolCapabilityProfile>();
  for (const profile of toolProfiles) {
    const existing = byToolId.get(profile.canonicalToolId);
    if (!existing || toolProfileStrength(profile) > toolProfileStrength(existing)) {
      byToolId.set(profile.canonicalToolId, profile);
    }
  }
  return [...byToolId.values()];
}

function toolProfileStrength(profile: ToolCapabilityProfile): number {
  const confidenceRank: Record<ToolCapabilityProfile["confidence"], number> = {
    low: 1,
    medium: 2,
    high: 3,
  };
  return (
    confidenceRank[profile.confidence] +
    profile.capabilityTags.length +
    profile.riskTags.length +
    profile.surfaces.length
  );
}

function targetTypeForToolProfile(
  profile: ToolCapabilityProfile,
): SupervisionTargetType {
  const capabilityTags = new Set(profile.capabilityTags);
  const surfaces = new Set(profile.surfaces);
  const operations = new Set(profile.operations);

  if (capabilityTags.has("shell.execute") || operations.has("execute") || surfaces.has("code")) {
    return "code_execution";
  }
  if (capabilityTags.has("email.send") || surfaces.has("communication")) {
    return "email_send";
  }
  if (capabilityTags.has("network.http") || surfaces.has("network") || surfaces.has("browser")) {
    return "api_call";
  }
  if (capabilityTags.has("filesystem.write")) {
    return "file_write";
  }
  return "tool_call";
}

function shouldAskForToolProfile(profile: ToolCapabilityProfile): boolean {
  const tags = new Set([...profile.capabilityTags, ...profile.riskTags]);
  return (
    profile.confidence === "low" ||
    profile.sideEffect === "write" ||
    profile.sideEffect === "external" ||
    profile.sideEffect === "destructive" ||
    profile.networkReachability === "external" ||
    hasAny(tags, [
      "unknown.tool",
      "unknown_behavior",
      "external_side_effect",
      "destructive",
      "privilege_escalation",
      "data_exfiltration",
      "sensitive_data",
      "credential_access",
      "secret.access",
      "credential.submit",
      "shell.execute",
      "memory.write",
      "browser.navigate",
      "database.query",
    ])
  );
}

function shouldRedactForToolProfile(profile: ToolCapabilityProfile): boolean {
  const tags = new Set([...profile.capabilityTags, ...profile.riskTags]);
  return (
    hasAny(tags, [
      "data_exfiltration",
      "sensitive_data",
      "credential_access",
      "credential.submit",
      "secret.access",
    ]) ||
    profile.dataClasses.some((dataClass) => /secret|credential|token|pii/i.test(dataClass)) ||
    profile.sensitiveFields.length > 0
  );
}

function shouldWarnForToolProfile(profile: ToolCapabilityProfile): boolean {
  const tags = new Set([...profile.capabilityTags, ...profile.riskTags]);
  return (
    hasAny(tags, ["prompt_injection_surface"]) ||
    profile.surfaces.some((surface) => surface === "browser" || surface === "memory" || surface === "model")
  );
}

function riskLevelForToolProfile(profile: ToolCapabilityProfile): RiskLevel {
  const tags = new Set([...profile.capabilityTags, ...profile.riskTags]);
  if (
    profile.sideEffect === "destructive" ||
    hasAny(tags, ["destructive", "privilege_escalation"]) ||
    profile.networkReachability === "external" && hasAny(tags, ["data_exfiltration", "credential_access"])
  ) {
    return "critical";
  }
  if (
    profile.sideEffect === "external" ||
    profile.sideEffect === "write" ||
    hasAny(tags, [
      "external_side_effect",
      "data_exfiltration",
      "sensitive_data",
      "credential_access",
      "secret.access",
      "shell.execute",
    ])
  ) {
    return "high";
  }
  return profile.confidence === "low" ? "medium" : "medium";
}

function targetMatchForToolProfile(
  profile: ToolCapabilityProfile,
): SupervisionPolicy["match"] {
  return {
    relation: "all",
    matchers: [targetMatcherForToolProfile(profile)],
  };
}

function targetMatcherForToolProfile(
  profile: ToolCapabilityProfile,
): NonNullable<SupervisionPolicy["match"]["matchers"]>[number] {
  return {
    fieldPath: "targetId",
    operator: "equals",
    value: profile.canonicalToolId,
  };
}

function describeToolProfilePolicy(
  profile: ToolCapabilityProfile,
  control: string,
): string {
  return [
    `Generated from tool capability profile for ${profile.canonicalToolId}: ${control}.`,
    `Surfaces=${profile.surfaces.join(",") || "unknown"}.`,
    `Operations=${profile.operations.join(",") || "unknown"}.`,
    `SideEffect=${profile.sideEffect}.`,
    `RiskTags=${profile.riskTags.join(",") || "none"}.`,
    `Source=${profile.profileSource}${profile.llmAssisted ? "/llm" : ""}.`,
  ].join(" ");
}

function hasAny(values: Set<string>, expected: string[]): boolean {
  return expected.some((value) => values.has(value));
}

function dedupePolicies(policies: SupervisionPolicy[]): SupervisionPolicy[] {
  const byKey = new Map<string, SupervisionPolicy>();
  for (const policy of policies) {
    const key = [
      policy.targetType,
      policy.action,
      JSON.stringify(policy.match),
    ].join("|");
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, policy);
      continue;
    }
    existing.sourceWeaknessIds = [
      ...new Set([...existing.sourceWeaknessIds, ...policy.sourceWeaknessIds]),
    ];
    existing.description = `${existing.description} ${policy.description}`;
    existing.reason = `${existing.reason} ${policy.reason}`;
  }
  return [...byKey.values()];
}

function riskLevelForTemplate(template: PolicyTemplate): RiskLevel {
  if (template.action === "warn") return "medium";
  if (template.action === "allow") return "low";
  if (template.action === "deny" && template.riskCategory === "data_leakage") {
    return "critical";
  }
  return "high";
}

function strongerRiskLevel(left: RiskLevel, right: RiskLevel): RiskLevel {
  const rank: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };
  return rank[right] > rank[left] ? right : left;
}

function categoryForToolId(toolId: string): RiskCategory {
  const normalized = toolId.toLowerCase();
  if (/(send_request|call_api|email|network|http|webhook)/.test(normalized)) {
    return "data_leakage";
  }
  if (/(exec|execute|bash|shell|write|delete|memory)/.test(normalized)) {
    return "dangerous_action";
  }
  if (/(read|resource|database|query)/.test(normalized)) {
    return "unauthorized_access";
  }
  return "tool_misuse";
}

function safeId(value: string): string {
  return (
    value
      .replace(/^tool[._-]/i, "tool_")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "unknown"
  );
}

function buildExpiryIso(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1000).toISOString();
}
