import path from "node:path";
import type { FastifyInstance } from "fastify";
import { success } from "../../response";
import { checkOpenClawAvailable } from "../../../modules/agent/openclawAdapter";
import { getActiveAgentConfig, listAgentConfigs } from "../../../storage/agentConfigStore";
import { listRunGroups } from "../../../storage/fileRunStore";

let cachedOpenClawAvailable = false;
let lastCheck = 0;
let cachedOpenClawCliPath: string | undefined;
const CHECK_TTL_MS = 30_000;

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/system/status", async (_request, _reply) => {
    const [activeAgent, agents, latestRuns] = await Promise.all([
      getActiveAgentConfig(),
      listAgentConfigs(),
      listRunGroups({ limit: 1 }),
    ]);

    // 缓存 OpenClaw 可用性检查（30s TTL），但 active agent CLI 路径变化时立即重查。
    const now = Date.now();
    const openclawCliPath = activeAgent.openclawCliPath;
    if (now - lastCheck > CHECK_TTL_MS || openclawCliPath !== cachedOpenClawCliPath) {
      const check = await checkOpenClawAvailable(openclawCliPath).catch(() => ({
        available: false,
      }));
      cachedOpenClawAvailable = check.available;
      cachedOpenClawCliPath = openclawCliPath;
      lastCheck = now;
    }

    const outputDir = path.resolve(process.cwd(), "outputs");
    const outputStoreAvailable = await directoryAvailable(outputDir);

    return success({
      service: "agent-guard-api",
      schemaVersion: "mvp-1",
      apiVersion: "p2-api-freeze-2",
      status: "ok",
      outputDir,
      generatedAt: new Date().toISOString(),
      defaultAdapterKind: "openclaw",
      fallbackAdapterKinds: ["http_sample", "mock"] as const,
      activeAgent,
      latestRunGroup: latestRuns[0],
      health: {
        api: true,
        openclawCli: cachedOpenClawAvailable,
        outputStore: outputStoreAvailable,
        realtimeMcp: true,
        configuredAgents: agents.length,
      },
      features: {
        openclawAdapter: cachedOpenClawAvailable,
        openclawRealtimeMcp: true,
        httpSampleAdapter: true,
        mockAdapter: true,
        e2eRun: true,
        asyncE2eRun: true,
        agentConfigStore: true,
        traceEvidenceLinks: true,
        reportIndex: true,
        askChannel: true,
        frontendReady: true,
      },
    });
  });
}

async function directoryAvailable(dir: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    return true;
  } catch {
    return false;
  }
}
