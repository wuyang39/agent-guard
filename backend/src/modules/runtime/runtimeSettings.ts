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
  servers: RuntimeMcpServerSettings[];
  enabled: boolean;
  providerId: string;
  providerName: string;
  endpointUrl?: string;
  timeoutMs: number;
  source: "runtime" | "env" | "default";
};

export type RuntimeMcpServerSettings = {
  enabled: boolean;
  providerId: string;
  providerName: string;
  endpointUrl?: string;
  timeoutMs: number;
};

export type RuntimeDownstreamMcpSettingsInput = {
  enabled?: boolean;
  providerId?: string;
  providerName?: string;
  endpointUrl?: string;
  timeoutMs?: number;
  servers?: RuntimeMcpServerSettingsInput[];
};

export type RuntimeMcpServerSettingsInput = {
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
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

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

  const endpoint = resolveEnvLlmEndpoint(env);
  const apiKey = resolveEnvLlmApiKey(env);
  const model = resolveEnvLlmModel(env);
  const hasCompleteOpenAiCompatibleEnv = Boolean(endpoint && apiKey && model);
  const explicitEnabled = parseOptionalBoolean(env.AGENT_GUARD_LLM_ENABLED);
  const enabled = explicitEnabled ?? hasCompleteOpenAiCompatibleEnv;
  const explicitMode = parseOptionalLlmMode(env.AGENT_GUARD_LLM_MODE);
  const mode = enabled
    ? explicitMode ?? (hasCompleteOpenAiCompatibleEnv ? "openai_compatible" : "mock")
    : "disabled";
  const hasEnv =
    env.AGENT_GUARD_LLM_ENABLED !== undefined ||
    env.AGENT_GUARD_LLM_MODE !== undefined ||
    env.AGENT_GUARD_LLM_ENDPOINT !== undefined ||
    env.AGENT_GUARD_LLM_KEY !== undefined ||
    env.AGENT_GUARD_LLM_API_KEY !== undefined ||
    env.AGENT_GUARD_LLM_MODEL !== undefined ||
    env.AGENT_GUARD_LLM_TIMEOUT_MS !== undefined ||
    env.OPENAI_CHAT_ENDPOINT !== undefined ||
    env.OPENAI_CHAT_KEY !== undefined ||
    env.OPENAI_CHAT_MODEL !== undefined ||
    env.AGENT_GUARD_PYRIT_OPENAI_CHAT_ENDPOINT !== undefined ||
    env.AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY !== undefined ||
    env.AGENT_GUARD_PYRIT_OPENAI_CHAT_MODEL !== undefined ||
    env.AGENT_GUARD_PYRIT_OPENCLAW_CHAT_ENDPOINT !== undefined ||
    env.OPENCLAW_CHAT_ENDPOINT !== undefined ||
    env.DEEPSEEK_ENDPOINT !== undefined ||
    env.DEEPSEEK_API_KEY !== undefined ||
    env.DEEPSEEK_MODEL !== undefined;

  return normalizeRuntimeLlmSettings(
    {
      enabled,
      mode,
      endpoint,
      apiKey,
      model,
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
  const envServers = parseEnvMcpServers(env.AGENT_GUARD_DOWNSTREAM_MCP_SERVERS);
  const hasEnv =
    endpointUrl !== undefined ||
    envServers.length > 0 ||
    env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_ID !== undefined ||
    env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_NAME !== undefined ||
    env.AGENT_GUARD_DOWNSTREAM_MCP_TIMEOUT_MS !== undefined;

  return normalizeRuntimeDownstreamMcpSettings(
    {
      providerId: env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_ID,
      providerName: env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_NAME,
      endpointUrl,
      timeoutMs: parsePositiveInt(env.AGENT_GUARD_DOWNSTREAM_MCP_TIMEOUT_MS),
      servers: envServers,
      enabled: Boolean(endpointUrl) || envServers.some((server) => server.enabled !== false && Boolean(server.endpointUrl)),
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

export function resolveRuntimeDownstreamMcpSettingsInput(
  input: RuntimeDownstreamMcpSettingsInput,
): RuntimeDownstreamMcpSettings {
  return normalizeRuntimeDownstreamMcpSettings(input, "runtime");
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
    timeoutMs: input.timeoutMs && input.timeoutMs > 0 ? Math.floor(input.timeoutMs) : DEFAULT_LLM_TIMEOUT_MS,
    source,
  };
}

function normalizeRuntimeDownstreamMcpSettings(
  input: RuntimeDownstreamMcpSettingsInput,
  source: RuntimeDownstreamMcpSettings["source"],
): RuntimeDownstreamMcpSettings {
  const endpointUrl = cleanOptional(input.endpointUrl);
  const explicitServers = (input.servers ?? [])
    .map((server) => normalizeMcpServer(server))
    .filter((server) => server.endpointUrl);
  const legacyServer = endpointUrl
    ? normalizeMcpServer({
        enabled: input.enabled ?? true,
        providerId: input.providerId,
        providerName: input.providerName,
        endpointUrl,
        timeoutMs: input.timeoutMs,
      })
    : undefined;
  const servers = ensureUniqueProviderIds(
    explicitServers.length > 0
      ? explicitServers
      : legacyServer
      ? [legacyServer]
      : [],
  );
  const firstServer = servers[0];
  const enabled = input.enabled ?? servers.some((server) => server.enabled && server.endpointUrl);
  return {
    servers,
    enabled,
    providerId: firstServer?.providerId ?? safeProviderId(input.providerId ?? "external_mcp"),
    providerName: firstServer?.providerName ?? cleanOptional(input.providerName) ?? "External MCP Provider",
    endpointUrl: firstServer?.endpointUrl ?? endpointUrl,
    timeoutMs: firstServer?.timeoutMs ?? normalizeTimeoutMs(input.timeoutMs),
    source,
  };
}

function normalizeMcpServer(input: RuntimeMcpServerSettingsInput): RuntimeMcpServerSettings {
  const endpointUrl = cleanOptional(input.endpointUrl);
  return {
    enabled: input.enabled ?? Boolean(endpointUrl),
    providerId: safeProviderId(input.providerId ?? "external_mcp"),
    providerName: cleanOptional(input.providerName) ?? "External MCP Provider",
    endpointUrl,
    timeoutMs: normalizeTimeoutMs(input.timeoutMs),
  };
}

function ensureUniqueProviderIds(
  servers: RuntimeMcpServerSettings[],
): RuntimeMcpServerSettings[] {
  const counts = new Map<string, number>();
  return servers.map((server) => {
    const count = counts.get(server.providerId) ?? 0;
    counts.set(server.providerId, count + 1);
    return count === 0
      ? server
      : { ...server, providerId: `${server.providerId}_${count + 1}` };
  });
}

function parseLlmMode(value: unknown): RuntimeLlmMode {
  if (value === "mock" || value === "openai_compatible" || value === "disabled") {
    return value;
  }
  return "mock";
}

function parseOptionalLlmMode(value: unknown): RuntimeLlmMode | undefined {
  return value === "mock" || value === "openai_compatible" || value === "disabled"
    ? value
    : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

function resolveEnvLlmEndpoint(env: NodeJS.ProcessEnv): string | undefined {
  return firstClean(
    env.AGENT_GUARD_LLM_ENDPOINT,
    env.OPENAI_CHAT_ENDPOINT,
    env.AGENT_GUARD_PYRIT_OPENAI_CHAT_ENDPOINT,
    env.AGENT_GUARD_PYRIT_OPENCLAW_CHAT_ENDPOINT,
    env.OPENCLAW_CHAT_ENDPOINT,
    env.DEEPSEEK_ENDPOINT,
  );
}

function resolveEnvLlmApiKey(env: NodeJS.ProcessEnv): string | undefined {
  return firstClean(
    env.AGENT_GUARD_LLM_API_KEY,
    env.AGENT_GUARD_LLM_KEY,
    env.OPENAI_CHAT_KEY,
    env.AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY,
    env.DEEPSEEK_API_KEY,
  );
}

function resolveEnvLlmModel(env: NodeJS.ProcessEnv): string | undefined {
  return firstClean(
    env.AGENT_GUARD_LLM_MODEL,
    env.OPENAI_CHAT_MODEL,
    env.AGENT_GUARD_PYRIT_OPENAI_CHAT_MODEL,
    env.DEEPSEEK_MODEL,
  );
}

function firstClean(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const cleaned = cleanOptional(value);
    if (cleaned) return cleaned;
  }
  return undefined;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeTimeoutMs(value: number | undefined): number {
  return value && value > 0 ? Math.floor(value) : 5000;
}

function parseEnvMcpServers(value: string | undefined): RuntimeMcpServerSettingsInput[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(isMcpServerInput);
    }
    if (isRecord(parsed)) {
      return Object.entries(parsed).map(([providerId, config]) => {
        if (typeof config === "string") {
          return { providerId, providerName: providerId, endpointUrl: config, enabled: true };
        }
        if (isRecord(config)) {
          return {
            providerId,
            providerName: typeof config.providerName === "string" ? config.providerName : providerId,
            endpointUrl: typeof config.endpointUrl === "string"
              ? config.endpointUrl
              : typeof config.url === "string"
              ? config.url
              : undefined,
            enabled: config.enabled !== false,
            timeoutMs: typeof config.timeoutMs === "number" ? config.timeoutMs : undefined,
          };
        }
        return { providerId, providerName: providerId, enabled: false };
      });
    }
  } catch {
    return [];
  }
  return [];
}

function isMcpServerInput(value: unknown): value is RuntimeMcpServerSettingsInput {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
