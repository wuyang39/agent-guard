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
}
