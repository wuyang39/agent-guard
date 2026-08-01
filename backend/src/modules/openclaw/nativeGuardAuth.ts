import { timingSafeEqual } from "node:crypto";

const LOCAL_ALLOWED_ORIGINS = [
  "http://127.0.0.1:5173",
  "http://localhost:5173",
  // Fetch serializes a packaged Electron file page's opaque origin as "null".
  "null",
] as const;

export function controlTokenMatches(
  expected: string | undefined,
  candidate: string | string[] | undefined,
): boolean {
  if (!expected || typeof candidate !== "string") return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  return (
    expectedBytes.length === candidateBytes.length &&
    timingSafeEqual(expectedBytes, candidateBytes)
  );
}

export function parseLeaseBearer(
  authorization: string | string[] | undefined,
): string | undefined {
  if (typeof authorization !== "string") return undefined;
  return /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(authorization)?.[1];
}

export function resolveNativeGuardAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const allowed = new Set<string>(LOCAL_ALLOWED_ORIGINS);
  for (const candidate of (env.AGENT_GUARD_ALLOWED_ORIGINS ?? "").split(",")) {
    const origin = candidate.trim();
    if (isExactHttpOrigin(origin)) allowed.add(origin);
  }
  return [...allowed];
}

function isExactHttpOrigin(value: string): boolean {
  if (!value || value === "*") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.origin === value
    );
  } catch {
    return false;
  }
}
