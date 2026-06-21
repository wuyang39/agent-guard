import type {
  JsonObject,
  ToolCapabilityProfile,
  ToolOperation,
  ToolProviderType,
  ToolSideEffect,
  ToolSurface,
} from "@agent-guard/contracts";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";

export type BuildToolCapabilityProfileInput = {
  originalToolName: string;
  canonicalToolId: string;
  providerType: ToolProviderType;
  description?: string;
  inputSchema?: JsonObject;
};

export function buildRuleBasedToolCapabilityProfile(
  input: BuildToolCapabilityProfileInput,
): ToolCapabilityProfile {
  const haystack = [
    input.originalToolName,
    input.canonicalToolId,
    input.description ?? "",
    JSON.stringify(input.inputSchema ?? {}),
  ].join(" ").toLowerCase();

  const surfaces = new Set<ToolSurface>(["tool"]);
  const operations = new Set<ToolOperation>();
  const capabilityTags = new Set<string>();
  const riskTags = new Set<string>();
  const dataClasses = new Set<string>();
  const authScopes = new Set<string>();
  let sideEffect: ToolSideEffect = "unknown";
  let networkReachability: ToolCapabilityProfile["networkReachability"] = "unknown";
  let confidence: ToolCapabilityProfile["confidence"] = "medium";

  if (matches(haystack, ["read_file", "read file", "filesystem", "file read", "path"])) {
    surfaces.add("resource");
    operations.add("read");
    capabilityTags.add("filesystem.read");
    sideEffect = strongerSideEffect(sideEffect, "read");
  }

  if (matches(haystack, ["write_file", "write file", "file write", "overwrite", "content"])) {
    surfaces.add("resource");
    operations.add("write");
    capabilityTags.add("filesystem.write");
    riskTags.add("external_side_effect");
    sideEffect = strongerSideEffect(sideEffect, "write");
  }

  if (matches(haystack, ["execute_code", "exec", "bash", "shell", "command", "powershell", "python"])) {
    surfaces.add("code");
    operations.add("execute");
    capabilityTags.add("shell.execute");
    riskTags.add("destructive");
    riskTags.add("privilege_escalation");
    sideEffect = strongerSideEffect(sideEffect, "destructive");
  }

  if (matches(haystack, ["call_api", "send_request", "fetch", "http", "url", "webhook", "request"])) {
    surfaces.add("network");
    operations.add("send");
    capabilityTags.add("network.http");
    riskTags.add("external_side_effect");
    riskTags.add("data_exfiltration");
    networkReachability = "external";
    sideEffect = strongerSideEffect(sideEffect, "external");
  }

  if (matches(haystack, ["send_email", "email", "subject", "recipient"])) {
    surfaces.add("communication");
    operations.add("send");
    capabilityTags.add("email.send");
    riskTags.add("external_side_effect");
    riskTags.add("data_exfiltration");
    sideEffect = strongerSideEffect(sideEffect, "external");
  }

  if (matches(haystack, ["database", "sql", "query_database", "query"])) {
    surfaces.add("database");
    operations.add("query");
    capabilityTags.add("database.query");
    sideEffect = strongerSideEffect(sideEffect, "read");
  }

  if (matches(haystack, ["memory", "remember", "update_memory", "long-term"])) {
    surfaces.add("memory");
    operations.add("write");
    capabilityTags.add("memory.write");
    riskTags.add("prompt_injection_surface");
    sideEffect = strongerSideEffect(sideEffect, "write");
  }

  if (matches(haystack, ["browser", "navigate", "page", "dom"])) {
    surfaces.add("browser");
    operations.add("navigate");
    capabilityTags.add("browser.navigate");
    riskTags.add("prompt_injection_surface");
    networkReachability = "external";
    sideEffect = strongerSideEffect(sideEffect, "external");
  }

  if (matches(haystack, ["token", "secret", "password", "credential", "private_key", "api_key"])) {
    capabilityTags.add("secret.access");
    riskTags.add("sensitive_data");
    riskTags.add("credential_access");
    dataClasses.add("secret");
  }

  const sensitiveFields = extractSensitiveFields(input.inputSchema ?? {});
  for (const field of sensitiveFields) {
    riskTags.add("sensitive_data");
    dataClasses.add("secret");
    if (field.includes("credential") || field.includes("token") || field.includes("password")) {
      capabilityTags.add("credential.submit");
      riskTags.add("credential_access");
    }
  }

  if (operations.size === 0) {
    operations.add("unknown");
  }
  if (surfaces.size === 1 && surfaces.has("tool")) {
    surfaces.add("unknown");
  }
  if (capabilityTags.size === 0) {
    capabilityTags.add("unknown.tool");
  }
  if (riskTags.size === 0) {
    riskTags.add("unknown_behavior");
    confidence = "low";
  }
  if (sideEffect === "unknown" && operations.has("read")) {
    sideEffect = "read";
  }
  if (networkReachability === "unknown" && !surfaces.has("network") && !surfaces.has("browser")) {
    networkReachability = "none";
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    originalToolName: input.originalToolName,
    canonicalToolId: input.canonicalToolId,
    providerType: input.providerType,
    surfaces: [...surfaces],
    operations: [...operations],
    capabilityTags: [...capabilityTags],
    riskTags: [...riskTags],
    sideEffect,
    dataClasses: [...dataClasses],
    authScopes: [...authScopes],
    networkReachability,
    sensitiveFields,
    confidence,
    profileSource: "rule",
    llmAssisted: false,
  };
}

function matches(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function strongerSideEffect(
  current: ToolSideEffect,
  next: ToolSideEffect,
): ToolSideEffect {
  const rank: Record<ToolSideEffect, number> = {
    none: 0,
    read: 1,
    write: 2,
    external: 3,
    destructive: 4,
    unknown: -1,
  };
  return rank[next] > rank[current] ? next : current;
}

function extractSensitiveFields(schema: JsonObject): string[] {
  const result = new Set<string>();
  const visit = (value: unknown, path: string[]): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const fieldPath = [...path, key].join(".");
      if (/(token|secret|password|credential|private[_-]?key|api[_-]?key)/i.test(key)) {
        result.add(fieldPath);
      }
      visit(child, [...path, key]);
    }
  };
  visit(schema, []);
  return [...result];
}
