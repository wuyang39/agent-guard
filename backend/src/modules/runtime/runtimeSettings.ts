export type RuntimeLlmMode = "disabled" | "mock" | "openai_compatible";

export type RuntimeLlmSettings = {
  enabled: boolean;
  mode: RuntimeLlmMode;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  timeoutMs: number;
  source: "runtime" | "env" | "default";
};

export type RuntimeLlmSettingsInput = {
  enabled?: boolean;
  mode?: RuntimeLlmMode;
  endpoint?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
};

export type RuntimeDownstreamMcpSettings = {
  enabled: boolean;
  providerId: string;
  providerName: string;
  endpointUrl?: string;
  timeoutMs: number;
  source: "runtime" | "env" | "default";
};

export type RuntimeDownstreamMcpSettingsInput = {
  enabled?: boolean;
  providerId?: string;
  providerName?: string;
  endpointUrl?: string;
  timeoutMs?: number;
};

export type RuntimeSettingsSnapshot = {
  schemaVersion: "mvp-1";
  llm: RuntimeLlmSettings & { hasApiKey: boolean; apiKey?: never };
  downstreamMcp: RuntimeDownstreamMcpSettings;
  updatedAt: string;
};

let runtimeLlmOverride: RuntimeLlmSettingsInput | undefined;
let runtimeDownstreamMcpOverride: RuntimeDownstreamMcpSettingsInput | undefined;
let runtimeSettingsUpdatedAt = new Date(0).toISOString();

export function getRuntimeSettingsSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeSettingsSnapshot {
  const llm = getResolvedRuntimeLlmSettings(env);
  return {
    schemaVersion: "mvp-1",
    llm: {
      ...llm,
      hasApiKey: Boolean(llm.apiKey),
      apiKey: undefined,
    },
    downstreamMcp: getResolvedRuntimeDownstreamMcpSettings(env),
    updatedAt: runtimeSettingsUpdatedAt,
  };
}

export function getResolvedRuntimeLlmSettings(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeLlmSettings {
  if (runtimeLlmOverride) {
    return normalizeRuntimeLlmSettings(runtimeLlmOverride, "runtime");
  }

  const enabled =
    env.AGENT_GUARD_LLM_ENABLED === "1" ||
    env.AGENT_GUARD_LLM_ENABLED === "true";
  const hasEnv =
    env.AGENT_GUARD_LLM_ENABLED !== undefined ||
    env.AGENT_GUARD_LLM_MODE !== undefined ||
    env.AGENT_GUARD_LLM_ENDPOINT !== undefined ||
    env.AGENT_GUARD_LLM_API_KEY !== undefined ||
    env.AGENT_GUARD_LLM_MODEL !== undefined;

  return normalizeRuntimeLlmSettings(
    {
      enabled,
      mode: enabled ? parseLlmMode(env.AGENT_GUARD_LLM_MODE) : "disabled",
      endpoint: env.AGENT_GUARD_LLM_ENDPOINT,
      apiKey: env.AGENT_GUARD_LLM_API_KEY,
      model: env.AGENT_GUARD_LLM_MODEL,
      timeoutMs: parsePositiveInt(env.AGENT_GUARD_LLM_TIMEOUT_MS),
    },
    hasEnv ? "env" : "default",
  );
}

export function setRuntimeLlmSettings(
  input: RuntimeLlmSettingsInput,
): RuntimeSettingsSnapshot {
  const current = getResolvedRuntimeLlmSettings();
  runtimeLlmOverride = normalizeRuntimeLlmSettings(
    {
      ...input,
      apiKey: cleanOptional(input.apiKey) ?? current.apiKey,
    },
    "runtime",
  );
  runtimeSettingsUpdatedAt = new Date().toISOString();
  return getRuntimeSettingsSnapshot();
}

export function getResolvedRuntimeDownstreamMcpSettings(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeDownstreamMcpSettings {
  if (runtimeDownstreamMcpOverride) {
    return normalizeRuntimeDownstreamMcpSettings(
      runtimeDownstreamMcpOverride,
      "runtime",
    );
  }

  const endpointUrl = env.AGENT_GUARD_DOWNSTREAM_MCP_URL?.trim();
  const hasEnv =
    endpointUrl !== undefined ||
    env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_ID !== undefined ||
    env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_NAME !== undefined ||
    env.AGENT_GUARD_DOWNSTREAM_MCP_TIMEOUT_MS !== undefined;

  return normalizeRuntimeDownstreamMcpSettings(
    {
      enabled: Boolean(endpointUrl),
      providerId: env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_ID,
      providerName: env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_NAME,
      endpointUrl,
      timeoutMs: parsePositiveInt(env.AGENT_GUARD_DOWNSTREAM_MCP_TIMEOUT_MS),
    },
    hasEnv ? "env" : "default",
  );
}

export function setRuntimeDownstreamMcpSettings(
  input: RuntimeDownstreamMcpSettingsInput,
): RuntimeSettingsSnapshot {
  runtimeDownstreamMcpOverride = normalizeRuntimeDownstreamMcpSettings(
    input,
    "runtime",
  );
  runtimeSettingsUpdatedAt = new Date().toISOString();
  return getRuntimeSettingsSnapshot();
}

function normalizeRuntimeLlmSettings(
  input: RuntimeLlmSettingsInput,
  source: RuntimeLlmSettings["source"],
): RuntimeLlmSettings {
  const enabled = Boolean(input.enabled);
  const mode = enabled ? parseLlmMode(input.mode) : "disabled";
  return {
    enabled,
    mode,
    endpoint: cleanOptional(input.endpoint),
    apiKey: cleanOptional(input.apiKey),
    model: cleanOptional(input.model) ?? (mode === "mock" ? "mock-tool-profiler" : undefined),
    timeoutMs: input.timeoutMs && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : 5000,
    source,
  };
}

function normalizeRuntimeDownstreamMcpSettings(
  input: RuntimeDownstreamMcpSettingsInput,
  source: RuntimeDownstreamMcpSettings["source"],
): RuntimeDownstreamMcpSettings {
  const endpointUrl = cleanOptional(input.endpointUrl);
  return {
    enabled: input.enabled ?? Boolean(endpointUrl),
    providerId: safeProviderId(input.providerId ?? "external_mcp"),
    providerName: cleanOptional(input.providerName) ?? "External MCP Provider",
    endpointUrl,
    timeoutMs: input.timeoutMs && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : 5000,
    source,
  };
}

function parseLlmMode(value: unknown): RuntimeLlmMode {
  if (value === "mock" || value === "openai_compatible" || value === "disabled") {
    return value;
  }
  return "mock";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function cleanOptional(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeProviderId(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || "external_mcp"
  );
}
