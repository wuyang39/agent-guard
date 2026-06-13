import type { FastifyInstance } from "fastify";
import { success, failure } from "../../response";
import type { AgentCheckResult, AgentConnectionConfig, P2AdapterKind } from "../../types";
import { checkOpenClawAvailable } from "../../../modules/agent/openclawAdapter";
import {
  getActiveAgentConfig,
  getAgentConfig,
  listAgentConfigs,
  saveAgentConfig,
} from "../../../storage/agentConfigStore";

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/agents", async () => {
    const [agents, activeAgent] = await Promise.all([
      listAgentConfigs(),
      getActiveAgentConfig(),
    ]);
    return success({ agents, activeAgent });
  });

  app.post("/api/v1/agents", async (request, reply) => {
    const body = isObject(request.body) ? request.body : undefined;
    if (!body) {
      reply.code(400);
      return failure("BAD_REQUEST", "Request body is required");
    }

    const parsed = parseAgentConfig(body);
    if (!parsed.ok) {
      reply.code(400);
      return failure("BAD_REQUEST", parsed.message);
    }

    return success({ agent: await saveAgentConfig(parsed.config) });
  });

  app.get("/api/v1/agents/:agentId", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const agent = await getAgentConfig(agentId);
    if (!agent) {
      reply.code(404);
      return failure("NOT_FOUND", `Agent config ${agentId} not found`);
    }
    return success({ agent });
  });

  app.post("/api/v1/agents/:agentId/check", async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    const stored = await getAgentConfig(agentId);
    if (!stored) {
      reply.code(404);
      return failure("NOT_FOUND", `Agent config ${agentId} not found`);
    }

    const body = isObject(request.body) ? request.body : {};
    const override = parseAgentConfig({ ...stored, ...body });
    const config = override.ok ? override.config : stored;
    return success(await checkAgentConnection(config));
  });

  app.post("/api/v1/agents/check", async (request) => {
    const body = isObject(request.body) ? request.body : {};
    const parsed = parseAgentConfig({
      agentId: body.agentId ?? "agent.openclaw",
      name: body.name ?? "OpenClaw",
      adapterKind: body.adapterKind ?? "openclaw",
      openclawCliPath: body.cliPath ?? body.openclawCliPath,
      gatewayUrl: body.gatewayUrl ?? body.endpointUrl,
      endpointUrl: body.endpointUrl,
      timeoutMs: body.timeoutMs,
      caseIds: body.caseIds,
    });

    const config = parsed.ok
      ? parsed.config
      : {
          adapterKind: "openclaw",
          agentId: "agent.openclaw",
          name: "OpenClaw",
        } satisfies AgentConnectionConfig;
    return success(await checkAgentConnection(config));
  });
}

export async function checkAgentConnection(
  config: AgentConnectionConfig,
): Promise<AgentCheckResult> {
  if (config.adapterKind === "openclaw") {
    const check = await checkOpenClawAvailable(config.openclawCliPath).catch((error) => ({
      available: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    return {
      adapterKind: "openclaw",
      available: check.available,
      displayName: "OpenClaw",
      detail: check.available
        ? `OpenClaw CLI is available${"version" in check && check.version ? `: ${check.version}` : "."}`
        : check.error ?? "OpenClaw CLI is unavailable.",
      normalizedAgent: {
        agentId: config.agentId,
        name: config.name,
        adapterKind: "openclaw",
      },
    };
  }

  if (config.adapterKind === "http_sample") {
    const health = await checkHttpSampleAgent(config.endpointUrl);
    return {
      adapterKind: "http_sample",
      available: health.available,
      displayName: "HTTP API Agent",
      detail: health.detail,
      normalizedAgent: {
        agentId: config.agentId,
        name: config.name,
        adapterKind: "http_sample",
      },
    };
  }

  return {
    adapterKind: "mock",
    available: true,
    displayName: "Mock Agent",
    detail: "Mock adapter is always available for deterministic fallback runs.",
    normalizedAgent: {
      agentId: config.agentId,
      name: config.name,
      adapterKind: "mock",
    },
  };
}

async function checkHttpSampleAgent(endpointUrl?: string): Promise<{
  available: boolean;
  detail: string;
}> {
  if (!endpointUrl) {
    return { available: false, detail: "HTTP agent endpointUrl is required." };
  }
  try {
    const url = new URL(endpointUrl);
    const healthUrl = `${url.origin}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(healthUrl, { signal: controller.signal });
      return {
        available: response.ok,
        detail: response.ok
          ? `HTTP sample health check passed at ${healthUrl}.`
          : `HTTP sample health check returned ${response.status} at ${healthUrl}.`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      available: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseAgentConfig(
  body: Record<string, unknown>,
):
  | { ok: true; config: AgentConnectionConfig }
  | { ok: false; message: string } {
  const adapterKind = body.adapterKind;
  const agentId = body.agentId;
  const name = body.name;
  if (!isAdapterKind(adapterKind)) {
    return { ok: false, message: "adapterKind must be openclaw, http_sample, or mock" };
  }
  if (typeof agentId !== "string" || !agentId.trim()) {
    return { ok: false, message: "agentId is required" };
  }
  if (typeof name !== "string" || !name.trim()) {
    return { ok: false, message: "name is required" };
  }

  return {
    ok: true,
    config: {
      adapterKind,
      agentId,
      name,
      description: typeof body.description === "string" ? body.description : undefined,
      openclawCliPath:
        typeof body.openclawCliPath === "string" ? body.openclawCliPath : undefined,
      gatewayUrl: typeof body.gatewayUrl === "string" ? body.gatewayUrl : undefined,
      endpointUrl: typeof body.endpointUrl === "string" ? body.endpointUrl : undefined,
      timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
      caseIds: Array.isArray(body.caseIds)
        ? body.caseIds.filter((caseId): caseId is string => typeof caseId === "string")
        : undefined,
    },
  };
}

function isAdapterKind(value: unknown): value is P2AdapterKind {
  return value === "openclaw" || value === "http_sample" || value === "mock";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
