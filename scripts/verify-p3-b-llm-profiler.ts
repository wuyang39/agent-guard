/**
 * verify-p3-b-llm-profiler.ts — B-line LLM tool profiler verification.
 */

import type { JsonObject, SupervisionBatchResult } from "@agent-guard/contracts";
import { buildSupervisionBatchExplanationDraft } from "../backend/src/modules/gateway/llmBatchExplainer";
import { buildRuleBasedToolCapabilityProfile } from "../backend/src/modules/gateway/toolCapabilityProfiler";
import {
  enhanceToolCapabilityProfileWithLlm,
  mergeToolCapabilityProfile,
} from "../backend/src/modules/gateway/llmToolProfiler";
import { ExternalToolRegistry } from "../backend/src/modules/gateway/toolRegistry";
import { MockLlmClient, type LlmClient } from "../backend/src/modules/llm/llmClient";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  console.log("P3-B LLM Tool Profiler Verification");

  const base = buildRuleBasedToolCapabilityProfile({
    providerType: "mcp",
    originalToolName: "gmail_create_draft",
    canonicalToolId: "tool.external.mail.gmail_create_draft",
    description: "Create a Gmail draft message with recipients, subject, and body.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
    },
  });
  assert(base.llmAssisted === false, "rule profile should not be LLM-assisted");
  console.log("1. rule-only profile ok");

  const enhanced = await enhanceToolCapabilityProfileWithLlm(
    {
      providerId: "google_workspace",
      providerName: "Google Workspace MCP",
      originalToolName: "gmail_create_draft",
      canonicalToolId: "tool.external.google.gmail_create_draft",
      description: "Create a Gmail draft message with recipients, subject, and body.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "array", items: { type: "string" } },
          subject: { type: "string" },
          body: { type: "string" },
        },
      },
      baseProfile: base,
    },
    { client: new MockLlmClient() },
  );
  assert(enhanced.llmAssisted === true, "enhanced profile should be LLM-assisted");
  assert(enhanced.profileSource === "mixed", "enhanced profile should be mixed source");
  assert(enhanced.capabilityTags.includes("email.send"), "email capability missing");
  assert(enhanced.riskTags.includes("data_exfiltration"), "email data exfiltration risk missing");
  assert(enhanced.llmMetadata?.provider === "mock", "LLM metadata provider missing");
  console.log("2. mock LLM email profile enhancement ok");

  const dbBase = buildRuleBasedToolCapabilityProfile({
    providerType: "mcp",
    originalToolName: "db_admin_export",
    canonicalToolId: "tool.external.db.db_admin_export",
    description: "Export tenant database records to CSV.",
    inputSchema: { type: "object", properties: { tenantId: { type: "string" } } },
  });
  const dbEnhanced = await enhanceToolCapabilityProfileWithLlm(
    {
      providerId: "admin_db",
      providerName: "Admin Database MCP",
      originalToolName: "db_admin_export",
      canonicalToolId: "tool.external.db.db_admin_export",
      description: "Export tenant database records to CSV.",
      inputSchema: { type: "object", properties: { tenantId: { type: "string" } } },
      baseProfile: dbBase,
    },
    { client: new MockLlmClient() },
  );
  assert(dbEnhanced.surfaces.includes("database"), "database surface missing");
  assert(dbEnhanced.riskTags.includes("sensitive_data"), "database sensitive_data risk missing");
  console.log("3. mock LLM database profile enhancement ok");

  const badClient: LlmClient = {
    async completeJson() {
      return {
        provider: "bad_mock",
        model: "bad",
        json: {
          surfaces: ["not_a_surface", "network"],
          operations: ["not_an_operation", "send"],
          sideEffect: "teleport",
          networkReachability: "external",
          confidence: "impossible",
          capabilityTags: ["network.http"],
          riskTags: ["data_exfiltration"],
        } as JsonObject,
      };
    },
  };
  const sanitized = await enhanceToolCapabilityProfileWithLlm(
    {
      providerId: "bad_provider",
      providerName: "Bad Provider",
      originalToolName: "custom_send",
      canonicalToolId: "tool.external.bad.custom_send",
      description: "Send a webhook request.",
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
      baseProfile: buildRuleBasedToolCapabilityProfile({
        providerType: "mcp",
        originalToolName: "custom_send",
        canonicalToolId: "tool.external.bad.custom_send",
        description: "Send a webhook request.",
        inputSchema: { type: "object", properties: { url: { type: "string" } } },
      }),
    },
    { client: badClient },
  );
  assert(!sanitized.surfaces.includes("not_a_surface" as never), "invalid surface leaked");
  assert(sanitized.surfaces.includes("network"), "valid network surface missing");
  assert(sanitized.operations.includes("send"), "valid send operation missing");
  assert(sanitized.sideEffect === "external", "invalid sideEffect should not override base/valid risk");
  console.log("4. invalid LLM enum filtering ok");

  const registry = new ExternalToolRegistry();
  const registered = await registry.registerWithLlm(
    {
      providerId: "google_workspace",
      providerName: "Google Workspace MCP",
      providerType: "mcp",
      originalToolName: "gmail_create_draft",
      canonicalToolId: "tool.external.google.gmail_create_draft",
      description: "Create a Gmail draft message.",
      inputSchema: { type: "object", properties: { body: { type: "string" } } },
    },
    { llmClient: new MockLlmClient() },
  );
  assert(registered.capabilityProfile.llmAssisted, "registry LLM profile missing");
  assert(
    registry.getByExposedName("agw__google_workspace__gmail_create_draft")?.capabilityProfile.llmAssisted === true,
    "registry lookup should preserve LLM profile",
  );
  console.log("5. registry registerWithLlm ok");

  const merged = mergeToolCapabilityProfile(base, {}, {
    provider: "mock",
    model: "empty",
    promptVersion: "test",
    generatedAt: new Date(0).toISOString(),
  });
  assert(merged.llmAssisted === true, "merge should mark llmAssisted");
  assert(merged.capabilityTags.includes("email.send"), "merge should retain base tags");
  console.log("6. merge fallback semantics ok");

  const batch: SupervisionBatchResult = {
    schemaVersion: "mvp-1",
    batchId: "batch.verify.llm",
    runtimeSessionId: "session.verify.llm",
    policyPackId: "policy_pack.verify.llm",
    source: "external_unknown_test_pack",
    externalCaseCount: 2,
    supervisedToolCallCount: 2,
    policyHitCount: 1,
    guardrailHitCount: 1,
    blockedCount: 1,
    askCount: 0,
    warnedCount: 0,
    redactedCount: 0,
    allowedCount: 0,
    recordIds: ["record.policy", "record.guardrail"],
    cases: [
      {
        externalCaseId: "case.policy_block",
        toolName: "agent_guard_read_file",
        status: "blocked",
        blocked: true,
        recordIds: ["record.policy"],
        actionCounts: { deny: 1 },
      },
      {
        externalCaseId: "case.unknown_tool",
        toolName: "unknown_tool",
        status: "blocked",
        blocked: true,
        recordIds: ["record.guardrail"],
        actionCounts: { deny: 1 },
        gateway: {
          providerId: "unknown",
          providerName: "Unknown external provider",
          providerType: "unknown",
          originalToolName: "unknown_tool",
          exposedToolName: "unknown_tool",
          canonicalToolId: "tool.external.unknown.unknown_tool",
          capabilityProfileSnapshot: buildRuleBasedToolCapabilityProfile({
            providerType: "unknown",
            originalToolName: "unknown_tool",
            canonicalToolId: "tool.external.unknown.unknown_tool",
            description: "Unknown tool.",
            inputSchema: {},
          }),
          decisionSource: "platform_guardrail",
          batch: {
            batchId: "batch.verify.llm",
            externalCaseId: "case.unknown_tool",
            source: "external_unknown_test_pack",
          },
        },
      },
    ],
    startedAt: new Date(0).toISOString(),
    endedAt: new Date(1).toISOString(),
  };
  const explanation = await buildSupervisionBatchExplanationDraft(batch, {
    llmClient: new MockLlmClient(),
  });
  assert(explanation.llmAssisted === true, "batch explanation should be LLM-assisted");
  assert(explanation.llmMetadata?.provider === "mock", "batch explanation metadata missing");
  assert(explanation.caseExplanations.length === 2, "batch explanation case count mismatch");
  assert(
    explanation.caseExplanations.some(
      (item) =>
        item.externalCaseId === "case.unknown_tool" &&
        item.outcome === "platform_guardrail_blocked",
    ),
    "batch explanation guardrail outcome missing",
  );
  assert(
    explanation.caseExplanations.every((item) =>
      item.recordIds.every((recordId) => batch.recordIds.includes(recordId)),
    ),
    "batch explanation recordIds should remain deterministic",
  );
  console.log("7. batch explanation draft ok");

  console.log("P3-B LLM tool profiler verification passed.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
