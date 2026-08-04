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
import { randomBytes } from "node:crypto";
import {
  createNativeGuardRouteDependencies,
  openClawNativeGuardRoutes,
  type NativeGuardRouteDependencies,
} from "./api/v1/openclaw/native-guard-handlers";
import { failure } from "./api/response";

export async function buildApp(opts?: {
  logger?: FastifyServerOptions["logger"];
  nativeGuardDependencies?: NativeGuardRouteDependencies;
}) {
  const nativeGuardDependencies =
    opts?.nativeGuardDependencies ?? createNativeGuardRouteDependencies();
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

  // ---- 插件 ----
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.url.startsWith("/api/v1/openclaw/native-guard/") &&
      request.headers.origin !== undefined &&
      !nativeGuardDependencies.allowedOrigins.includes(request.headers.origin)
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
  // Wire native-guard lease activate/revoke into the e2e detection run.
  // Targets the sandbox Gateway (not host) by accepting gatewayUrl/token
  // from the e2eRunService. The coordinator handles policy resolution
  // and lease tracking; sandbox Gateway identity is passed per-request.
  const guardLease = {
    activate: async (input: {
      rootSessionKey: string; runGroupId: string;
      gatewayUrl: string; gatewayToken: string;
    }) => {
      const status = await nativeGuardDependencies.coordinator.activate({
        rootSessionKey: input.rootSessionKey,
        mode: "detection",
      });
      const lease = status.activeLease;
      if (!lease) throw new Error("Native guard activation returned no active lease.");
      return { leaseId: lease.leaseId, leaseEpoch: lease.leaseEpoch };
    },
    revoke: async (leaseId: string, _gatewayUrl: string, _gatewayToken: string) => {
      await nativeGuardDependencies.coordinator.revoke(leaseId);
    },
  };
  await app.register(testRunRoutes, { guardLease });
  await app.register(supervisionRoutes);
  await app.register(askRoutes);
  await app.register(traceRoutes);
  await app.register(reportRoutes);
  await app.register(artifactRoutes);
  await app.register(policyRoutes);
  await app.register(openClawRealtimeMcpRoutes);
  await app.register(runtimeConfigRoutes);
  await app.register(openClawPyritOpenAiRoutes);
  await app.register(openClawNativeGuardRoutes, nativeGuardDependencies);

  return app;
}
