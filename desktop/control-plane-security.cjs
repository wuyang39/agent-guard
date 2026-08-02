"use strict";

const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;
const SYSTEM_STATUS_PATH = "/api/v1/system/status";
const LEASE_PROBE_PATH = "/api/v1/openclaw/native-guard/leases";

function normalizeElectronRequestDetails(details) {
  return {
    ...details,
    frameId: details.frame?.parent === null ? 0 : -1,
    initiator: details.frame?.origin,
  };
}

function shouldInjectControlToken(details, context) {
  if (
    !details ||
    !context ||
    details.webContentsId !== context.mainWebContentsId ||
    details.frameId !== 0 ||
    !isExactOriginUrl(details.url, context.apiBase)
  ) {
    return false;
  }

  const rendererKind = trustedRendererKind(context.currentRendererUrl, context);
  if (rendererKind === "vite") {
    return details.initiator === context.trustedViteOrigin;
  }
  if (rendererKind === "packaged") {
    return details.initiator === "null" || details.initiator === "file://";
  }
  return false;
}

function withControlTokenHeaders(details, context, controlToken) {
  const requestHeaders = { ...(details.requestHeaders || {}) };
  if (!shouldInjectControlToken(details, context)) return requestHeaders;
  for (const name of Object.keys(requestHeaders)) {
    if (name.toLowerCase() === "x-agent-guard-control-token") {
      delete requestHeaders[name];
    }
  }
  requestHeaders["X-Agent-Guard-Control-Token"] = controlToken;
  return requestHeaders;
}

function isTrustedRendererUrl(url, context) {
  return trustedRendererKind(url, context) !== undefined;
}

function isExternalHttpUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

async function probeApiOwnership({ apiBase, controlToken, fetchImpl = fetch }) {
  let identityResponse;
  try {
    identityResponse = await fetchImpl(`${apiBase}${SYSTEM_STATUS_PATH}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(1600),
    });
  } catch {
    return { kind: "unreachable" };
  }
  const identity = await readLimitedJson(identityResponse);
  if (!matchesAgentGuardIdentity(identityResponse, identity)) {
    return { kind: "wrong_service" };
  }

  let ownershipResponse;
  try {
    ownershipResponse = await fetchImpl(`${apiBase}${LEASE_PROBE_PATH}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Agent-Guard-Control-Token": controlToken,
      },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(1600),
    });
  } catch {
    return { kind: "ownership_unavailable" };
  }
  const ownership = await readLimitedJson(ownershipResponse);
  if (ownershipResponse.status === 401) return { kind: "token_mismatch" };
  if (
    ownershipResponse.status === 400 &&
    ownership &&
    ownership.ok === false &&
    ownership.error &&
    ownership.error.code === "NATIVE_GUARD_INVALID_REQUEST"
  ) {
    return { kind: "ready" };
  }
  return { kind: "ownership_unavailable" };
}

function trustedRendererKind(value, context) {
  if (value === context.packagedIndexUrl) return "packaged";
  if (isExactOriginUrl(value, context.trustedViteOrigin)) return "vite";
  return undefined;
}

function isExactOriginUrl(value, expectedOrigin) {
  try {
    const url = new URL(value);
    const origin = new URL(expectedOrigin);
    return (
      url.origin === origin.origin &&
      origin.href === `${origin.origin}/` &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function matchesAgentGuardIdentity(response, body) {
  return Boolean(
    response.ok &&
    body &&
    body.ok === true &&
    body.data &&
    body.data.service === "agent-guard-api" &&
    body.data.schemaVersion === "mvp-1" &&
    body.data.apiVersion === "p2-api-freeze-2",
  );
}

async function readLimitedJson(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return undefined;
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROBE_RESPONSE_BYTES) {
      return undefined;
    }
  }
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROBE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  }
  const text = Buffer.concat(chunks, size).toString("utf8");
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

module.exports = {
  isExternalHttpUrl,
  isTrustedRendererUrl,
  normalizeElectronRequestDetails,
  probeApiOwnership,
  shouldInjectControlToken,
  withControlTokenHeaders,
};
