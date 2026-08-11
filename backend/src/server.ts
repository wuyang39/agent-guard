/**
 * Fastify server 入口
 *
 * 启动: node --import tsx backend/src/server.ts
 * 或: npm run api:start
 */

import { buildApp } from "./app";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type NativeSupervisionServerBootstrap = {
  bootstrapToken: string;
  pairingUrl?: string;
};

export function createNativeSupervisionServerBootstrap(
  env: NodeJS.ProcessEnv,
  createToken: () => string = () => randomBytes(32).toString("base64url"),
): NativeSupervisionServerBootstrap {
  const suppliedBootstrap = env.AGENT_GUARD_UI_BOOTSTRAP_TOKEN;
  if (suppliedBootstrap) return { bootstrapToken: suppliedBootstrap };
  const bootstrapToken = createToken();
  if (!/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken)) {
    throw new TypeError("Generated UI bootstrap token must be a 32-byte base64url token");
  }
  const frontendPort = parsePort(env.FRONTEND_PORT ?? "5173", "FRONTEND_PORT");
  return {
    bootstrapToken,
    pairingUrl: `http://127.0.0.1:${String(frontendPort)}/#agent-guard-bootstrap=${bootstrapToken}`,
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const port = parsePort(env.API_PORT ?? "3100", "API_PORT");
  const host = env.API_HOST ?? "127.0.0.1";
  const bootstrap = createNativeSupervisionServerBootstrap(env);
  const app = await buildApp({
    nativeSupervisionBootstrapToken: bootstrap.bootstrapToken,
  });

  // graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      app.log.info(`Received ${signal}, shutting down...`);
      await app.close();
      process.exit(0);
    });
  }

  await app.listen({ port, host });
  if (bootstrap.pairingUrl) {
    process.stdout.write(`Agent Guard pairing URL: ${bootstrap.pairingUrl}\n`);
  }
  app.log.info(`Agent Guard API running at http://localhost:${String(port)}`);
  app.log.info(`  GET  /api/v1/system/status`);
  app.log.info(`  POST /api/v1/test-runs/e2e`);
  app.log.info(`  GET  /api/v1/test-runs`);
  app.log.info(`  GET  /api/v1/test-runs/:runGroupId`);
  app.log.info(`  GET  /api/v1/supervision/sessions/:runtimeSessionId`);
}

function parsePort(value: string, name: string): number {
  if (!/^\d{1,5}$/.test(value)) throw new TypeError(`${name} must be a valid TCP port`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`${name} must be a valid TCP port`);
  }
  return port;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((err) => {
    console.error("Failed to start API server:", err);
    process.exit(1);
  });
}
