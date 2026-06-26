import type { FastifyInstance } from "fastify";
import { success, failure } from "../../response";
import type { RunE2ERequest } from "../../types";
import {
  runE2E,
  CaseIdValidationError,
  SelectionPlanValidationError,
  PolicyPackReuseError,
  cancelRunGroup,
  createInitialE2ERunGroup,
} from "../../../services/e2eRunService";
import {
  getRunGroup,
  listRunGroups,
  saveRunGroup,
} from "../../../storage/fileRunStore";

export async function testRunRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/v1/test-runs/e2e
  app.post("/api/v1/test-runs/e2e", async (request, reply) => {
    const body = request.body as RunE2ERequest;
    const query = request.query as { async?: string };

    if (!body.adapterKind) {
      reply.code(400);
      return failure("BAD_REQUEST", "adapterKind is required");
    }
    if (!body.agent?.name) {
      reply.code(400);
      return failure("BAD_REQUEST", "agent.name is required");
    }
    if (body.selectionPlanId && body.caseIds?.length) {
      reply.code(400);
      return failure(
        "INVALID_SELECTION_PLAN",
        "selectionPlanId and caseIds cannot be provided together.",
      );
    }

    const validKinds = ["mock", "http_sample", "openclaw"];
    if (!validKinds.includes(body.adapterKind)) {
      reply.code(400);
      return failure(
        "BAD_REQUEST",
        `adapterKind must be one of: ${validKinds.join(", ")}`,
      );
    }

    // P2-B-3: 支持 mock + http_sample + openclaw

    if (query.async === "1" || query.async === "true") {
      const runGroup = createInitialE2ERunGroup(body);
      await saveRunGroup(runGroup);
      void runE2E(body, runGroup).catch((err) => {
        request.log.error({ err, runGroupId: runGroup.runGroupId }, "Async E2E run failed");
      });
      reply.code(202);
      return success({
        runGroup,
        links: [],
        async: true,
        statusUrl: `/api/v1/test-runs/${runGroup.runGroupId}`,
      });
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
      if (err instanceof SelectionPlanValidationError) {
        reply.code(400);
        return failure("INVALID_SELECTION_PLAN", err.message);
      }
      if (err instanceof PolicyPackReuseError) {
        reply.code(400);
        return failure("INVALID_POLICY_PACK", err.message);
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

  // POST /api/v1/test-runs/:runGroupId/cancel
  app.post("/api/v1/test-runs/:runGroupId/cancel", async (request, reply) => {
    const { runGroupId } = request.params as { runGroupId: string };
    const runGroup = await cancelRunGroup(runGroupId);

    if (!runGroup) {
      reply.code(404);
      return failure("NOT_FOUND", `Run group ${runGroupId} not found`);
    }

    return success({ runGroup });
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
