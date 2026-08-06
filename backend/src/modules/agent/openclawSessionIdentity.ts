const RAW_SESSION_KEY = /^[A-Za-z0-9._-]{1,120}$/;
const CANONICAL_SESSION_KEY = /^agent:[A-Za-z0-9._-]{1,64}:[A-Za-z0-9._:-]{1,180}$/;

export function canonicalizeOpenClawSessionKey(sessionKey: string): string {
  if (sessionKey.includes("..")) {
    throw new Error("OpenClaw session key is invalid.");
  }
  if (CANONICAL_SESSION_KEY.test(sessionKey)) return sessionKey;
  if (!RAW_SESSION_KEY.test(sessionKey)) {
    throw new Error("OpenClaw session key is invalid.");
  }
  return `agent:main:${sessionKey}`;
}
