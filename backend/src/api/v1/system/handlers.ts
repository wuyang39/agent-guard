import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { NativeGuardStatus } from "@agent-guard/contracts";
import { success } from "../../response";
import { getActiveAgentConfig, listAgentConfigs } from "../../../storage/agentConfigStore";
import { listRunGroups } from "../../../storage/fileRunStore";
import { sanitizeNativeGuardStatus } from "../openclaw/native-guard-handlers";

export type SystemRouteDependencies = {
  nativeGuardStatusProvider?: () => NativeGuardStatus;
};

export async function systemRoutes(
  app: FastifyInstance,
  dependencies: SystemRouteDependencies = {},
): Promise<void> {
  app.get("/api/v1/system/status", async (_request, _reply) => {
    const [activeAgent, agents, latestRuns] = await Promise.all([
      getActiveAgentConfig(),
      listAgentConfigs(),
      listRunGroups({ limit: 1 }),
    ]);

    const nativeGuard = sanitizeNativeGuardStatus(
      dependencies.nativeGuardStatusProvider?.() ?? OFF_NATIVE_GUARD_STATUS,
    );
    const cachedOpenClawAvailable = Boolean(
      nativeGuard.openclawVersion || activeAgent.openclawCliPath,
    );

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
    await import("node:fs/promises").then((fs) => fs.access(dir));
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
