/**
 * Fastify app factory — 遵循 mcollina/skills/fastify 最佳实践
 *
 * buildApp() 创建 Fastify 实例，注册插件和路由。
 * 与 server.ts 分离，便于测试（app.inject() 不需要真实 HTTP）。
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { systemRoutes } from "./api/v1/system/handlers";
import { dashboardRoutes } from "./api/v1/dashboard/handlers";
import { agentRoutes } from "./api/v1/agents/handlers";
import { testRunRoutes } from "./api/v1/test-runs/handlers";
import { supervisionRoutes } from "./api/v1/supervision/handlers";
import { askRoutes } from "./api/v1/supervision/ask-handlers";
import { traceRoutes } from "./api/v1/traces/handlers";
import { reportRoutes, artifactRoutes, policyRoutes } from "./api/v1/reports/handlers";
import { openClawRealtimeMcpRoutes } from "./api/v1/openclaw/realtime-mcp-handlers";
import { runtimeConfigRoutes } from "./api/v1/runtime-config/handlers";
import { failure } from "./api/response";

export async function buildApp(opts?: {
  logger?: boolean | Record<string, unknown>;
}) {
  const app = Fastify({
    logger: opts?.logger ?? {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { colorize: true } },
    },
  });

  // ---- 插件 ----
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
  await app.register(systemRoutes);
  await app.register(dashboardRoutes);
  await app.register(agentRoutes);
  await app.register(testRunRoutes);
  await app.register(supervisionRoutes);
  await app.register(askRoutes);
  await app.register(traceRoutes);
  await app.register(reportRoutes);
  await app.register(artifactRoutes);
  await app.register(policyRoutes);
  await app.register(openClawRealtimeMcpRoutes);
  await app.register(runtimeConfigRoutes);

  return app;
}
