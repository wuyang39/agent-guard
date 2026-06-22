import type { JsonObject, JsonValue } from "@agent-guard/contracts";
import { getResolvedRuntimeLlmSettings } from "../runtime/runtimeSettings";

export type LlmJsonRequest = {
  system: string;
  user: string;
  responseSchemaName: string;
  timeoutMs?: number;
};

export type LlmJsonResponse = {
  provider: string;
  model?: string;
  json: JsonObject;
};

export interface LlmClient {
  completeJson(request: LlmJsonRequest): Promise<LlmJsonResponse>;
}

export type LlmMode = "disabled" | "mock" | "openai_compatible";

export type LlmClientConfig = {
  enabled: boolean;
  mode: LlmMode;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
};

export function loadLlmClientConfig(env: NodeJS.ProcessEnv = process.env): LlmClientConfig {
  const settings = getResolvedRuntimeLlmSettings(env);
  return {
    enabled: settings.enabled,
    mode: settings.mode,
    endpoint: settings.endpoint,
    apiKey: settings.apiKey,
    model: settings.model,
    timeoutMs: settings.timeoutMs,
  };
}

export function createConfiguredLlmClient(
  config: LlmClientConfig = loadLlmClientConfig(),
): LlmClient | undefined {
  if (!config.enabled || config.mode === "disabled") return undefined;
  if (config.mode === "mock") return new MockLlmClient(config.model ?? "mock-tool-profiler");
  if (config.mode === "openai_compatible") {
    if (!config.endpoint || !config.apiKey || !config.model) return undefined;
    return new OpenAiCompatibleLlmClient(config);
  }
  return undefined;
}

export class MockLlmClient implements LlmClient {
  constructor(private readonly model = "mock-tool-profiler") {}

  async completeJson(request: LlmJsonRequest): Promise<LlmJsonResponse> {
    if (request.responseSchemaName === "TestSelectionPlanRerank") {
      const caseIds = [...request.user.matchAll(/caseId:\s*([A-Za-z0-9_.:-]+)/g)]
        .map((match) => match[1])
        .filter((value): value is string => Boolean(value));
      return {
        provider: "mock",
        model: this.model,
        json: {
          rankedCaseIds: caseIds,
          selectionReasons: caseIds.map((caseId) => ({
            caseId,
            reason: "Mock LLM kept rule candidate order and added an auditable selection reason.",
          })),
          coverageNotes: [
            "Mock LLM does not inspect full payloads; coverage is validated by deterministic rules.",
          ],
        },
      };
    }

    if (request.responseSchemaName === "SupervisionBatchExplanationDraft") {
      return {
        provider: "mock",
        model: this.model,
        json: {
          summary:
            "Mock LLM: batch explanation draft generated from runtime supervision counts.",
          keyFindings: [
            "Runtime policy hits and platform guardrail hits are separated.",
            "Batch cases remain linked to RuntimeSupervisionRecord IDs.",
          ],
          limitations: [
            "This is a B-line explanation draft and not a final DefenseReport claim.",
          ],
          rationale: "Mock batch explainer summarized counts and case outcomes.",
        },
      };
    }

    const haystack = `${request.system}\n${request.user}`.toLowerCase();
    const patch: Record<string, JsonValue> = {
      confidence: "medium",
      rationale: "Mock semantic profiler matched tool name, description, and schema hints.",
    };

    if (matches(haystack, ["gmail", "email", "mail", "draft", "recipient"])) {
      patch.surfaces = ["tool", "communication"];
      patch.operations = ["send", "write"];
      patch.capabilityTags = ["email.send"];
      patch.riskTags = ["external_side_effect", "data_exfiltration"];
      patch.sideEffect = "external";
      patch.networkReachability = "external";
      patch.confidence = "high";
    } else if (matches(haystack, ["db", "database", "sql", "query", "export"])) {
      patch.surfaces = ["tool", "database"];
      patch.operations = ["query", "read"];
      patch.capabilityTags = ["database.query"];
      patch.riskTags = ["sensitive_data", "unauthorized_access"];
      patch.sideEffect = "read";
      patch.networkReachability = "internal";
      patch.dataClasses = ["business_record", "pii"];
      patch.confidence = "high";
    } else if (matches(haystack, ["browser", "navigate", "click", "page", "dom"])) {
      patch.surfaces = ["tool", "browser", "network"];
      patch.operations = ["navigate"];
      patch.capabilityTags = ["browser.navigate"];
      patch.riskTags = ["prompt_injection_surface", "external_side_effect"];
      patch.sideEffect = "external";
      patch.networkReachability = "external";
    } else if (matches(haystack, ["shell", "command", "exec", "terminal", "powershell"])) {
      patch.surfaces = ["tool", "code"];
      patch.operations = ["execute"];
      patch.capabilityTags = ["shell.execute"];
      patch.riskTags = ["destructive", "privilege_escalation"];
      patch.sideEffect = "destructive";
      patch.confidence = "high";
    }

    if (matches(haystack, ["token", "secret", "password", "credential", "api_key"])) {
      patch.riskTags = unique([...(toStringArray(patch.riskTags)), "sensitive_data", "credential_access"]);
      patch.capabilityTags = unique([...(toStringArray(patch.capabilityTags)), "secret.access"]);
      patch.dataClasses = unique([...(toStringArray(patch.dataClasses)), "secret"]);
      patch.sensitiveFields = ["schema.properties.token", "schema.properties.password"];
    }

    return { provider: "mock", model: this.model, json: patch as JsonObject };
  }
}

class OpenAiCompatibleLlmClient implements LlmClient {
  constructor(private readonly config: LlmClientConfig) {}

  async completeJson(request: LlmJsonRequest): Promise<LlmJsonResponse> {
    const controller = new AbortController();
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const endpoint = resolveChatCompletionsEndpoint(this.config.endpoint ?? "");
      const provider = isDeepSeekEndpoint(endpoint) ? "deepseek" : "openai_compatible";
      const requestBody: Record<string, unknown> = {
        model: this.config.model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      };
      if (provider === "deepseek") {
        requestBody.thinking = { type: "disabled" };
      }

      const response = await fetch(endpoint.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `LLM HTTP ${response.status} at ${endpoint.toString()}: ${text.slice(0, 200)}`,
        );
      }
      const parsed = JSON.parse(text) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = parsed.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("LLM response missing choices[0].message.content");
      }
      return {
        provider,
        model: this.config.model,
        json: JSON.parse(content) as JsonObject,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`LLM request timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function resolveChatCompletionsEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  const normalizedPath = url.pathname.replace(/\/+$/g, "");
  if (normalizedPath.endsWith("/chat/completions")) {
    return url;
  }
  if (!normalizedPath || normalizedPath === "/") {
    url.pathname = "/chat/completions";
    return url;
  }
  if (normalizedPath.endsWith("/v1") || normalizedPath.endsWith("/beta")) {
    url.pathname = `${normalizedPath}/chat/completions`;
    return url;
  }
  url.pathname = `${normalizedPath}/chat/completions`;
  return url;
}

function isDeepSeekEndpoint(endpoint: URL): boolean {
  return endpoint.hostname === "api.deepseek.com" || endpoint.hostname.endsWith(".deepseek.com");
}

function matches(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function toStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
