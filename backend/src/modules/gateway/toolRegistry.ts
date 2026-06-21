import type {
  ExternalToolRegistration,
  JsonObject,
  ToolCapabilityProfile,
  ToolProviderType,
} from "@agent-guard/contracts";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type { LlmClient } from "../llm/llmClient";
import { enhanceToolCapabilityProfileWithLlm } from "./llmToolProfiler";
import { buildRuleBasedToolCapabilityProfile } from "./toolCapabilityProfiler";

export type RegisterExternalToolInput = {
  providerId: string;
  providerName: string;
  providerType: ToolProviderType;
  originalToolName: string;
  canonicalToolId: string;
  description?: string;
  inputSchema?: JsonObject;
  outputSchema?: JsonObject;
  exposedToolName?: string;
  capabilityProfile?: ToolCapabilityProfile;
  enabled?: boolean;
};

export type RegisterExternalToolWithLlmOptions = {
  llmClient?: LlmClient;
  llmTimeoutMs?: number;
};

export class ExternalToolRegistry {
  private readonly byExposedName = new Map<string, ExternalToolRegistration>();
  private readonly byCanonicalId = new Map<string, ExternalToolRegistration>();

  register(input: RegisterExternalToolInput): ExternalToolRegistration {
    const exposedToolName =
      input.exposedToolName ?? buildGatewayToolName(input.providerId, input.originalToolName);
    const now = nowIso();
    const existing = this.byExposedName.get(exposedToolName);
    const capabilityProfile =
      input.capabilityProfile ??
      buildRuleBasedToolCapabilityProfile({
        originalToolName: input.originalToolName,
        canonicalToolId: input.canonicalToolId,
        providerType: input.providerType,
        description: input.description,
        inputSchema: input.inputSchema,
      });

    const registration: ExternalToolRegistration = {
      schemaVersion: SCHEMA_VERSION,
      registrationId:
        existing?.registrationId ??
        `external_tool.${safeId(input.providerId)}.${safeId(input.canonicalToolId)}`,
      providerId: input.providerId,
      providerName: input.providerName,
      providerType: input.providerType,
      originalToolName: input.originalToolName,
      exposedToolName,
      canonicalToolId: input.canonicalToolId,
      description: input.description ?? "",
      inputSchema: input.inputSchema ?? {},
      outputSchema: input.outputSchema,
      capabilityProfile,
      enabled: input.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.byExposedName.set(exposedToolName, registration);
    if (!this.byCanonicalId.has(input.canonicalToolId)) {
      this.byCanonicalId.set(input.canonicalToolId, registration);
    }
    return registration;
  }

  async registerWithLlm(
    input: RegisterExternalToolInput,
    opts: RegisterExternalToolWithLlmOptions = {},
  ): Promise<ExternalToolRegistration> {
    const baseProfile =
      input.capabilityProfile ??
      buildRuleBasedToolCapabilityProfile({
        originalToolName: input.originalToolName,
        canonicalToolId: input.canonicalToolId,
        providerType: input.providerType,
        description: input.description,
        inputSchema: input.inputSchema,
      });
    const capabilityProfile = await enhanceToolCapabilityProfileWithLlm(
      {
        providerId: input.providerId,
        providerName: input.providerName,
        originalToolName: input.originalToolName,
        canonicalToolId: input.canonicalToolId,
        description: input.description,
        inputSchema: input.inputSchema,
        baseProfile,
      },
      {
        client: opts.llmClient,
        timeoutMs: opts.llmTimeoutMs,
      },
    );
    return this.register({ ...input, capabilityProfile });
  }

  list(): ExternalToolRegistration[] {
    return [...this.byExposedName.values()].filter((tool) => tool.enabled);
  }

  removeProvider(providerId: string): void {
    for (const [name, registration] of this.byExposedName.entries()) {
      if (registration.providerId === providerId) {
        this.byExposedName.delete(name);
      }
    }
    for (const [toolId, registration] of this.byCanonicalId.entries()) {
      if (registration.providerId === providerId) {
        this.byCanonicalId.delete(toolId);
      }
    }
  }

  getByExposedName(name: string): ExternalToolRegistration | undefined {
    return this.byExposedName.get(name);
  }

  getByCanonicalId(toolId: string): ExternalToolRegistration | undefined {
    return this.byCanonicalId.get(toolId);
  }
}

export function buildGatewayToolName(providerId: string, originalToolName: string): string {
  return `agw__${safeId(providerId)}__${safeId(originalToolName)}`;
}

function safeId(value: string): string {
  return value
    .replace(/^tool[._-]/i, "tool_")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "unknown";
}
