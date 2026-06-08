import type { FastifyInstance } from "fastify";
import { success } from "../../response";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/system/status", async (_request, _reply) => {
    return success({
      service: "agent-guard-api",
      schemaVersion: "mvp-1",
      apiVersion: "p2-api-freeze-1",
      status: "ok",
      defaultAdapterKind: "mock",
      fallbackAdapterKinds: ["http_sample", "mock"] as const,
      features: {
        openclawAdapter: false,
        httpSampleAdapter: false,
        mockAdapter: true,
        e2eRun: true,
        reportIndex: true,
        frontendReady: false,
      },
    });
  });
}
