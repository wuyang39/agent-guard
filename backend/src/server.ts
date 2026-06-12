/**
 * Fastify server 入口
 *
 * 启动: node --import tsx backend/src/server.ts
 * 或: npm run api:start
 */

import { buildApp } from "./app";

const PORT = Number(process.env.API_PORT ?? 3100);
const HOST = process.env.API_HOST ?? "0.0.0.0";

async function main(): Promise<void> {
  const app = await buildApp();

  // graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down...`);
      await app.close();
      process.exit(0);
    });
  }

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`Agent Guard API running at http://localhost:${PORT}`);
  app.log.info(`  GET  /api/v1/system/status`);
  app.log.info(`  POST /api/v1/test-runs/e2e`);
  app.log.info(`  GET  /api/v1/test-runs`);
  app.log.info(`  GET  /api/v1/test-runs/:runGroupId`);
  app.log.info(`  GET  /api/v1/supervision/sessions/:runtimeSessionId`);
}

main().catch((err) => {
  console.error("Failed to start API server:", err);
  process.exit(1);
});
