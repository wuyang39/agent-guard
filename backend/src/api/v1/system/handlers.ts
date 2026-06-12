import path from "node:path";
import type { FastifyInstance } from "fastify";
import { success } from "../../response";
import { checkOpenClawAvailable } from "../../../modules/agent/openclawAdapter";

let cachedOpenClawAvailable = false;
let lastCheck = 0;
const CHECK_TTL_MS = 30_000;

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/system/status", async (_request, _reply) => {
    // 缓存 OpenClaw 可用性检查（30s TTL）
    const now = Date.now();
    if (now - lastCheck > CHECK_TTL_MS) {
      const check = await checkOpenClawAvailable().catch(() => ({
        available: false,
      }));
      cachedOpenClawAvailable = check.available;
      lastCheck = now;
    }

    return success({
      service: "agent-guard-api",
      schemaVersion: "mvp-1",
      apiVersion: "p2-api-freeze-1",
      status: "ok",
      outputDir: path.resolve(process.cwd(), "outputs"),
      generatedAt: new Date().toISOString(),
      defaultAdapterKind: "openclaw",
      fallbackAdapterKinds: ["http_sample", "mock"] as const,
      features: {
        openclawAdapter: cachedOpenClawAvailable,
        openclawRealtimeMcp: true,
        httpSampleAdapter: true,
        mockAdapter: true,
        e2eRun: true,
        reportIndex: true,
        askChannel: true,
        frontendReady: false,
      },
    });
  });

  app.post("/api/v1/agents/check", async (request) => {
    const body = (typeof request.body === "object" && request.body !== null)
      ? request.body as { adapterKind?: string; endpointUrl?: string }
      : {};
    const adapterKind = body.adapterKind ?? "openclaw";

    if (adapterKind === "openclaw") {
      const check = await checkOpenClawAvailable().catch((error) => ({
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }));
      return success({
        adapterKind,
        available: check.available,
        displayName: "OpenClaw",
        detail: check.available
          ? "OpenClaw CLI is available."
          : check.error ?? "OpenClaw CLI is unavailable.",
        normalizedAgent: {
          agentId: "agent.openclaw",
          name: "OpenClaw",
          adapterKind,
        },
      });
    }

    return success({
      adapterKind,
      available: adapterKind === "mock" || adapterKind === "http_sample",
      displayName: adapterKind === "http_sample" ? "HTTP Sample Agent" : "Mock Agent",
      detail:
        adapterKind === "http_sample"
          ? "HTTP sample adapter is configured; the target endpoint is checked during run."
          : "Mock adapter is always available.",
      normalizedAgent: {
        agentId: `agent.${adapterKind}`,
        name: adapterKind === "http_sample" ? "HTTP Sample Agent" : "Mock Agent",
        adapterKind,
      },
    });
  });
}
