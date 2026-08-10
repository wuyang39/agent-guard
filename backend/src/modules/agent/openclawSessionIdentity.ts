import { parseCanonicalOpenClawSessionKey } from "@agent-guard/native-guard-protocol";

const RAW_SESSION_KEY = /^[A-Za-z0-9._-]{1,120}$/;

export function canonicalizeOpenClawSessionKey(sessionKey: string): string {
  if (sessionKey.includes("..")) {
    throw new Error("OpenClaw session key is invalid.");
  }
  if (parseCanonicalOpenClawSessionKey(sessionKey) !== undefined) return sessionKey;
  if (!RAW_SESSION_KEY.test(sessionKey)) {
    throw new Error("OpenClaw session key is invalid.");
  }
  return `agent:main:${sessionKey}`;
}
