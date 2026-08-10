/**
 * Fastify app factory — 遵循 mcollina/skills/fastify 最佳实践
 *
 * buildApp() 创建 Fastify 实例，注册插件和路由。
 * 与 server.ts 分离，便于测试（app.inject() 不需要真实 HTTP）。
 */

import Fastify from "fastify";
import type { FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import { systemRoutes } from "./api/v1/system/handlers";
import { dashboardRoutes } from "./api/v1/dashboard/handlers";
import { agentRoutes } from "./api/v1/agents/handlers";
import { testSelectionRoutes } from "./api/v1/test-selection/handlers";
import { testRunRoutes } from "./api/v1/test-runs/handlers";
import { supervisionRoutes } from "./api/v1/supervision/handlers";
import { askRoutes } from "./api/v1/supervision/ask-handlers";
import { traceRoutes } from "./api/v1/traces/handlers";
import { reportRoutes, artifactRoutes, policyRoutes } from "./api/v1/reports/handlers";
import { openClawRealtimeMcpRoutes } from "./api/v1/openclaw/realtime-mcp-handlers";
import { runtimeConfigRoutes } from "./api/v1/runtime-config/handlers";
import { openClawPyritOpenAiRoutes } from "./api/v1/openclaw/pyrit-openai-handlers";
import {
  createOpenClawControlClient,
  type NativeGuardCapability,
} from "./modules/openclaw/openclawControlClient";
import {
  DETECTION_SANDBOX_CAPABILITY_TIMEOUT_MS,
  DETECTION_SANDBOX_COMMAND_TIMEOUT_MS,
} from "./modules/openclaw/detectionSandboxManager";
import { createNativeGuardLeaseService } from "./modules/openclaw/nativeGuardLeaseService";
import { createNativeGuardEventStore } from "./storage/nativeGuardEventStore";
import type { NativeGuardEventStore } from "./storage/nativeGuardEventStore";
import type { SandboxCoordinatorFactory } from "./services/e2eRunService";
import {
  createNativeGuardRouteDependencies,
  openClawNativeGuardRoutes,
  type NativeGuardRouteDependencies,
} from "./api/v1/openclaw/native-guard-handlers";
import {
  openClawNativeSupervisionRoutes,
} from "./api/v1/openclaw/native-supervision-handlers";
import {
  createMainAgentSupervisionService,
  type MainAgentSupervisionService,
} from "./modules/openclaw/mainAgentSupervisionService";
import { createNativeGuardRealtimeBridge } from "./modules/openclaw/nativeGuardRealtimeBridge";
import { emitNativeToolHookEvent } from "./modules/openclaw/realtimeMcpServer";
import { failure } from "./api/response";

export function requireNativeGuardRuntimeEventStore(
  dependencies: NativeGuardRouteDependencies,
): NativeGuardEventStore {
  if (!dependencies.runtimeEventStore) {
    throw new Error(
      "nativeGuardDependencies.runtimeEventStore is required for sandbox detection.",
    );
  }
  return dependencies.runtimeEventStore;
}

export function createSandboxCoordinatorFactory(
  nativeGuardDependencies: NativeGuardRouteDependencies,
): SandboxCoordinatorFactory {
  const runtimeEventStore = requireNativeGuardRuntimeEventStore(
    nativeGuardDependencies,
  );

  return (input) => {
    const liveControlClient = createOpenClawControlClient({
      gatewayToken: input.gatewayToken,
      timeoutMs: DETECTION_SANDBOX_COMMAND_TIMEOUT_MS,
      capabilityTimeoutMs: DETECTION_SANDBOX_CAPABILITY_TIMEOUT_MS,
    });
    const sandboxControlClient = {
      ...liveControlClient,
      async inspectCapabilities() {
        return cloneNativeGuardCapability(input.capabilitySnapshot);
      },
    };
    return {
      activate: async (actInput) => {
        const activated = await nativeGuardDependencies.coordinator.activateWithIdentity({
          rootSessionKey: actInput.rootSessionKey,
          scope: { kind: "session", sessionKey: actInput.rootSessionKey },
          mode: "detection",
          sandbox: {
            controlClient: sandboxControlClient,
            gatewayUrl: input.gatewayUrl,
            capabilityInput: {
              cliPath: input.cliPath,
              env: input.profileEnv,
              isolatedProfile: true,
              inheritProcessEnv: false,
            },
          },
        } as Parameters<
          typeof nativeGuardDependencies.coordinator.activateWithIdentity
        >[0]);
        const lease = activated.status.activeLeases?.find(
          (candidate) => candidate.leaseId === activated.leaseId,
        ) ?? (activated.status.activeLease?.leaseId === activated.leaseId
          ? activated.status.activeLease
          : undefined);
        if (!lease) throw new Error("Sandbox guard activation returned no active lease.");
        return { leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch };
      },
      revoke: async (leaseId) => {
        await nativeGuardDependencies.coordinator.revoke(leaseId);
      },
      eventStore: runtimeEventStore,
    };
  };
}

function cloneNativeGuardCapability(
  capability: NativeGuardCapability,
): NativeGuardCapability {
  return {
    ...capability,
    conflictingPluginIds: [...capability.conflictingPluginIds],
  };
}

export async function buildApp(opts?: {
  logger?: FastifyServerOptions["logger"];
  nativeGuardDependencies?: NativeGuardRouteDependencies;
  mainAgentSupervisionService?: MainAgentSupervisionService;
}) {
  let nativeGuardDependencies = opts?.nativeGuardDependencies;
  if (!nativeGuardDependencies) {
    const sharedLeaseService = createNativeGuardLeaseService();
    const sharedEventStore = createNativeGuardEventStore();
    nativeGuardDependencies = createNativeGuardRouteDependencies({
      leaseService: sharedLeaseService,
      eventStore: sharedEventStore,
    });
  }
  const runtimeEventStore = requireNativeGuardRuntimeEventStore(
    nativeGuardDependencies,
  );
  const mainAgentSupervisionService = opts?.mainAgentSupervisionService ??
    createMainAgentSupervisionService({
      coordinator: nativeGuardDependencies.coordinator,
    });
  const redaction = {
    paths: [
      "req.headers.authorization",
      "req.headers['x-agent-guard-control-token']",
      "authorization",
      "['x-agent-guard-control-token']",
    ],
    censor: "[REDACTED]",
  };
  const logger = opts?.logger === false
    ? false
    : typeof opts?.logger === "object"
      ? { ...opts.logger, redact: redaction }
      : {
          level: process.env.LOG_LEVEL ?? "info",
          redact: redaction,
          transport:
            process.env.NODE_ENV === "production"
              ? undefined
              : { target: "pino-pretty", options: { colorize: true } },
        };
  const app = Fastify({
    logger,
  });
  const nativeGuardRealtimeBridge = createNativeGuardRealtimeBridge({
    eventStore: runtimeEventStore,
    emit: emitNativeToolHookEvent,
  });
  app.addHook("onClose", async () => {
    nativeGuardRealtimeBridge.close();
    await mainAgentSupervisionService.close();
  });

  // ---- 插件 ----
  app.addHook("onRequest", async (request, reply) => {
    const nativeSupervisionRequest = isNativeSupervisionRequest(request.url);
    const origin = request.headers.origin;
    if (
      (
        request.url.startsWith("/api/v1/openclaw/native-guard/") ||
        nativeSupervisionRequest
      ) &&
      origin !== undefined &&
      (
        !nativeGuardDependencies.allowedOrigins.includes(origin) ||
        (nativeSupervisionRequest && !isExactHttpOrigin(origin))
      )
    ) {
      return reply.code(403).send(failure(
        "NATIVE_GUARD_ORIGIN_FORBIDDEN",
        "Native guard request origin is not allowed.",
      ));
    }
  });

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  // ---- 全局错误处理 ----
  app.setErrorHandler((err, _request, reply) => {
    const error = err as Error & { statusCode?: number };
    app.log.error({ err: error }, "Unhandled error");
    reply.code(error.statusCode ?? 500);
    return failure(
      "INTERNAL_ERROR",
      error.message ?? "Internal server error",
    );
  });

  // ---- 404 ----
  app.setNotFoundHandler((_request, reply) => {
    reply.code(404);
    return failure("NOT_FOUND", "Route not found");
  });

  // ---- 路由 ----
  await app.register(systemRoutes, {
    nativeGuardStatusProvider: () =>
      nativeGuardDependencies.coordinator.getLastStatus(),
  });
  await app.register(dashboardRoutes);
  await app.register(agentRoutes);
  await app.register(testSelectionRoutes);
  // Sandbox coordinator factory: uses the APP coordinator (shared
  // lease state) with sandbox controlClient override for the HTTP
  // request to the plugin. The lease is tracked by the app coordinator
  // so PDP/evidence handlers see it.
  const sandboxCoordinatorFactory = createSandboxCoordinatorFactory(
    nativeGuardDependencies,
  );
  await app.register(testRunRoutes, { sandboxCoordinatorFactory });
  await app.register(supervisionRoutes);
  await app.register(askRoutes);
  await app.register(traceRoutes);
  await app.register(reportRoutes);
  await app.register(artifactRoutes);
  await app.register(policyRoutes);
  await app.register(openClawRealtimeMcpRoutes);
  await app.register(runtimeConfigRoutes);
  await app.register(openClawPyritOpenAiRoutes);
  await app.register(openClawNativeSupervisionRoutes, {
    service: mainAgentSupervisionService,
  });
  await app.register(openClawNativeGuardRoutes, nativeGuardDependencies);

  return app;
}

function isNativeSupervisionRequest(url: string): boolean {
  const base = "/api/v1/openclaw/native-supervision";
  return url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`);
}

function isExactHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}
