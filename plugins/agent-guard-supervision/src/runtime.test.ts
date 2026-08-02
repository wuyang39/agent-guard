import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import type {
  NativeGuardEvent,
  NativeGuardLeaseActivation,
  NativeToolDecisionRequest,
  NativeToolDecisionResponse,
} from "@agent-guard/contracts";
import { digestJson, signNativeGuardPayload } from "@agent-guard/native-guard-protocol";
import type { BeforeResult, ToolEvent } from "openclaw/plugin-sdk/plugin-entry";
import type { GuardedMarker, MarkerStore } from "./leaseRegistry";
import { AgentGuardRuntime } from "./runtime";

const NOW = "2026-08-02T10:00:00.000Z";
const DENY_OUTAGE: BeforeResult = {
  block: true,
  blockReason: "[Agent Guard:NATIVE_GUARD_PDP_UNAVAILABLE] Native guard policy decision unavailable.",
};

test("OFF returns without fetch, events, writes, approvals, blocks, or parameter changes", async () => {
  let fetchCalls = 0;
  const events: NativeGuardEvent[] = [];
  const store = memoryMarkerStore();
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("OFF must not call PDP");
    },
    emitEvent: async (event) => { events.push(event); },
    now: () => new Date(NOW),
  });

  const result = await runtime.beforeToolCall(execEvent(), execContext());

  assert.equal(result, undefined);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(events, []);
  assert.equal(store.writes.length, 0);
});

test("ACTIVE maps a valid signed deny to the stable policy block", async () => {
  const fixture = await activeFixture({ action: "deny", reasonCode: "NATIVE_POLICY_DENY", reason: "denied" });

  const result = await fixture.runtime.beforeToolCall(execEvent(), execContext());

  assert.deepEqual(result, {
    block: true,
    blockReason: "[Agent Guard:NATIVE_POLICY_DENY] denied",
  });
  assert.equal(fixture.fetchCalls(), 1);
});

test("signed deny reason fields cannot echo even a short lease credential", async () => {
  const fixture = await activeFixture({
    action: "deny",
    credential: "SECRET",
    reasonCode: "SECRET",
    reason: "SECRET",
  });

  const result = await fixture.runtime.beforeToolCall(execEvent(), execContext());

  assert.deepEqual(result, {
    block: true,
    blockReason: "[Agent Guard:NATIVE_POLICY_DENY] Denied by Agent Guard policy.",
  });
  assert.equal(JSON.stringify(fixture.events).includes("SECRET"), false);
});

test("signed deny reason cannot echo a parameter beyond the event projection scan prefix", async () => {
  const fixture = await activeFixture({
    action: "deny",
    reasonCode: "NATIVE_POLICY_DENY",
    reason: "TAILSECRET",
  });
  const params = {
    values: Array.from({ length: 2_100 }, (_value, index) =>
      index === 2_099 ? "TAILSECRET" : "x"),
  };

  const result = await fixture.runtime.beforeToolCall(
    { toolName: "exec", params, toolCallId: "call.1" },
    execContext(),
  );

  assert.deepEqual(result, {
    block: true,
    blockReason: "[Agent Guard:NATIVE_POLICY_DENY] Denied by Agent Guard policy.",
  });
  assert.equal(JSON.stringify(fixture.events).includes("TAILSECRET"), false);
});

test("ACTIVE applies only signed redact parameters with a matching digest", async () => {
  const fixture = await activeFixture({
    action: "redact",
    rewrittenParams: { body: "[REDACTED]" },
  });

  const result = await fixture.runtime.beforeToolCall(
    { toolName: "message", params: { body: "secret" }, toolCallId: "call.1" },
    { toolName: "message", sessionKey: "agent:main", toolCallId: "call.1" },
  );

  assert.deepEqual(result, { params: { body: "[REDACTED]" } });
  assert.equal("requireApproval" in (result ?? {}), false);
});

test("ACTIVE ask is denied while the host lacks awaited approval veto and lease recheck", async () => {
  const fixture = await activeFixture({ action: "ask", approvalLeaseRecheckAttested: false });

  const result = await fixture.runtime.beforeToolCall(execEvent(), execContext());

  assert.deepEqual(result, {
    block: true,
    blockReason: "[Agent Guard:NATIVE_APPROVAL_UNATTESTED] Native tool approval cannot be enforced by this host.",
  });
  assert.equal("requireApproval" in (result ?? {}), false);
  assert.deepEqual(fixture.events.map((event) => event.type), ["decision"]);
});

test("approval capability cannot be inferred from the ten contribution attestations", async () => {
  const fixture = await activeFixture({ action: "ask", approvalLeaseRecheckAttested: false });

  const first = await fixture.runtime.beforeToolCall(execEvent(), execContext());
  const status = await fixture.runtime.status();

  assert.equal("requireApproval" in (first ?? {}), false);
  assert.deepEqual(first, {
    block: true,
    blockReason: "[Agent Guard:NATIVE_APPROVAL_UNATTESTED] Native tool approval cannot be enforced by this host.",
  });
  assert.equal(status.coverage, "conditional");
  assert.equal(status.reasonCode, "NATIVE_APPROVAL_UNATTESTED");
});

test("a future host with explicit post-approval lease recheck gets allow-once and deny only", async () => {
  const fixture = await activeFixture({ action: "ask", approvalLeaseRecheckAttested: true });

  const result = await fixture.runtime.beforeToolCall(execEvent(), execContext());

  assert.deepEqual(result?.requireApproval?.allowedDecisions, ["allow-once", "deny"]);
  assert.equal(result?.requireApproval?.timeoutBehavior, "deny");
  assert.equal("params" in (result ?? {}), false);
  await result?.requireApproval?.onResolution?.("allow-once");
  assert.deepEqual(
    fixture.events.map((event) => event.type),
    ["decision", "approval_requested", "approval_resolved"],
  );
  assert.equal(fixture.events.at(-1)?.detail.resolution, "allow-once");
});

test("an attested host recheck keeps a pending approval stale after renewal", async () => {
  const fixture = await activeFixture({ action: "ask", approvalLeaseRecheckAttested: true });
  const result = await fixture.runtime.beforeToolCall(execEvent(), execContext());
  await fixture.runtime.renew(fixture.activation({
    leaseEpoch: 2,
    credential: "rotated-credential",
  }));

  await result?.requireApproval?.onResolution?.("allow-once");

  assert.equal(fixture.events.at(-1)?.type, "approval_resolved");
  assert.equal(fixture.events.at(-1)?.detail.resolution, "deny");
  assert.equal(fixture.events.at(-1)?.detail.reasonCode, "NATIVE_GUARD_LEASE_CHANGED");
});

test("ACTIVE allow emits a secret-free decision event and passes through", async () => {
  const fixture = await activeFixture({ action: "allow" });

  const result = await fixture.runtime.beforeToolCall(execEvent(), execContext());

  assert.equal(result, undefined);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0]?.type, "decision");
  assert.equal(JSON.stringify(fixture.events).includes("echo secret"), false);
  assert.equal(JSON.stringify(fixture.events).includes("credential-secret"), false);
});

test("ACTIVE warn emits a decision event and passes through", async () => {
  const fixture = await activeFixture({ action: "warn" });

  const result = await fixture.runtime.beforeToolCall(execEvent(), execContext());

  assert.equal(result, undefined);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0]?.detail.action, "warn");
});

test("a bad Ed25519 signature is treated as a high-risk PDP outage", async () => {
  const fixture = await activeFixture({ action: "allow", signature: "bad-signature" });

  assert.deepEqual(
    await fixture.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
});

test("a mismatched evaluated parameter digest is treated as a high-risk PDP outage", async () => {
  const fixture = await activeFixture({ action: "allow", evaluatedParamsDigest: "0".repeat(64) });

  assert.deepEqual(
    await fixture.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
});

test("a response with extra fields is treated as a high-risk PDP outage", async () => {
  const fixture = await activeFixture({
    action: "allow",
    transformEnvelope: (envelope) => ({ ...envelope, unexpected: true }),
  });

  assert.deepEqual(
    await fixture.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
});

test("signed decision data rejects extra fields and non-string reason codes", async () => {
  const extra = await activeFixture({
    action: "allow",
    transformDecision: (decision) => ({ ...decision, unexpected: true }),
  });
  const wrongType = await activeFixture({
    action: "allow",
    transformDecision: (decision) => ({ ...decision, reasonCode: ["NATIVE_POLICY_ALLOW"] }),
  });

  assert.deepEqual(await extra.runtime.beforeToolCall(execEvent(), execContext()), DENY_OUTAGE);
  assert.deepEqual(await wrongType.runtime.beforeToolCall(execEvent(), execContext()), DENY_OUTAGE);
});

test("an action carrying forbidden rewritten fields is treated as a PDP outage", async () => {
  const fixture = await activeFixture({
    action: "allow",
    forceRewrittenParams: { body: "changed" },
  });

  assert.deepEqual(await fixture.runtime.beforeToolCall(execEvent(), execContext()), DENY_OUTAGE);
});

test("a decision timestamp outside the accepted window is treated as a PDP outage", async () => {
  const fixture = await activeFixture({
    action: "allow",
    decidedAt: "2026-08-02T10:01:00.001Z",
  });

  assert.deepEqual(await fixture.runtime.beforeToolCall(execEvent(), execContext()), DENY_OUTAGE);
});

test("a decision ID cannot be replayed under another request in the same lease", async () => {
  const fixture = await activeFixture({ action: "allow" });

  assert.equal(await fixture.runtime.beforeToolCall(execEvent(), execContext()), undefined);
  assert.deepEqual(await fixture.runtime.beforeToolCall(
    { ...execEvent(), toolCallId: "call.2" },
    { ...execContext(), toolCallId: "call.2" },
  ), DENY_OUTAGE);
});

test("decision replay capacity exhaustion fails closed without evicting accepted IDs", async () => {
  let decisionNumber = 0;
  const fixture = await activeFixture({
    action: "allow",
    maxDecisionIdsPerLease: 1,
    decisionId: () => `decision.${++decisionNumber}`,
  });

  assert.equal(await fixture.runtime.beforeToolCall(execEvent(), execContext()), undefined);
  assert.deepEqual(await fixture.runtime.beforeToolCall(
    { ...execEvent(), toolCallId: "call.2" },
    { ...execContext(), toolCallId: "call.2" },
  ), DENY_OUTAGE);
  assert.deepEqual(await fixture.runtime.beforeToolCall(
    { ...execEvent(), toolCallId: "call.3" },
    { ...execContext(), toolCallId: "call.3" },
  ), DENY_OUTAGE);
});

test("a malformed JSON response is treated as a high-risk PDP outage", async () => {
  const fixture = await activeFixture({
    action: "allow",
    fetch: async () => jsonResponse("{not-json", 200, true),
  });

  assert.deepEqual(
    await fixture.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
});

test("the PDP timeout aborts transport and denies a high-risk tool", async () => {
  let aborted = false;
  const fixture = await activeFixture({
    action: "allow",
    decisionTimeoutMs: 20,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("transport aborted"));
      }, { once: true });
    }),
  });

  assert.deepEqual(
    await fixture.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
  assert.equal(aborted, true);
});

test("the PDP timeout covers a response body stream that never completes", async () => {
  let cancelled = false;
  const fixture = await activeFixture({
    action: "allow",
    admissionTimeoutMs: 100,
    decisionTimeoutMs: 20,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => undefined);
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });

  assert.deepEqual(await fixture.runtime.beforeToolCall(execEvent(), execContext()), DENY_OUTAGE);
  assert.equal(cancelled, true);
});

test("runtime stop cancels an in-flight decision and a late response cannot allow", async () => {
  let release: ((response: Response) => void) | undefined;
  let observedAbort = false;
  const fixture = await activeFixture({
    action: "allow",
    fetch: async (_input, init) => await new Promise<Response>((resolve) => {
      release = resolve;
      init?.signal?.addEventListener("abort", () => { observedAbort = true; }, { once: true });
    }),
  });
  const pending = fixture.runtime.beforeToolCall(execEvent(), execContext());
  await waitFor(() => release !== undefined);

  const stopping = fixture.runtime.stop();
  release?.(await fixture.responseFor(execEvent()));

  assert.deepEqual(await pending, {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_STOPPED] Native guard runtime stopped during decision.",
  });
  await stopping;
  assert.equal(observedAbort, true);
  assert.deepEqual(fixture.events, []);
});

test("RECOVERY blocks high-risk and unknown tools with the stable recovery code", async () => {
  const runtime = recoveryRuntime();

  assert.deepEqual(await runtime.beforeToolCall(execEvent(), execContext()), {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_RECOVERY] Native guard recovery blocks this tool.",
  });
  assert.deepEqual(await runtime.beforeToolCall(
    { toolName: "agent_guard__exec", params: {}, toolCallId: "call.2" },
    { toolName: "agent_guard__exec", sessionKey: "agent:main", toolCallId: "call.2" },
  ), {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_RECOVERY] Native guard recovery blocks this tool.",
  });
});

test("RECOVERY passes only an explicit exact low-risk tool without network or events", async () => {
  let fetchCalls = 0;
  const events: NativeGuardEvent[] = [];
  const runtime = recoveryRuntime({
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("recovery must not fetch");
    },
    emitEvent: async (event: NativeGuardEvent) => { events.push(event); },
  });

  const result = await runtime.beforeToolCall(
    { toolName: "session_status", params: {}, toolCallId: "call.low" },
    { toolName: "session_status", sessionKey: "agent:main", toolCallId: "call.low" },
  );

  assert.equal(result, undefined);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(events, []);
});

test("ACTIVE low-risk outage follows immutable allow failure policy", async () => {
  const fixture = await activeFixture({
    action: "allow",
    toolName: "session_status",
    failurePolicyLowRisk: "allow",
    fetch: async () => { throw new Error("backend unavailable"); },
  });

  const result = await fixture.runtime.beforeToolCall(lowRiskEvent(), lowRiskContext());

  assert.equal(result, undefined);
  assert.equal(fixture.events.length, 0);
});

test("ACTIVE low-risk outage follows immutable warn failure policy and emits an event", async () => {
  const fixture = await activeFixture({
    action: "allow",
    toolName: "session_status",
    failurePolicyLowRisk: "warn",
    fetch: async () => { throw new Error("backend unavailable"); },
  });

  const result = await fixture.runtime.beforeToolCall(lowRiskEvent(), lowRiskContext());

  assert.equal(result, undefined);
  assert.equal(fixture.events.length, 1);
  assert.equal(fixture.events[0]?.type, "decision");
  assert.equal(fixture.events[0]?.detail.reasonCode, "NATIVE_GUARD_PDP_UNAVAILABLE");
  assert.equal(JSON.stringify(fixture.events).includes("backend unavailable"), false);
});

test("ACTIVE high-risk outage denies regardless of low-risk failure policy", async () => {
  const fixture = await activeFixture({
    action: "allow",
    failurePolicyLowRisk: "allow",
    fetch: async () => { throw new Error("backend unavailable"); },
  });

  assert.deepEqual(
    await fixture.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
});

test("ACTIVE and RECOVERY reject a missing toolCallId without calling the PDP", async () => {
  const fixture = await activeFixture({ action: "allow" });
  const event = { toolName: "session_status", params: {} };
  const context = { toolName: "session_status", sessionKey: "agent:main" };

  const active = await fixture.runtime.beforeToolCall(event, context);
  const recovery = await recoveryRuntime().beforeToolCall(event, context);

  const expected = {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_CONTEXT_INVALID] Native guard tool context is incomplete.",
  };
  assert.deepEqual(active, expected);
  assert.deepEqual(recovery, expected);
  assert.equal(fixture.fetchCalls(), 0);
});

test("a renewal during the PDP request invalidates the old signed allow", async () => {
  let release: ((response: Response) => void) | undefined;
  const fixture = await activeFixture({
    action: "allow",
    fetch: async () => await new Promise<Response>((resolve) => { release = resolve; }),
  });
  const pending = fixture.runtime.beforeToolCall(execEvent(), execContext());
  await waitFor(() => release !== undefined);
  await fixture.runtime.renew(fixture.activation({
    leaseEpoch: 2,
    credential: "rotated-credential",
  }));
  release?.(await fixture.responseFor(execEvent()));

  assert.deepEqual(await pending, {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_LEASE_CHANGED] Native guard lease changed during decision.",
  });
  assert.deepEqual(fixture.events, []);
});

test("the default client performs a bounded real HTTP request with bearer authentication", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  let observedAuthorization: string | undefined;
  let observedRequest: NativeToolDecisionRequest | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    request.on("end", () => {
      observedAuthorization = request.headers.authorization;
      observedRequest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as NativeToolDecisionRequest;
      const unsigned = decisionResponse(observedRequest, { action: "allow" });
      const data = { ...unsigned, signature: signNativeGuardPayload(unsigned, privateKey) };
      const body = JSON.stringify({ ok: true, data, requestId: "api.request.1" });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const fixture = await activeFixture({
    action: "allow",
    privateKey,
    publicKey,
    backendUrl: `http://127.0.0.1:${address.port}/api/v1/openclaw/native-guard/decision`,
    useDefaultFetch: true,
  });

  assert.equal(await fixture.runtime.beforeToolCall(execEvent(), execContext()), undefined);
  assert.equal(observedAuthorization, "Bearer credential-secret");
  assert.equal(observedRequest?.toolCallId, "call.1");
  assert.equal(observedRequest?.paramsDigest, digestJson({ command: "echo secret" }));
});

type FixtureOptions = {
  action: NativeToolDecisionResponse["action"];
  reasonCode?: string;
  reason?: string;
  rewrittenParams?: Record<string, unknown>;
  evaluatedParamsDigest?: string;
  signature?: string;
  failurePolicyLowRisk?: "allow" | "warn";
  toolName?: string;
  decisionTimeoutMs?: number;
  backendUrl?: string;
  privateKey?: KeyObject;
  publicKey?: KeyObject;
  useDefaultFetch?: boolean;
  fetch?: typeof globalThis.fetch;
  transformEnvelope?: (value: Record<string, unknown>) => Record<string, unknown>;
  transformDecision?: (value: Record<string, unknown>) => Record<string, unknown>;
  forceRewrittenParams?: Record<string, unknown>;
  decidedAt?: string;
  decisionId?: () => string;
  maxDecisionIdsPerLease?: number;
  approvalLeaseRecheckAttested?: boolean;
  admissionTimeoutMs?: number;
  credential?: string;
};

async function activeFixture(options: FixtureOptions) {
  const generated = options.privateKey && options.publicKey
    ? { privateKey: options.privateKey, publicKey: options.publicKey }
    : generateKeyPairSync("ed25519");
  const privateKey = generated.privateKey;
  const publicKey = generated.publicKey;
  const events: NativeGuardEvent[] = [];
  let calls = 0;
  const store = memoryMarkerStore();
  const baseActivation = activation({
    ...(options.backendUrl === undefined ? {} : { backendUrl: options.backendUrl }),
    decisionPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    failurePolicy: {
      lowRisk: options.failurePolicyLowRisk ?? "warn",
      highRisk: "deny",
      unknownRisk: "deny",
    },
    ...(options.credential === undefined ? {} : { credential: options.credential }),
  });
  let responseForRequest: ((request: NativeToolDecisionRequest) => Response) | undefined;
  const signedResponse = (request: NativeToolDecisionRequest): Response => {
    const unsigned = decisionResponse(request, options);
    const signedPayload = options.transformDecision?.({ ...unsigned }) ?? unsigned;
    const signature = options.signature ?? signNativeGuardPayload(signedPayload, privateKey);
    const data = { ...signedPayload, signature };
    const envelope = options.transformEnvelope?.({
      ok: true,
      data,
      requestId: "api.request.1",
    }) ?? { ok: true, data, requestId: "api.request.1" };
    return jsonResponse(JSON.stringify(envelope));
  };
  responseForRequest = signedResponse;
  const configuredFetch = options.fetch ?? (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const request = JSON.parse(String(init?.body)) as NativeToolDecisionRequest;
    return signedResponse(request);
  });
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    admissionTimeoutMs: options.admissionTimeoutMs,
    ...(options.useDefaultFetch ? {} : { fetch: configuredFetch }),
    decisionTimeoutMs: options.decisionTimeoutMs,
    maxDecisionIdsPerLease: options.maxDecisionIdsPerLease,
    approvalLeaseRecheckAttested: options.approvalLeaseRecheckAttested ?? true,
    emitEvent: async (event) => { events.push(structuredClone(event)); },
    createId: (() => {
      let id = 0;
      return (prefix: string) => `${prefix}.${++id}`;
    })(),
  });
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  await runtime.activate(baseActivation);
  return {
    runtime,
    events,
    fetchCalls: () => calls,
    activation: (overrides: Partial<NativeGuardLeaseActivation> = {}) => activation({
      ...baseActivation,
      ...overrides,
    }),
    responseFor: async (event: ToolEvent) => responseForRequest?.({
      schemaVersion: "native-guard-1",
      requestId: "native_guard_request.1",
      leaseId: baseActivation.leaseId,
      leaseEpoch: baseActivation.leaseEpoch,
      sessionKey: baseActivation.rootSessionKey,
      runId: event.runId,
      toolCallId: event.toolCallId ?? "call.1",
      toolName: event.toolName,
      toolKind: event.toolKind,
      toolInputKind: event.toolInputKind,
      params: event.params,
      paramsDigest: digestJson(event.params),
      derivedPaths: event.derivedPaths ? [...event.derivedPaths] : undefined,
      requestedAt: NOW,
    } as NativeToolDecisionRequest) ?? jsonResponse("{}"),
  };
}

function decisionResponse(
  request: NativeToolDecisionRequest,
  options: Pick<
    FixtureOptions,
    | "action"
    | "reasonCode"
    | "reason"
    | "rewrittenParams"
    | "evaluatedParamsDigest"
    | "forceRewrittenParams"
    | "decidedAt"
    | "decisionId"
  >,
): Omit<NativeToolDecisionResponse, "signature"> {
  const rewrittenParams = options.action === "redact"
    ? options.rewrittenParams ?? { body: "[REDACTED]" }
    : undefined;
  return {
    schemaVersion: "native-guard-1",
    decisionId: options.decisionId?.() ?? "decision.1",
    requestId: request.requestId,
    leaseId: request.leaseId,
    leaseEpoch: request.leaseEpoch,
    policyPackId: "pack.1",
    policyPackDigest: "b".repeat(64),
    action: options.action,
    reasonCode: options.reasonCode ?? `NATIVE_POLICY_${options.action.toUpperCase()}`,
    reason: options.reason ?? `${options.action} by policy`,
    evaluatedParamsDigest: options.evaluatedParamsDigest ?? request.paramsDigest,
    ...(rewrittenParams === undefined && options.forceRewrittenParams === undefined
      ? {}
      : {
          rewrittenParams: rewrittenParams ?? options.forceRewrittenParams,
          rewrittenParamsDigest: digestJson(rewrittenParams ?? options.forceRewrittenParams),
        }),
    decidedAt: options.decidedAt ?? NOW,
  };
}

function activation(overrides: Partial<NativeGuardLeaseActivation> = {}): NativeGuardLeaseActivation {
  const { publicKey } = generateKeyPairSync("ed25519");
  return {
    schemaVersion: "native-guard-1",
    leaseId: "lease.1",
    leaseEpoch: 1,
    rootSessionKey: "agent:main",
    mode: "supervision",
    scope: "session_tree",
    policyPackId: "pack.1",
    policyPackDigest: "b".repeat(64),
    backendUrl: "http://127.0.0.1:3100/api/v1/openclaw/native-guard/decision",
    decisionPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    failurePolicy: { lowRisk: "warn", highRisk: "deny", unknownRisk: "deny" },
    issuedAt: "2026-08-02T09:59:59.000Z",
    expiresAt: "2026-08-02T10:05:00.000Z",
    credential: "credential-secret",
    ...overrides,
  };
}

function recoveryRuntime(overrides: Record<string, unknown> = {}): AgentGuardRuntime {
  return new AgentGuardRuntime({
    markerStore: memoryMarkerStore([{
      leaseId: "lease.1",
      rootSessionKey: "agent:main",
      childSessionKeys: [],
      mode: "supervision",
      policyPackId: "pack.1",
      policyPackDigest: "b".repeat(64),
      expiresAt: "2026-08-02T10:05:00.000Z",
    }]),
    now: () => new Date(NOW),
    ...overrides,
  });
}

function memoryMarkerStore(initial: GuardedMarker[] = []): MarkerStore & { writes: GuardedMarker[] } {
  let markers = structuredClone(initial);
  const writes: GuardedMarker[] = [];
  return {
    writes,
    async load() { return structuredClone(markers); },
    async write(marker) {
      writes.push(structuredClone(marker));
      markers = [...markers.filter((candidate) => candidate.leaseId !== marker.leaseId), structuredClone(marker)];
    },
    async remove(leaseId) {
      markers = markers.filter((marker) => marker.leaseId !== leaseId);
    },
  };
}

function jsonResponse(body: string, status = 200, raw = false): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
      ...(raw ? {} : { "Cache-Control": "no-store" }),
    },
  });
}

function execEvent(): ToolEvent {
  return { toolName: "exec", params: { command: "echo secret" }, toolCallId: "call.1" };
}

function execContext() {
  return { toolName: "exec", sessionKey: "agent:main", toolCallId: "call.1" };
}

function lowRiskEvent(): ToolEvent {
  return { toolName: "session_status", params: {}, toolCallId: "call.low" };
}

function lowRiskContext() {
  return { toolName: "session_status", sessionKey: "agent:main", toolCallId: "call.low" };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}
