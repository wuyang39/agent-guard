import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { success, failure } from "../../response";

const TRACES_DIR = path.resolve(process.cwd(), "outputs", "traces");

export async function traceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/traces/:traceId", async (request, reply) => {
    const { traceId } = request.params as { traceId: string };

    try {
      const files = await fs.readdir(TRACES_DIR);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const raw = await fs.readFile(path.join(TRACES_DIR, file), "utf-8");
        const trace = JSON.parse(raw);
        if (trace.traceId === traceId) {
          return success({
            trace,
            relatedRunGroupId: trace.runId ?? "",
            relatedRiskReportIds: [] as string[],
            relatedFindingIds: [] as string[],
            eventToFindingIds: {} as Record<string, string[]>,
            links: [
              { kind: "trace" as const, id: trace.traceId, label: `Trace ${trace.traceId}` },
            ],
          });
        }
      }
      reply.code(404);
      return failure("NOT_FOUND", `Trace ${traceId} not found`);
    } catch (err) {
      reply.code(500);
      return failure("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
    }
  });
}
