import type { FastifyInstance } from "fastify";
import { success, failure } from "../../response";
import type { RunE2ERequest } from "../../types";
import { runE2E, CaseIdValidationError } from "../../../services/e2eRunService";
import {
  getRunGroup,
  listRunGroups,
} from "../../../storage/fileRunStore";

export async function testRunRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/test-runs/e2e
  app.post("/api/v1/test-runs/e2e", async (request, reply) => {
    const body = request.body as RunE2ERequest;

    if (!body.adapterKind) {
      reply.code(400);
      return failure("BAD_REQUEST", "adapterKind is required");
    }
    if (!body.agent?.name) {
      reply.code(400);
      return failure("BAD_REQUEST", "agent.name is required");
    }

    const validKinds = ["mock", "http_sample", "openclaw"];
    if (!validKinds.includes(body.adapterKind)) {
      reply.code(400);
      return failure(
        "BAD_REQUEST",
        `adapterKind must be one of: ${validKinds.join(", ")}`,
      );
    }

    // P2-B-2: 支持 mock + http_sample
    if (body.adapterKind === "openclaw") {
      reply.code(400);
      return failure(
        "NOT_YET_SUPPORTED",
        `adapterKind "openclaw" is not yet available. Use "mock" or "http_sample".`,
      );
    }

    try {
      const result = await runE2E(body);
      reply.code(201);
      return success(result);
    } catch (err) {
      if (err instanceof CaseIdValidationError) {
        reply.code(400);
        return failure("INVALID_CASE_IDS", err.message);
      }
      request.log.error({ err }, "E2E run failed");
      reply.code(500);
      return failure(
        "E2E_RUN_FAILED",
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // GET /api/v1/test-runs
  app.get("/api/v1/test-runs", async (request) => {
    const query = request.query as {
      limit?: string;
      status?: string;
      adapterKind?: string;
    };

    const runs = await listRunGroups({
      limit: query.limit ? Number(query.limit) : undefined,
      status: query.status as "running" | "completed" | "failed" | undefined,
      adapterKind: query.adapterKind as "mock" | "http_sample" | "openclaw" | undefined,
    });

    return success({ runs, total: runs.length });
  });

  // GET /api/v1/test-runs/:runGroupId
  app.get("/api/v1/test-runs/:runGroupId", async (request, reply) => {
    const { runGroupId } = request.params as { runGroupId: string };
    const runGroup = await getRunGroup(runGroupId);

    if (!runGroup) {
      reply.code(404);
      return failure("NOT_FOUND", `Run group ${runGroupId} not found`);
    }

    return success({ runGroup });
  });
}
