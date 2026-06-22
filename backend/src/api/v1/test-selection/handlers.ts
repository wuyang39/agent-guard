import type { FastifyInstance } from "fastify";
import { failure, success } from "../../response";
import {
  createSelectionPlan,
  getRequiredSelectionPlan,
  listSelectionPlans,
  TestSelectionError,
} from "../../../modules/runner/testSelectionService";

export async function testSelectionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/v1/test-selection/plans", async (request, reply) => {
    try {
      const plan = await createSelectionPlan(request.body as Record<string, unknown>);
      reply.code(201);
      return success({ plan });
    } catch (error) {
      if (error instanceof TestSelectionError) {
        reply.code(error.code === "INSUFFICIENT_CASE_POOL" ? 400 : 400);
        return failure(error.code, error.message);
      }
      request.log.error({ err: error }, "Failed to create test selection plan");
      reply.code(500);
      return failure(
        "TEST_SELECTION_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  app.get("/api/v1/test-selection/plans", async () => {
    const plans = await listSelectionPlans();
    return success({ plans, total: plans.length });
  });

  app.get("/api/v1/test-selection/plans/:selectionPlanId", async (request, reply) => {
    const { selectionPlanId } = request.params as { selectionPlanId: string };
    try {
      const plan = await getRequiredSelectionPlan(selectionPlanId);
      return success({ plan });
    } catch (error) {
      if (error instanceof TestSelectionError) {
        reply.code(404);
        return failure(error.code, error.message);
      }
      request.log.error({ err: error, selectionPlanId }, "Failed to read test selection plan");
      reply.code(500);
      return failure(
        "TEST_SELECTION_READ_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  });
}
