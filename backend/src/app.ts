/**
 * Fastify app factory — 遵循 mcollina/skills/fastify 最佳实践
 *
 * buildApp() 创建 Fastify 实例，注册插件和路由。
 * 与 server.ts 分离，便于测试（app.inject() 不需要真实 HTTP）。
 */

import Fastify from "fastify";
import { randomBytes } from "node:crypto";
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
import {
  isOpenClawRealtimeEventsStreamRequest,
  openClawRealtimeMcpRoutes,
} from "./api/v1/openclaw/realtime-mcp-handlers";
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
  isAllowedNativeSupervisionOrigin,
  isNativeSupervisionRequest,
  openClawNativeSupervisionRoutes,
} from "./api/v1/openclaw/native-supervision-handlers";
import {
  createNativeSupervisionAccessService,
  type NativeSupervisionAccessService,
} from "./modules/openclaw/nativeSupervisionAccessService";
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
        const usableLeaseId = typeof activated.leaseId === "string" &&
          activated.leaseId.trim().length > 0;
        if (
          !usableLeaseId ||
          !Number.isSafeInteger(activated.leaseEpoch) ||
          activated.leaseEpoch <= 0
        ) {
          if (usableLeaseId) {
            try {
              await nativeGuardDependencies.coordinator.revoke(activated.leaseId);
            } catch {
              // Preserve the activation identity error after best-effort cleanup.
            }
          }
          throw new Error(
            "Sandbox guard activation returned an invalid lease identity.",
          );
        }
        return {
          leaseId: activated.leaseId,
          leaseEpoch: activated.leaseEpoch,
        };
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
  nativeSupervisionAccessService?: NativeSupervisionAccessService;
  nativeSupervisionBootstrapToken?: string;
  additionalNativeSupervisionAllowedOrigins?: readonly string[];
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
  const nativeSupervisionAccessService = opts?.nativeSupervisionAccessService ??
    createNativeSupervisionAccessService({
      bootstrapToken: opts?.nativeSupervisionBootstrapToken ??
        process.env.AGENT_GUARD_UI_BOOTSTRAP_TOKEN ?? randomBytes(32).toString("base64url"),
    });
  const nativeSupervisionAllowedOrigins = new Set(
    nativeGuardDependencies.allowedOrigins,
  );
  for (const origin of opts?.additionalNativeSupervisionAllowedOrigins ?? []) {
    if (isAllowedNativeSupervisionOrigin(origin, [origin])) {
      nativeSupervisionAllowedOrigins.add(origin);
    }
  }
  const nativeSupervisionAllowedOriginList = [...nativeSupervisionAllowedOrigins];
  const redaction = {
    paths: [
      "req.headers.authorization",
      "req.headers['x-agent-guard-control-token']",
      "req.headers.cookie",
      "req.body.token",
      "res.headers['set-cookie']",
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
    const origin = request.headers.origin;
    if (
      (
        isNativeSupervisionRequest(request.url) ||
        isOpenClawRealtimeEventsStreamRequest(request.url)
      ) &&
      !isAllowedNativeSupervisionOrigin(origin, nativeSupervisionAllowedOriginList)
    ) {
      return reply.code(403).send(failure(
        "NATIVE_SUPERVISION_ORIGIN_FORBIDDEN",
        "Native supervision request origin is not allowed.",
      ));
    }
    if (
      request.url.startsWith("/api/v1/openclaw/native-guard/") &&
      origin !== undefined &&
      !nativeGuardDependencies.allowedOrigins.includes(origin)
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
    credentials: true,
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
  await app.register(openClawRealtimeMcpRoutes, {
    accessService: nativeSupervisionAccessService,
    allowedOrigins: nativeSupervisionAllowedOriginList,
  });
  await app.register(runtimeConfigRoutes);
  await app.register(openClawPyritOpenAiRoutes);
  await app.register(openClawNativeSupervisionRoutes, {
    service: mainAgentSupervisionService,
    accessService: nativeSupervisionAccessService,
    allowedOrigins: nativeSupervisionAllowedOriginList,
  });
  await app.register(openClawNativeGuardRoutes, nativeGuardDependencies);

  return app;
}
