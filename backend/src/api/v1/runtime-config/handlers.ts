import type { FastifyInstance } from "fastify";
import { success, failure } from "../../response";
import {
  createConfiguredLlmClient,
  type LlmClientConfig,
} from "../../../modules/llm/llmClient";
import { createHttpMcpDownstreamProvider } from "../../../modules/gateway/downstreamMcpProvider";
import {
  getResolvedRuntimeLlmSettings,
  getRuntimeSettingsSnapshot,
  resolveRuntimeDownstreamMcpSettingsInput,
  setRuntimeDownstreamMcpSettings,
  setRuntimeLlmSettings,
  type RuntimeDownstreamMcpSettingsInput,
  type RuntimeLlmSettingsInput,
} from "../../../modules/runtime/runtimeSettings";
import { reloadRealtimeMcpTools } from "../../../modules/openclaw/realtimeMcpServer";

const CONFIG_PATH = "/api/v1/runtime-config";
const LLM_PATH = "/api/v1/runtime-config/llm";
const LLM_CHECK_PATH = "/api/v1/runtime-config/llm/check";
const MCP_PATH = "/api/v1/runtime-config/downstream-mcp";
const MCP_CHECK_PATH = "/api/v1/runtime-config/downstream-mcp/check";
const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export async function runtimeConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(CONFIG_PATH, async () => success(getRuntimeSettingsSnapshot()));

  app.post(LLM_PATH, async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};
    const parsed = parseLlmSettings(body);
    if (!parsed.ok) {
      reply.code(400);
      return failure("INVALID_LLM_CONFIG", parsed.message);
    }
    return success(setRuntimeLlmSettings(parsed.config));
  });

  app.post(LLM_CHECK_PATH, async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};
    const parsed = Object.keys(body).length ? parseLlmSettings(body) : undefined;
    if (parsed && !parsed.ok) {
      reply.code(400);
      return failure("INVALID_LLM_CONFIG", parsed.message);
    }

    const llm = parsed?.ok
      ? normalizeLlmInputForCheck(parsed.config)
      : getResolvedRuntimeLlmSettings();
    const client = createConfiguredLlmClient({
      enabled: llm.enabled,
      mode: llm.mode,
      endpoint: llm.endpoint,
      model: llm.model,
      timeoutMs: llm.timeoutMs,
      apiKey: llm.apiKey,
    } satisfies LlmClientConfig);

    if (!client) {
      return success({
        available: false,
        provider: llm.mode,
        detail: "LLM 未启用或配置不完整。",
      });
    }

    try {
      const result = await client.completeJson({
        system: "Return a small JSON object for Agent Guard runtime config check.",
        user: JSON.stringify({ task: "runtime_config_check" }),
        responseSchemaName: "RuntimeConfigCheck",
        timeoutMs: llm.timeoutMs,
      });
      return success({
        available: true,
        provider: result.provider,
        model: result.model,
        detail: "LLM JSON 接口可用。",
      });
    } catch (error) {
      reply.code(502);
      return failure(
        "LLM_CHECK_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  app.post(MCP_PATH, async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};
    const parsed = parseDownstreamMcpSettings(body);
    if (!parsed.ok) {
      reply.code(400);
      return failure("INVALID_DOWNSTREAM_MCP_CONFIG", parsed.message);
    }
    const snapshot = setRuntimeDownstreamMcpSettings(parsed.config);
    const reload = await reloadRealtimeMcpTools();
    return success({ ...snapshot, gatewayReload: reload });
  });

  app.post(MCP_CHECK_PATH, async (request, reply) => {
    const body = isObject(request.body) ? request.body : {};
    const parsed = Object.keys(body).length
      ? parseDownstreamMcpSettings(body)
      : undefined;
    if (parsed && !parsed.ok) {
      reply.code(400);
      return failure("INVALID_DOWNSTREAM_MCP_CONFIG", parsed.message);
    }

    const config = parsed?.ok
      ? normalizeMcpInputForCheck(parsed.config)
      : getRuntimeSettingsSnapshot().downstreamMcp;
    const servers = config.servers.filter((server) => server.enabled && server.endpointUrl);
    if (!config.enabled || servers.length === 0) {
      return success({
        available: false,
        providerId: config.providerId,
        providerName: config.providerName,
        toolCount: 0,
        tools: [],
        providers: [],
        detail: "外部 MCP 未启用或 server endpoint 为空。",
      });
    }

    try {
      const providerResults = [];
      const allTools = [];
      for (const server of servers) {
        const provider = createHttpMcpDownstreamProvider({
          providerId: server.providerId,
          providerName: server.providerName,
          endpointUrl: server.endpointUrl as string,
          timeoutMs: server.timeoutMs,
        });
        const tools = await provider.listTools();
        providerResults.push({
          providerId: server.providerId,
          providerName: server.providerName,
          toolCount: tools.length,
        });
        allTools.push(
          ...tools.map((tool) => ({
            providerId: server.providerId,
            providerName: server.providerName,
            name: tool.originalToolName,
            canonicalToolId: tool.canonicalToolId,
            description: tool.description,
          })),
        );
      }
      return success({
        available: true,
        providerId: config.providerId,
        providerName: config.providerName,
        toolCount: allTools.length,
        tools: allTools,
        providers: providerResults,
        detail: `已读取 ${servers.length} 个外部 MCP server，共 ${allTools.length} 个工具。`,
      });
    } catch (error) {
      reply.code(502);
      return failure(
        "DOWNSTREAM_MCP_CHECK_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}

function normalizeLlmInputForCheck(config: RuntimeLlmSettingsInput) {
  const current = getResolvedRuntimeLlmSettings();
  const enabled = Boolean(config.enabled);
  const mode: LlmClientConfig["mode"] =
    enabled && (config.mode === "mock" || config.mode === "openai_compatible")
      ? config.mode
      : "disabled";
  return {
    enabled,
    mode,
    endpoint: config.endpoint?.trim() || undefined,
    apiKey: config.apiKey?.trim() || current.apiKey,
    model: config.model?.trim() || (mode === "mock" ? "mock-tool-profiler" : undefined),
    timeoutMs: config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_LLM_TIMEOUT_MS,
  };
}

function parseLlmSettings(
  body: Record<string, unknown>,
): { ok: true; config: RuntimeLlmSettingsInput } | { ok: false; message: string } {
  const mode = body.mode;
  if (
    mode !== undefined &&
    mode !== "disabled" &&
    mode !== "mock" &&
    mode !== "openai_compatible"
  ) {
    return { ok: false, message: "mode must be disabled, mock, or openai_compatible" };
  }

  return {
    ok: true,
    config: {
      enabled: body.enabled === true,
      mode,
      endpoint: typeof body.endpoint === "string" ? body.endpoint : undefined,
      apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      timeoutMs: parsePositiveInt(body.timeoutMs),
    },
  };
}

function parseDownstreamMcpSettings(
  body: Record<string, unknown>,
):
  | { ok: true; config: RuntimeDownstreamMcpSettingsInput }
  | { ok: false; message: string } {
  const enabled = body.enabled === true;
  const endpointUrl = typeof body.endpointUrl === "string" ? body.endpointUrl.trim() : "";
  const servers = Array.isArray(body.servers)
    ? body.servers.filter(isObject).map((server) => ({
        enabled: server.enabled !== false,
        providerId: typeof server.providerId === "string" ? server.providerId : undefined,
        providerName: typeof server.providerName === "string" ? server.providerName : undefined,
        endpointUrl: typeof server.endpointUrl === "string" ? server.endpointUrl : undefined,
        timeoutMs: parsePositiveInt(server.timeoutMs),
      }))
    : undefined;
  const hasServerEndpoint = (servers ?? []).some((server) => server.enabled && server.endpointUrl?.trim());
  if (enabled && !endpointUrl && !hasServerEndpoint) {
    return { ok: false, message: "endpointUrl or servers[] is required when downstream MCP is enabled" };
  }
  return {
    ok: true,
    config: {
      enabled,
      providerId: typeof body.providerId === "string" ? body.providerId : undefined,
      providerName: typeof body.providerName === "string" ? body.providerName : undefined,
      endpointUrl,
      timeoutMs: parsePositiveInt(body.timeoutMs),
      servers,
    },
  };
}

function normalizeMcpInputForCheck(config: RuntimeDownstreamMcpSettingsInput) {
  return resolveRuntimeDownstreamMcpSettingsInput(config);
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
