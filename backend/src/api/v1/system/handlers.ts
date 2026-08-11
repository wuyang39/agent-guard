import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { NativeGuardStatus } from "@agent-guard/contracts";
import { success } from "../../response";
import { checkOpenClawAvailable } from "../../../modules/agent/openclawAdapter";
import { getActiveAgentConfig, listAgentConfigs } from "../../../storage/agentConfigStore";
import { listRunGroups } from "../../../storage/fileRunStore";
import { sanitizeNativeGuardStatus } from "../openclaw/native-guard-handlers";

const CHECK_TTL_MS = 30_000;

export type SystemRouteDependencies = {
  nativeGuardStatusProvider?: () => NativeGuardStatus;
  checkOpenClawAvailable?: typeof checkOpenClawAvailable;
  now?: () => number;
  getActiveAgentConfig?: typeof getActiveAgentConfig;
  listAgentConfigs?: typeof listAgentConfigs;
  listRunGroups?: typeof listRunGroups;
  outputDir?: string;
};

export async function systemRoutes(
  app: FastifyInstance,
  dependencies: SystemRouteDependencies = {},
): Promise<void> {
  const checkAdapter =
    dependencies.checkOpenClawAvailable ?? checkOpenClawAvailable;
  const getActiveAgent =
    dependencies.getActiveAgentConfig ?? getActiveAgentConfig;
  const listAgents = dependencies.listAgentConfigs ?? listAgentConfigs;
  const listRuns = dependencies.listRunGroups ?? listRunGroups;
  const now = dependencies.now ?? Date.now;
  let cachedOpenClawAvailable = false;
  let cachedOpenClawCliPath: string | undefined;
  let lastCheck = 0;
  let hasChecked = false;

  app.get("/api/v1/system/status", async (_request, _reply) => {
    const [activeAgent, agents, latestRuns] = await Promise.all([
      getActiveAgent(),
      listAgents(),
      listRuns({ limit: 1 }),
    ]);

    const nativeGuard = sanitizeNativeGuardStatus(
      dependencies.nativeGuardStatusProvider?.() ?? OFF_NATIVE_GUARD_STATUS,
    );
    const checkedAt = now();
    if (
      !hasChecked ||
      checkedAt - lastCheck > CHECK_TTL_MS ||
      activeAgent.openclawCliPath !== cachedOpenClawCliPath
    ) {
      const adapterCheck = await checkAdapter(activeAgent.openclawCliPath)
        .catch(() => ({ available: false }));
      cachedOpenClawAvailable = adapterCheck.available;
      cachedOpenClawCliPath = activeAgent.openclawCliPath;
      lastCheck = checkedAt;
      hasChecked = true;
    }

    const outputDir = path.resolve(
      dependencies.outputDir ?? path.join(process.cwd(), "outputs"),
    );
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
        nativeGuard,
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
        openclawNativeGuard: true,
        openclawNativeGuardReady:
          nativeGuard.coverage === "ready" || nativeGuard.coverage === "active",
        openclawDetectionDocker: false,
      },
    });
  });
}

async function directoryAvailable(dir: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(dir, { recursive: true }),
    );
    return true;
  } catch {
    return false;
  }
}

const OFF_NATIVE_GUARD_STATUS: NativeGuardStatus = {
  coverage: "off",
  finalizerAssurance: "unverified",
  activeLeaseCount: 0,
};
