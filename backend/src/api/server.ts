/**
 * Compatibility wrapper for older scripts that imported buildServer().
 *
 * The formal API entry is buildApp() in backend/src/app.ts. Keeping this thin
 * wrapper avoids a second API/storage implementation while preserving imports.
 */

import type { FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { buildApp } from "../app";

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3100);
const host = process.env.API_HOST ?? process.env.HOST ?? "127.0.0.1";

export async function buildServer(): Promise<FastifyInstance> {
  return buildApp({ logger: false });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await buildServer();
  await app.listen({ port, host });
  console.log(`Agent Guard API is running at http://${host}:${port}`);
}
