/**
 * Fastify server 入口
 *
 * 启动: node --import tsx backend/src/server.ts
 * 或: npm run api:start
 */

import { buildApp } from "./app";
import {
  createNativeGuardRouteDependencies,
  resolveNativeGuardControlToken,
} from "./api/v1/openclaw/native-guard-handlers";
import {
  clearBackendOnlySecrets,
  stripBackendOnlySecrets,
} from "./modules/runtime/childProcessEnv";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type NativeSupervisionServerBootstrap = {
  bootstrapToken: string;
  pairingOrigin?: string;
  pairingUrl?: string;
};

export type BackendServerEnvironment = {
  bootstrap: NativeSupervisionServerBootstrap;
  nativeGuardControlToken?: string;
  nativeGuardEnv: NodeJS.ProcessEnv;
};

export function createNativeSupervisionServerBootstrap(
  env: NodeJS.ProcessEnv,
  createToken: () => string = () => randomBytes(32).toString("base64url"),
): NativeSupervisionServerBootstrap {
  const suppliedBootstrap = env.AGENT_GUARD_UI_BOOTSTRAP_TOKEN;
  const bootstrapToken = suppliedBootstrap ?? createToken();
  if (!/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken)) {
    throw new TypeError("UI bootstrap token must be a 32-byte base64url token");
  }
  const configuredOrigin = env.AGENT_GUARD_FRONTEND_ORIGIN;
  if (configuredOrigin !== undefined && !isLoopbackFrontendOrigin(configuredOrigin)) {
    throw new TypeError("AGENT_GUARD_FRONTEND_ORIGIN must be an exact HTTP 127.0.0.1 origin");
  }
  if (suppliedBootstrap) {
    return configuredOrigin
      ? { bootstrapToken, pairingOrigin: configuredOrigin }
      : { bootstrapToken };
  }
  const frontendPort = parsePort(env.FRONTEND_PORT ?? "5173", "FRONTEND_PORT");
  const pairingOrigin = `http://127.0.0.1:${String(frontendPort)}`;
  return {
    bootstrapToken,
    pairingOrigin,
    pairingUrl: `${pairingOrigin}/#agent-guard-bootstrap=${bootstrapToken}`,
  };
}

function isLoopbackFrontendOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" &&
      parsed.hostname === "127.0.0.1" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.origin === value;
  } catch {
    return false;
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const port = parsePort(env.API_PORT ?? "3100", "API_PORT");
  const host = env.API_HOST ?? "127.0.0.1";
  const captured = captureBackendServerEnvironment(env);
  const nativeGuardDependencies = createNativeGuardRouteDependencies({
    env: captured.nativeGuardEnv,
    controlToken: captured.nativeGuardControlToken,
  });
  const app = await buildApp({
    nativeGuardDependencies,
    nativeSupervisionBootstrapToken: captured.bootstrap.bootstrapToken,
    nativeSupervisionAllowedOrigins: captured.bootstrap.pairingOrigin
      ? [captured.bootstrap.pairingOrigin]
      : undefined,
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
  if (captured.bootstrap.pairingUrl) {
    process.stdout.write(`Agent Guard pairing URL: ${captured.bootstrap.pairingUrl}\n`);
  }
  app.log.info(`Agent Guard API running at http://localhost:${String(port)}`);
  app.log.info(`  GET  /api/v1/system/status`);
  app.log.info(`  POST /api/v1/test-runs/e2e`);
  app.log.info(`  GET  /api/v1/test-runs`);
  app.log.info(`  GET  /api/v1/test-runs/:runGroupId`);
  app.log.info(`  GET  /api/v1/supervision/sessions/:runtimeSessionId`);
}

export function captureBackendServerEnvironment(
  env: NodeJS.ProcessEnv,
): BackendServerEnvironment {
  const bootstrap = createNativeSupervisionServerBootstrap(env);
  const nativeGuardControlToken = resolveNativeGuardControlToken(env);
  const nativeGuardEnv = stripBackendOnlySecrets(env);
  clearBackendOnlySecrets(env);
  return {
    bootstrap,
    ...(nativeGuardControlToken ? { nativeGuardControlToken } : {}),
    nativeGuardEnv,
  };
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
