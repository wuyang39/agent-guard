import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import type {
  NativeGuardAction,
  NativeGuardEvent,
  NativeGuardLeaseActivation,
  NativeToolDecisionRequest,
  NativeToolDecisionResponse,
  SupervisionAction,
  SupervisionPolicy,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import { canonicalJson, digestJson, signNativeGuardPayload } from "@agent-guard/native-guard-protocol";
import type { BeforeResult, ToolContext, ToolEvent } from "openclaw/plugin-sdk/plugin-entry";
import { createNativeGuardLeaseService } from "../../../backend/src/modules/openclaw/nativeGuardLeaseService";
import { createNativeToolDecisionService } from "../../../backend/src/modules/openclaw/nativeToolDecisionService";
import { createDecisionClient } from "./decisionClient";
import type { ActiveLeaseLookup, GuardedMarker, MarkerStore } from "./leaseRegistry";
import { AgentGuardRuntime } from "./runtime";
import { createLifecycleClient, type LifecycleClient } from "./lifecycleClient";

const NOW = "2026-08-02T10:00:00.000Z";
const MAX_PARAM_BYTES = 256 * 1024;
const MAX_PARAM_DEPTH = 32;
const MAX_PARAM_KEYS = 4_096;
const DENY_OUTAGE: BeforeResult = {
  block: true,
  blockReason: "[Agent Guard:NATIVE_GUARD_PDP_UNAVAILABLE] Native guard policy decision unavailable.",
};
const HOST_CANCELLED: BeforeResult = {
  block: true,
  blockReason: "[Agent Guard:NATIVE_GUARD_CANCELLED] Native guard tool call was cancelled.",
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

test("lifecycle client derives only the exact loopback bind path and uses evidence identity", async () => {
  let observedUrl = "";
  let observedAuthorization = "";
  const client = createLifecycleClient({
    fetch: async (input, init) => {
      observedUrl = String(input);
      observedAuthorization = String((init?.headers as Record<string, string>).Authorization);
      return jsonResponse(JSON.stringify({
        ok: true,
        data: { bound: true },
        requestId: "lifecycle-request",
      }));
    },
  });
  const lease = lifecycleLease();

  await client.bindChild(lease, {
    leaseId: lease.leaseId,
    leaseEpoch: lease.leaseEpoch,
    parentSessionKey: lease.rootSessionKey,
    childSessionKey: "agent:child",
  }, new AbortController().signal);

  assert.equal(
    observedUrl,
    "http://127.0.0.1:3100/api/v1/openclaw/native-guard/lifecycle/bind-child",
  );
  assert.equal(observedAuthorization, "Bearer evidence-credential-secret");
});

test("lifecycle client rejects non-loopback, wrong decision path, redirects, and oversized bodies", async () => {
  let fetchCalls = 0;
  const client = createLifecycleClient({
    fetch: async () => {
      fetchCalls += 1;
      const response = jsonResponse("{}", 302);
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    },
  });
  const base = lifecycleLease();
  for (const backendUrl of [
    "http://example.com/api/v1/openclaw/native-guard/decision",
    "http://127.0.0.1:3100/api/v1/openclaw/native-guard/events/batch",
  ]) {
    await assert.rejects(client.bindChild({ ...base, backendUrl }, {
      leaseId: base.leaseId,
      leaseEpoch: 1,
      parentSessionKey: base.rootSessionKey,
      childSessionKey: "agent:child",
    }, new AbortController().signal), /lifecycle synchronization failed/);
  }
  await assert.rejects(client.bindChild(base, {
    leaseId: base.leaseId,
    leaseEpoch: 1,
    parentSessionKey: base.rootSessionKey,
    childSessionKey: "x".repeat(20 * 1024),
  }, new AbortController().signal), /lifecycle synchronization failed/);
  await assert.rejects(client.bindChild(base, {
    leaseId: base.leaseId,
    leaseEpoch: 1,
    parentSessionKey: base.rootSessionKey,
    childSessionKey: "agent:child",
  }, new AbortController().signal), /lifecycle synchronization failed/);
  assert.equal(fetchCalls, 1);
});

test("lifecycle timeout and host abort cover a stalled response body and clean listeners", async () => {
  const host = observedAbortSignal();
  let bodyCancelled = 0;
  const client = createLifecycleClient({
    timeoutMs: 20,
    fetch: async () => new Response(new ReadableStream({
      pull() { return new Promise(() => undefined); },
      cancel() { bodyCancelled += 1; },
    }), { headers: { "content-type": "application/json" } }),
  });
  const lease = lifecycleLease();
  const pending = client.endSession(lease, {
    leaseId: lease.leaseId,
    leaseEpoch: 1,
    sessionKey: lease.rootSessionKey,
  }, host.signal);

  await assert.rejects(pending, /lifecycle synchronization failed/);
  assert.equal(bodyCancelled, 1);
  assert.deepEqual(host.listenerCounts(), { added: 1, removed: 1 });

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(client.endSession(lease, {
    leaseId: lease.leaseId,
    leaseEpoch: 1,
    sessionKey: lease.rootSessionKey,
  }, alreadyAborted.signal), /lifecycle synchronization failed/);
});

test("lifecycle response bounds fail with a secret-free error", async () => {
  const lease = lifecycleLease();
  const client = createLifecycleClient({
    fetch: async () => new Response("x", {
      headers: {
        "content-type": "application/json",
        "content-length": String(65 * 1024),
      },
    }),
  });
  let caught: unknown;
  try {
    await client.bindChild(lease, {
      leaseId: lease.leaseId,
      leaseEpoch: 1,
      parentSessionKey: lease.rootSessionKey,
      childSessionKey: "agent:child",
    }, new AbortController().signal);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message.includes(lease.evidenceCredential), false);
  assert.match(caught.message, /lifecycle synchronization failed/);
});

test("ACTIVE maps a valid signed deny to the stable policy block", async () => {
  const fixture = await activeFixture({ action: "deny", reasonCode: "policy_deny", reason: "denied" });

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
    credential: "secret",
    reasonCode: "policy_deny",
    reason: "secret",
  });

  const result = await fixture.runtime.beforeToolCall(execEvent(), execContext());

  assert.deepEqual(result, {
    block: true,
    blockReason: "[Agent Guard:NATIVE_POLICY_DENY] Denied by Agent Guard policy.",
  });
  assert.equal(JSON.stringify(fixture.events).includes("secret"), false);
});

test("signed deny reason cannot echo a parameter beyond the event projection scan prefix", async () => {
  const fixture = await activeFixture({
    action: "deny",
    reasonCode: "policy_deny",
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

test("signed rewritten params accept exactly 256 KiB and reject one byte more", async () => {
  const exactParams = paramsAtCanonicalBytes(MAX_PARAM_BYTES);
  const exact = await activeFixture({ action: "redact", rewrittenParams: exactParams });
  const oversized = await activeFixture({
    action: "redact",
    rewrittenParams: paramsAtCanonicalBytes(MAX_PARAM_BYTES + 1),
  });

  const exactResult = await exact.runtime.beforeToolCall(execEvent(), execContext());

  assert.equal((exactResult?.params?.body as string).length, exactParams.body.length);
  assert.deepEqual(
    await oversized.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
});

test("signed rewritten params accept exactly 4096 keys and reject one more", async () => {
  const exact = await activeFixture({ action: "redact", rewrittenParams: paramsWithKeys(MAX_PARAM_KEYS) });
  const excessive = await activeFixture({
    action: "redact",
    rewrittenParams: paramsWithKeys(MAX_PARAM_KEYS + 1),
  });

  const exactResult = await exact.runtime.beforeToolCall(execEvent(), execContext());

  assert.equal(Object.keys(exactResult?.params ?? {}).length, MAX_PARAM_KEYS);
  assert.deepEqual(
    await excessive.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
});

test("signed rewritten params accept depth 32 and reject depth 33 without recursion failure", async () => {
  const exact = await activeFixture({ action: "redact", rewrittenParams: paramsAtDepth(MAX_PARAM_DEPTH) });
  const tooDeep = await activeFixture({
    action: "redact",
    rewrittenParams: paramsAtDepth(MAX_PARAM_DEPTH + 1),
  });

  assert.ok((await exact.runtime.beforeToolCall(execEvent(), execContext()))?.params);
  assert.deepEqual(
    await tooDeep.runtime.beforeToolCall(execEvent(), execContext()),
    DENY_OUTAGE,
  );
});

test("signed rewritten params reject dangerous prototype keys despite a matching digest", async () => {
  const fixture = await activeFixture({
    action: "redact",
    rewrittenParams: JSON.parse('{"safe":true,"__proto__":{"polluted":true}}') as Record<string, unknown>,
  });

  assert.deepEqual(await fixture.runtime.beforeToolCall(execEvent(), execContext()), DENY_OUTAGE);
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("input params enforce the same byte, key, depth, and dangerous-key boundaries before fetch", async () => {
  const exactBytes = await activeFixture({ action: "allow" });
  assert.equal(await exactBytes.runtime.beforeToolCall(
    { ...execEvent(), params: paramsAtCanonicalBytes(MAX_PARAM_BYTES) },
    execContext(),
  ), undefined);
  assert.equal(exactBytes.fetchCalls(), 1);

  for (const [name, params] of [
    ["bytes", paramsAtCanonicalBytes(MAX_PARAM_BYTES + 1)],
    ["keys", paramsWithKeys(MAX_PARAM_KEYS + 1)],
    ["depth", paramsAtDepth(MAX_PARAM_DEPTH + 1)],
    ["prototype", JSON.parse('{"constructor":{"prototype":{"polluted":true}}}')],
  ] as const) {
    const fixture = await activeFixture({ action: "allow" });
    const result = await fixture.runtime.beforeToolCall(
      { ...execEvent(), params },
      execContext(),
    );
    assert.deepEqual(result, DENY_OUTAGE, name);
    assert.equal(fixture.fetchCalls(), 0, name);
  }
});

test("input params reject array accessors without invoking them", async () => {
  let getterCalls = 0;
  const values: unknown[] = [undefined];
  Object.defineProperty(values, 0, {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return "secret";
    },
  });
  const fixture = await activeFixture({ action: "allow" });

  const result = await fixture.runtime.beforeToolCall(
    { ...execEvent(), params: { values } },
    execContext(),
  );

  assert.deepEqual(result, DENY_OUTAGE);
  assert.equal(getterCalls, 0);
  assert.equal(fixture.fetchCalls(), 0);
});

test("input params reject proxies without invoking their get traps", async () => {
  let getCalls = 0;
  const params = new Proxy({ body: "safe" }, {
    get(target, property, receiver) {
      getCalls += 1;
      if (property === "body") return "x".repeat(MAX_PARAM_BYTES + 1);
      return Reflect.get(target, property, receiver);
    },
  });
  const fixture = await activeFixture({ action: "allow" });

  const result = await fixture.runtime.beforeToolCall(
    { ...execEvent(), params },
    execContext(),
  );

  assert.deepEqual(result, DENY_OUTAGE);
  assert.equal(getCalls, 0);
  assert.equal(fixture.fetchCalls(), 0);
});

test("ACTIVE rejects low-risk proxies before counting prototype and key traps", async () => {
  for (const trap of ["getPrototypeOf", "ownKeys"] as const) {
    let trapCalls = 0;
    const params = new Proxy({}, {
      [trap]: () => {
        trapCalls += 1;
        return trap === "getPrototypeOf" ? Object.prototype : [];
      },
    });
    const fixture = await activeFixture({ action: "allow" });

    const result = await fixture.runtime.beforeToolCall(
      { ...lowRiskEvent(), params },
      lowRiskContext(),
    );

    assert.deepEqual(result, DENY_OUTAGE, trap);
    assert.equal(trapCalls, 0, trap);
    assert.equal(fixture.fetchCalls(), 0, trap);
  }
});

test("ACTIVE rejects low-risk proxies before throwing prototype and key traps", async () => {
  for (const trap of ["getPrototypeOf", "ownKeys"] as const) {
    let trapCalls = 0;
    const params = new Proxy({}, {
      [trap]: () => {
        trapCalls += 1;
        throw new Error(`${trap} trap must not run`);
      },
    });
    const fixture = await activeFixture({ action: "allow" });

    const result = await fixture.runtime.beforeToolCall(
      { ...lowRiskEvent(), params },
      lowRiskContext(),
    );

    assert.deepEqual(result, DENY_OUTAGE, trap);
    assert.equal(trapCalls, 0, trap);
    assert.equal(fixture.fetchCalls(), 0, trap);
  }
});

test("oversized input params fail before building a canonical string", async () => {
  const fixture = await activeFixture({ action: "allow" });
  const originalByteLength = Buffer.byteLength;
  let largestMeasuredString = 0;
  Buffer.byteLength = ((value: string | NodeJS.ArrayBufferView, encoding?: BufferEncoding) => {
    if (typeof value === "string") largestMeasuredString = Math.max(largestMeasuredString, value.length);
    return originalByteLength(value, encoding);
  }) as typeof Buffer.byteLength;

  let result: BeforeResult | void;
  try {
    result = await fixture.runtime.beforeToolCall(
      { ...execEvent(), params: { body: "x".repeat(MAX_PARAM_BYTES + 1) } },
      execContext(),
    );
  } finally {
    Buffer.byteLength = originalByteLength;
  }

  assert.deepEqual(result, DENY_OUTAGE);
  assert.ok(largestMeasuredString < MAX_PARAM_BYTES);
  assert.equal(fixture.fetchCalls(), 0);
});

test("deep redact responses are bounded before response canonicalization", async () => {
  const deepRewrite = paramsAtDepth(128);
  const fixture = await activeFixture({
    action: "redact",
    transformEnvelope: (envelope) => ({
      ...envelope,
      data: {
        ...(envelope.data as Record<string, unknown>),
        rewrittenParams: deepRewrite,
        rewrittenParamsDigest: "a".repeat(64),
      },
    }),
  });
  const originalGetPrototypeOf = Object.getPrototypeOf;
  let deepPrototypeChecks = 0;
  Object.getPrototypeOf = ((value: unknown) => {
    if (
      typeof value === "object" &&
      value !== null &&
      Object.hasOwn(value, "nested")
    ) {
      deepPrototypeChecks += 1;
    }
    return originalGetPrototypeOf(value);
  }) as typeof Object.getPrototypeOf;

  let result: BeforeResult | void;
  try {
    result = await fixture.runtime.beforeToolCall(execEvent(), execContext());
  } finally {
    Object.getPrototypeOf = originalGetPrototypeOf;
  }

  assert.deepEqual(result, DENY_OUTAGE);
  assert.ok(deepPrototypeChecks <= MAX_PARAM_DEPTH + 4, String(deepPrototypeChecks));
});

test("oversized dense arrays stop before own-key and descriptor enumeration", async () => {
  const dense = Array.from({ length: 140_000 }, () => null);
  const originalOwnKeys = Reflect.ownKeys;
  const originalDescriptors = Object.getOwnPropertyDescriptors;
  let ownKeyCalls = 0;
  let descriptorCalls = 0;
  Reflect.ownKeys = ((value: object) => {
    if (value === dense) ownKeyCalls += 1;
    return originalOwnKeys(value);
  }) as typeof Reflect.ownKeys;
  Object.getOwnPropertyDescriptors = ((value: object) => {
    if (value === dense) descriptorCalls += 1;
    return originalDescriptors(value);
  }) as typeof Object.getOwnPropertyDescriptors;
  const fixture = await activeFixture({ action: "allow" });

  let result: BeforeResult | void;
  try {
    result = await fixture.runtime.beforeToolCall(
      { ...execEvent(), params: { dense } },
      execContext(),
    );
  } finally {
    Reflect.ownKeys = originalOwnKeys;
    Object.getOwnPropertyDescriptors = originalDescriptors;
  }

  assert.deepEqual(result, DENY_OUTAGE);
  assert.equal(ownKeyCalls, 0);
  assert.equal(descriptorCalls, 0);
  assert.equal(fixture.fetchCalls(), 0);
});

test("excess object keys stop before full own-key and descriptor collection", async () => {
  const excessive = paramsWithKeys(MAX_PARAM_KEYS + 1);
  const originalOwnKeys = Reflect.ownKeys;
  const originalDescriptors = Object.getOwnPropertyDescriptors;
  let ownKeyCalls = 0;
  let descriptorCalls = 0;
  Reflect.ownKeys = ((value: object) => {
    if (value === excessive) ownKeyCalls += 1;
    return originalOwnKeys(value);
  }) as typeof Reflect.ownKeys;
  Object.getOwnPropertyDescriptors = ((value: object) => {
    if (value === excessive) descriptorCalls += 1;
    return originalDescriptors(value);
  }) as typeof Object.getOwnPropertyDescriptors;
  const fixture = await activeFixture({ action: "allow" });

  let result: BeforeResult | void;
  try {
    result = await fixture.runtime.beforeToolCall(
      { ...execEvent(), params: excessive },
      execContext(),
    );
  } finally {
    Reflect.ownKeys = originalOwnKeys;
    Object.getOwnPropertyDescriptors = originalDescriptors;
  }

  assert.deepEqual(result, DENY_OUTAGE);
  assert.equal(ownKeyCalls, 0);
  assert.equal(descriptorCalls, 0);
  assert.equal(fixture.fetchCalls(), 0);
});

test("derived paths reject custom iterators and index accessors without invoking them", async () => {
  for (const kind of ["iterator", "index"] as const) {
    let calls = 0;
    const derivedPaths = ["C:\\safe.txt"];
    if (kind === "iterator") {
      Object.defineProperty(derivedPaths, Symbol.iterator, {
        configurable: true,
        value: () => {
          calls += 1;
          throw new Error("custom iterator must not run");
        },
      });
    } else {
      Object.defineProperty(derivedPaths, 0, {
        configurable: true,
        enumerable: true,
        get() {
          calls += 1;
          return "C:\\secret.txt";
        },
      });
    }
    const fixture = await activeFixture({ action: "allow" });

    const result = await fixture.runtime.beforeToolCall(
      { ...execEvent(), derivedPaths },
      execContext(),
    );

    assert.deepEqual(result, DENY_OUTAGE, kind);
    assert.equal(calls, 0, kind);
    assert.equal(fixture.fetchCalls(), 0, kind);
  }
});

test("derived paths enforce item, string, envelope, and custom-array bounds before fetch", async () => {
  const extraKey = ["C:\\safe.txt"] as string[] & { extra?: boolean };
  extraKey.extra = true;
  for (const [name, derivedPaths] of [
    ["items", Array.from({ length: 257 }, (_value, index) => `C:\\${index}.txt`)],
    ["string", ["x".repeat(4_097)]],
    ["envelope", Array.from({ length: 17 }, () => "x".repeat(4_096))],
    ["extra-key", extraKey],
  ] as const) {
    const fixture = await activeFixture({ action: "allow" });

    const result = await fixture.runtime.beforeToolCall(
      { ...execEvent(), derivedPaths },
      execContext(),
    );

    assert.deepEqual(result, DENY_OUTAGE, name);
    assert.equal(fixture.fetchCalls(), 0, name);
  }
});

test("context-only execution metadata drives both the request and outage risk", async () => {
  for (const scenario of [
    { context: { toolKind: "code_mode_exec" as const }, failurePolicyLowRisk: "allow" as const },
    { context: { toolInputKind: "typescript" as const }, failurePolicyLowRisk: "warn" as const },
  ]) {
    let request: NativeToolDecisionRequest | undefined;
    const fixture = await activeFixture({
      action: "allow",
      failurePolicyLowRisk: scenario.failurePolicyLowRisk,
      fetch: async (_input, init) => {
        request = JSON.parse(String(init?.body)) as NativeToolDecisionRequest;
        throw new Error("PDP unavailable");
      },
    });

    const result = await fixture.runtime.beforeToolCall(
      lowRiskEvent(),
      { ...lowRiskContext(), ...scenario.context },
    );

    assert.deepEqual(result, DENY_OUTAGE);
    assert.equal(request?.toolKind, scenario.context.toolKind);
    assert.equal(request?.toolInputKind, scenario.context.toolInputKind);
  }
});

test("event-only execution metadata stays high-risk and conflicting metadata blocks", async () => {
  let request: NativeToolDecisionRequest | undefined;
  const eventOnly = await activeFixture({
    action: "allow",
    failurePolicyLowRisk: "allow",
    fetch: async (_input, init) => {
      request = JSON.parse(String(init?.body)) as NativeToolDecisionRequest;
      throw new Error("PDP unavailable");
    },
  });

  assert.deepEqual(await eventOnly.runtime.beforeToolCall(
    { ...lowRiskEvent(), toolInputKind: "javascript" },
    lowRiskContext(),
  ), DENY_OUTAGE);
  assert.equal(request?.toolInputKind, "javascript");

  const conflict = await activeFixture({ action: "allow" });
  assert.deepEqual(await conflict.runtime.beforeToolCall(
    { ...lowRiskEvent(), toolInputKind: "javascript" },
    { ...lowRiskContext(), toolInputKind: "typescript" },
  ), {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_CONTEXT_INVALID] Native guard tool context is incomplete.",
  });
  assert.equal(conflict.fetchCalls(), 0);
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
    evidenceCredential: "rotated-evidence-credential",
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

test("signed epoch-one outcome survives an after lookup paused across renewal", async () => {
  const fixture = await activeFixture({ action: "allow" });
  assert.equal(await fixture.runtime.beforeToolCall(execEvent(), execContext()), undefined);
  const originalLookup = fixture.runtime.registry.lookupActiveLease.bind(fixture.runtime.registry);
  const entered = deferred();
  const release = deferred();
  let pauseNextLookup = true;
  fixture.runtime.registry.lookupActiveLease = async (leaseId) => {
    if (pauseNextLookup) {
      pauseNextLookup = false;
      entered.resolve();
      await release.promise;
    }
    return originalLookup(leaseId);
  };

  fixture.runtime.afterToolCall(
    { ...execEvent(), result: "epoch-one-result", durationMs: 4 },
    execContext(),
  );
  await entered.promise;
  await fixture.runtime.renew(fixture.activation({
    leaseEpoch: 2,
    credential: "rotated-credential",
    evidenceCredential: "rotated-evidence-credential",
  }));
  release.resolve();
  await waitFor(() => fixture.events.some(({ type }) => type === "tool_outcome"));

  const outcome = fixture.events.find(({ type }) => type === "tool_outcome")!;
  assert.equal(outcome.leaseId, "lease.1");
  assert.equal(outcome.leaseEpoch, 1);
  assert.equal(outcome.sessionKey, "agent:main");
  assert.equal(outcome.toolCallId, "call.1");
  assert.equal(outcome.decisionId, "decision.1");
});

test("signed child outcome survives an after lookup paused across child end", async () => {
  const fixture = await activeFixture({
    action: "allow",
    lifecycleClient: successfulLifecycleClient(),
  });
  assert.equal(await fixture.runtime.bindChild("lease.1", "agent:main", "agent:child"), true);
  const childEvent = { ...execEvent(), toolCallId: "call.child" };
  const childContext = execContext({ sessionKey: "agent:child", toolCallId: "call.child" });
  assert.equal(await fixture.runtime.beforeToolCall(childEvent, childContext), undefined);
  const originalLookup = fixture.runtime.registry.lookupActiveLease.bind(fixture.runtime.registry);
  const entered = deferred();
  const release = deferred();
  let pauseNextLookup = true;
  fixture.runtime.registry.lookupActiveLease = async (leaseId) => {
    if (pauseNextLookup) {
      pauseNextLookup = false;
      entered.resolve();
      await release.promise;
    }
    return originalLookup(leaseId);
  };

  fixture.runtime.afterToolCall(
    { ...childEvent, result: "child-result", durationMs: 6 },
    childContext,
  );
  await entered.promise;
  assert.equal(await fixture.runtime.endSession("agent:child"), true);
  release.resolve();
  await waitFor(() => fixture.events.some(({ type }) => type === "tool_outcome"));

  const outcome = fixture.events.find(({ type }) => type === "tool_outcome")!;
  assert.equal(outcome.leaseId, "lease.1");
  assert.equal(outcome.leaseEpoch, 1);
  assert.equal(outcome.sessionKey, "agent:child");
  assert.equal(outcome.toolCallId, "call.child");
  assert.equal(outcome.decisionId, "decision.1");
});

test("missing host duration emits a guard-elapsed outcome instead of dropping it", async () => {
  let monotonicMs = 100;
  const fixture = await activeFixture({ action: "allow", monotonicNow: () => monotonicMs });
  assert.equal(await fixture.runtime.beforeToolCall(execEvent(), execContext()), undefined);
  monotonicMs = 137.5;

  fixture.runtime.afterToolCall(
    { ...execEvent(), result: "duration-fallback" },
    execContext(),
  );
  await waitFor(() => fixture.events.some(({ type }) => type === "tool_outcome"));

  const outcome = fixture.events.find(({ type }) => type === "tool_outcome")!;
  assert.equal(outcome.detail.durationSource, "guard_elapsed");
  assert.equal(outcome.detail.durationMs, 37.5);
});

test("low-risk PDP outage allow and warn retain guard-elapsed outcome correlation", async (t) => {
  for (const lowRiskPolicy of ["allow", "warn"] as const) {
    await t.test(lowRiskPolicy, async () => {
      let monotonicMs = 200;
      const fixture = await activeFixture({
        action: "allow",
        failurePolicyLowRisk: lowRiskPolicy,
        fetch: async () => { throw new Error("PDP offline"); },
        monotonicNow: () => monotonicMs,
      });
      assert.equal(
        await fixture.runtime.beforeToolCall(lowRiskEvent(), lowRiskContext()),
        undefined,
      );
      monotonicMs = 225;
      fixture.runtime.afterToolCall(
        { ...lowRiskEvent(), result: "outage-result" },
        lowRiskContext(),
      );
      await waitFor(() => fixture.events.some(({ type }) => type === "tool_outcome"));
      const outcome = fixture.events.find(({ type }) => type === "tool_outcome")!;
      assert.equal(outcome.leaseEpoch, 1);
      assert.equal(outcome.detail.durationSource, "guard_elapsed");
      assert.equal(outcome.detail.durationMs, 25);
    });
  }
});

test("outcome correlation capacity preserves the oldest executable call and blocks a new one", async () => {
  let monotonicMs = 300;
  let decisionNumber = 0;
  const fixture = await activeFixture({
    action: "allow",
    decisionId: () => `decision.capacity.${++decisionNumber}`,
    monotonicNow: () => monotonicMs,
    maxOutcomeCorrelations: 1,
  });
  assert.equal(await fixture.runtime.beforeToolCall(execEvent(), execContext()), undefined);
  const secondEvent = { ...execEvent(), toolCallId: "call.2" };
  const secondContext = execContext({ toolCallId: "call.2" });

  assert.deepEqual(await fixture.runtime.beforeToolCall(secondEvent, secondContext), {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_EVIDENCE_CAPACITY] Native guard outcome correlation capacity is exhausted.",
  });
  monotonicMs = 340;
  fixture.runtime.afterToolCall(
    { ...execEvent(), result: "oldest-call" },
    execContext(),
  );
  await waitFor(() => fixture.events.some(({ type }) => type === "tool_outcome"));

  const outcome = fixture.events.find(({ type }) => type === "tool_outcome")!;
  assert.equal(outcome.toolCallId, "call.1");
  assert.equal(outcome.decisionId, "decision.capacity.1");
  assert.equal(outcome.detail.durationSource, "guard_elapsed");
  assert.equal(outcome.detail.durationMs, 40);
});

test("failure outcome preserves bounded diagnostics without persisting secrets", async () => {
  const fixture = await activeFixture({ action: "allow" });
  assert.equal(await fixture.runtime.beforeToolCall(execEvent(), execContext()), undefined);
  const privateKey = "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----";
  const diagnostic = [
    "ordinary execution failure at step 7",
    "token=token-value",
    "Cookie: cookie-value",
    "Bearer bearer-value",
    privateKey,
    "credential-secret",
    "evidence-credential-secret",
    "界".repeat(8_000),
  ].join(" ");

  fixture.runtime.afterToolCall(
    { ...execEvent(), error: diagnostic, durationMs: 9 },
    execContext(),
  );
  await waitFor(() => fixture.events.some(({ type }) => type === "tool_outcome"));

  const outcome = fixture.events.find(({ type }) => type === "tool_outcome")!;
  const error = String(outcome.detail.error);
  assert.match(error, /ordinary execution failure at step 7/);
  for (const secret of [
    "token-value",
    "cookie-value",
    "bearer-value",
    "private-material",
    "credential-secret",
    "evidence-credential-secret",
  ]) assert.equal(error.includes(secret), false);
  assert.ok(Buffer.byteLength(error, "utf8") <= 4 * 1024);
  assert.equal(error.includes("\uFFFD"), false);
  assert.equal(outcome.detail.errorCode, "TOOL_EXECUTION_FAILED");
});

test("the plugin client accepts every lowercase reason code signed by NativeToolDecisionService", async () => {
  const scenarios: Array<{
    defaultAction: SupervisionAction;
    policyAction?: SupervisionAction;
    expectedAction: NativeGuardAction;
    expectedReasonCode: string;
  }> = [
    { defaultAction: "allow", expectedAction: "allow", expectedReasonCode: "default_allow" },
    { defaultAction: "warn", expectedAction: "warn", expectedReasonCode: "default_warn" },
    { defaultAction: "deny", expectedAction: "deny", expectedReasonCode: "default_deny" },
    { defaultAction: "ask", expectedAction: "ask", expectedReasonCode: "default_ask" },
    { defaultAction: "isolate", expectedAction: "deny", expectedReasonCode: "default_isolate_deny" },
    ...(["allow", "warn", "deny", "ask", "redact", "isolate"] as const).map((policyAction) => ({
      defaultAction: "deny" as const,
      policyAction,
      expectedAction: policyAction === "isolate" ? "deny" as const : policyAction,
      expectedReasonCode: policyAction === "isolate" ? "policy_isolate_deny" : `policy_${policyAction}`,
    })),
  ];
  for (const scenario of scenarios) {
    const policyPack = servicePolicyPack(scenario.defaultAction, scenario.policyAction);
    const leaseService = createNativeGuardLeaseService({ now: () => Date.parse(NOW) });
    const activation = leaseService.create({
      rootSessionKey: "agent:main",
      mode: "supervision",
      policyPack,
      policyPackDigest: digestJson(policyPack),
      backendUrl: "http://127.0.0.1:3100/api/v1/openclaw/native-guard/decision",
    }).activation;
    let id = 0;
    const service = createNativeToolDecisionService({
      leaseService,
      eventStore: { async append() { return true; } },
      now: () => NOW,
      createId: (prefix) => `${prefix}.${++id}`,
    });
    const params = { body: "public" };
    const request: NativeToolDecisionRequest = {
      schemaVersion: "native-guard-1",
      requestId: `request.${scenario.expectedReasonCode}`,
      leaseId: activation.leaseId,
      leaseEpoch: activation.leaseEpoch,
      sessionKey: activation.rootSessionKey,
      toolCallId: `call.${scenario.expectedReasonCode}`,
      toolName: "web_fetch",
      params,
      paramsDigest: digestJson(params),
      requestedAt: NOW,
    };
    const signed = (await service.decide(request, activation.credential)).response;
    const client = createDecisionClient({
      now: () => new Date(NOW),
      fetch: async () => jsonResponse(JSON.stringify({
        ok: true,
        data: signed,
        requestId: `api.${scenario.expectedReasonCode}`,
      })),
    });

    const accepted = await client.decide({
      lease: { ...activation, state: "active", childSessionKeys: [] },
      request,
      signal: new AbortController().signal,
    });

    assert.equal(accepted.action, scenario.expectedAction);
    assert.equal(accepted.reasonCode, scenario.expectedReasonCode);
  }
});

test("the plugin client rejects uppercase signed PDP reason codes", async () => {
  const fixture = await activeFixture({ action: "allow", reasonCode: "POLICY_ALLOW" });

  assert.deepEqual(await fixture.runtime.beforeToolCall(execEvent(), execContext()), DENY_OUTAGE);
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
    transformDecision: (decision) => ({ ...decision, reasonCode: ["policy_allow"] }),
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

test("host tool cancellation immediately aborts a pending PDP fetch and cleans its listener", async () => {
  const host = observedAbortSignal();
  let fetchStarted = false;
  let fetchAborted = false;
  const fixture = await activeFixture({
    action: "allow",
    admissionTimeoutMs: 500,
    decisionTimeoutMs: 200,
    fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      fetchStarted = true;
      init?.signal?.addEventListener("abort", () => {
        fetchAborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    }),
  });
  const pending = fixture.runtime.beforeToolCall(
    execEvent(),
    { ...execContext(), abortSignal: host.signal },
  );
  await waitFor(() => fetchStarted);

  host.abort();

  assert.deepEqual(await pending, HOST_CANCELLED);
  assert.equal(fetchAborted, true);
  assert.deepEqual(host.listenerCounts(), { added: 1, removed: 1 });
  assert.deepEqual(fixture.events, []);
});

test("an already-aborted host tool call never starts a PDP fetch", async () => {
  const host = observedAbortSignal();
  host.abort();
  const fixture = await activeFixture({ action: "allow" });

  const result = await fixture.runtime.beforeToolCall(
    execEvent(),
    { ...execContext(), abortSignal: host.signal },
  );

  assert.deepEqual(result, HOST_CANCELLED);
  assert.equal(fixture.fetchCalls(), 0);
  assert.deepEqual(host.listenerCounts(), { added: 1, removed: 1 });
  assert.deepEqual(fixture.events, []);
});

test("host tool cancellation aborts a pending response body read", async () => {
  const host = observedAbortSignal();
  let bodyStarted = false;
  let bodyCancelled = false;
  const fixture = await activeFixture({
    action: "allow",
    admissionTimeoutMs: 500,
    decisionTimeoutMs: 200,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      start() { bodyStarted = true; },
      cancel() { bodyCancelled = true; },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });
  const pending = fixture.runtime.beforeToolCall(
    execEvent(),
    { ...execContext(), abortSignal: host.signal },
  );
  await waitFor(() => bodyStarted);

  host.abort();

  assert.deepEqual(await pending, HOST_CANCELLED);
  assert.equal(bodyCancelled, true);
  assert.deepEqual(host.listenerCounts(), { added: 1, removed: 1 });
  assert.deepEqual(fixture.events, []);
});

test("a signed allow released after host cancellation cannot pass or emit", async () => {
  const host = observedAbortSignal();
  let release: (() => void) | undefined;
  const fixture = await activeFixture({
    action: "allow",
    admissionTimeoutMs: 500,
    decisionTimeoutMs: 200,
    decisionTransport: async (_request, response) => await new Promise<Response>((resolve) => {
      release = () => resolve(response);
    }),
  });
  const pending = fixture.runtime.beforeToolCall(
    execEvent(),
    { ...execContext(), abortSignal: host.signal },
  );
  await waitFor(() => release !== undefined);

  host.abort();
  release?.();

  assert.deepEqual(await pending, HOST_CANCELLED);
  assert.deepEqual(host.listenerCounts(), { added: 1, removed: 1 });
  assert.deepEqual(fixture.events, []);
});

test("invalid local params fail closed without fabricated decision evidence", async () => {
  const host = observedAbortSignal();
  const fixture = await activeFixture({
    action: "allow",
  });
  const result = await fixture.runtime.beforeToolCall(
    { ...execEvent(), params: paramsAtDepth(MAX_PARAM_DEPTH + 1) },
    { ...execContext(), abortSignal: host.signal },
  );

  assert.deepEqual(result, DENY_OUTAGE);
  assert.deepEqual(host.listenerCounts(), { added: 1, removed: 1 });
  assert.equal(fixture.fetchCalls(), 0);
  assert.deepEqual(fixture.events, []);
});

test("OFF does not subscribe to a host tool cancellation signal", async () => {
  const host = observedAbortSignal();
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore(),
    now: () => new Date(NOW),
  });

  assert.equal(await runtime.beforeToolCall(
    execEvent(),
    { ...execContext(), sessionKey: "agent:ordinary", abortSignal: host.signal },
  ), undefined);
  assert.deepEqual(host.listenerCounts(), { added: 0, removed: 0 });
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

test("durable lifecycle intent blocks even exact low-risk tools across restart", async () => {
  let fetchCalls = 0;
  const runtime = new AgentGuardRuntime({
    markerStore: memoryMarkerStore([{
      leaseId: "lease.1",
      rootSessionKey: "agent:main",
      childSessionKeys: [],
      mode: "supervision",
      policyPackId: "pack.1",
      policyPackDigest: "b".repeat(64),
      expiresAt: "2026-08-02T10:05:00.000Z",
      lifecycleIntent: {
        kind: "bind_child",
        parentSessionKey: "agent:main",
        childSessionKey: "agent:child",
      },
    }]),
    now: () => new Date(NOW),
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("must not fetch while lifecycle is pending");
    },
  });

  assert.deepEqual(await runtime.beforeToolCall(lowRiskEvent(), lowRiskContext()), {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_LIFECYCLE_PENDING] Native guard lifecycle synchronization is pending.",
  });
  assert.equal(fetchCalls, 0);
});

test("backend bind failure persists a blocking intent that replays after restart", async () => {
  const store = memoryMarkerStore();
  const activationWithEvidence = activation({
    evidenceCredential: "evidence-credential",
  } as Partial<NativeGuardLeaseActivation>);
  const first = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    lifecycleClient: {
      async bindChild() { throw new Error("backend bind unavailable"); },
      async endSession() { throw new Error("not used"); },
    },
  } as never);
  first.finalizeRegistrationAttestation(true);
  await first.start();
  await first.activate(activationWithEvidence);

  await assert.rejects(first.bindChild(
    "lease.1",
    "agent:main",
    "agent:child",
  ), /lifecycle|bind/i);
  assert.equal((await first.lookup("agent:main")).state, "lifecycle_pending");
  assert.equal((await first.lookup("agent:child")).state, "lifecycle_pending");
  assert.deepEqual(await first.beforeToolCall(
    { toolName: "session_status", params: {}, toolCallId: "call.pending" },
    { toolName: "session_status", sessionKey: "agent:child", toolCallId: "call.pending" },
  ), {
    block: true,
    blockReason: "[Agent Guard:NATIVE_GUARD_LIFECYCLE_PENDING] Native guard lifecycle synchronization is pending.",
  });
  await first.stop();

  let replayCalls = 0;
  const restarted = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    lifecycleClient: {
      async bindChild() { replayCalls += 1; },
      async endSession() { throw new Error("not used"); },
    },
  } as never);
  restarted.finalizeRegistrationAttestation(true);
  await restarted.start();
  assert.equal((await restarted.lookup("agent:main")).state, "lifecycle_pending");
  await restarted.activate(activationWithEvidence);
  assert.equal(replayCalls, 1);
  assert.equal((await restarted.lookup("agent:child")).state, "active");
  await restarted.stop();
});

test("backend end failure leaves the whole lease lifecycle-pending instead of active or OFF", async () => {
  const store = memoryMarkerStore();
  let failEnd = true;
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    lifecycleClient: {
      async bindChild() { return; },
      async endSession() {
        if (failEnd) throw new Error("backend end unavailable");
      },
    },
  } as never);
  runtime.finalizeRegistrationAttestation(true);
  await runtime.start();
  await runtime.activate(activation({
    evidenceCredential: "evidence-credential",
  } as Partial<NativeGuardLeaseActivation>));
  await runtime.bindChild("lease.1", "agent:main", "agent:child");

  await assert.rejects(runtime.endSession("agent:child"), /lifecycle|end/i);
  assert.equal((await runtime.lookup("agent:main")).state, "lifecycle_pending");
  assert.equal((await runtime.lookup("agent:child")).state, "lifecycle_pending");
  failEnd = false;
  assert.equal(await runtime.endSession("agent:child"), true);
  assert.equal((await runtime.lookup("agent:main")).state, "active");
  assert.deepEqual(await runtime.lookup("agent:child"), { state: "off" });
  await runtime.stop();
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
    evidenceCredential: "rotated-evidence-credential",
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
  decisionTransport?: (
    request: NativeToolDecisionRequest,
    response: Response,
    init: RequestInit | undefined,
  ) => Promise<Response>;
  emitEvent?: (event: NativeGuardEvent) => Promise<void> | void;
  lifecycleClient?: LifecycleClient;
  monotonicNow?: () => number;
  maxOutcomeCorrelations?: number;
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
    const response = signedResponse(request);
    return options.decisionTransport?.(request, response, init) ?? response;
  });
  const runtime = new AgentGuardRuntime({
    markerStore: store,
    now: () => new Date(NOW),
    admissionTimeoutMs: options.admissionTimeoutMs,
    ...(options.useDefaultFetch ? {} : { fetch: configuredFetch }),
    decisionTimeoutMs: options.decisionTimeoutMs,
    maxDecisionIdsPerLease: options.maxDecisionIdsPerLease,
    approvalLeaseRecheckAttested: options.approvalLeaseRecheckAttested ?? true,
    emitEvent: options.emitEvent ?? (async (event) => { events.push(structuredClone(event)); }),
    lifecycleClient: options.lifecycleClient,
    monotonicNow: options.monotonicNow,
    maxOutcomeCorrelations: options.maxOutcomeCorrelations,
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

function successfulLifecycleClient(): LifecycleClient {
  return {
    async bindChild() { return; },
    async endSession() { return; },
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
    reasonCode: options.reasonCode ?? `policy_${options.action}`,
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
    evidenceCredential: "evidence-credential-secret",
    ...overrides,
  };
}

function lifecycleLease(): ActiveLeaseLookup {
  return Object.freeze({
    ...activation(),
    state: "active" as const,
    childSessionKeys: Object.freeze([] as string[]),
  });
}

function servicePolicyPack(
  defaultAction: SupervisionAction,
  policyAction?: SupervisionAction,
): SupervisionPolicyPack {
  return {
    schemaVersion: "mvp-1",
    policyPackId: `policy_pack.${defaultAction}`,
    agentId: "agent.native",
    sourceDetectionReportId: "detection.native",
    sourceRiskProfileId: "risk.native",
    policies: policyAction === undefined ? [] : [servicePolicy(policyAction)],
    defaultAction,
    createdAt: "2026-08-02T09:00:00.000Z",
    expiresAt: "2026-08-02T11:00:00.000Z",
  };
}

function servicePolicy(action: SupervisionAction): SupervisionPolicy {
  return {
    policyId: `policy.${action}`,
    sourceWeaknessIds: ["weakness.native"],
    name: `${action} policy`,
    description: "Native decision contract fixture.",
    targetType: "api_call",
    action,
    riskLevel: "high",
    match: {
      relation: "all",
      matchers: [{
        fieldPath: action === "redact" ? "payload.parameters.body" : "payload.toolName",
        operator: "contains",
        value: action === "redact" ? "public" : "web_fetch",
      }],
    },
    reason: `${action} by policy.`,
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

function execContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    toolName: "exec",
    sessionKey: "agent:main",
    toolCallId: "call.1",
    ...overrides,
  };
}

function lowRiskEvent(): ToolEvent {
  return { toolName: "session_status", params: {}, toolCallId: "call.low" };
}

function lowRiskContext() {
  return { toolName: "session_status", sessionKey: "agent:main", toolCallId: "call.low" };
}

function paramsAtCanonicalBytes(bytes: number): { body: string } {
  const overhead = Buffer.byteLength(canonicalJson({ body: "" }), "utf8");
  assert.ok(bytes >= overhead);
  const params = { body: "x".repeat(bytes - overhead) };
  assert.equal(Buffer.byteLength(canonicalJson(params), "utf8"), bytes);
  return params;
}

function paramsWithKeys(count: number): Record<string, unknown> {
  return Object.fromEntries(Array.from({ length: count }, (_value, index) => [`key${index}`, index]));
}

function paramsAtDepth(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = {};
  for (let index = 0; index < depth; index += 1) value = { nested: value };
  return value;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let count = 0; count < 100; count += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observedAbortSignal(): {
  signal: AbortSignal;
  abort(): void;
  listenerCounts(): { added: number; removed: number };
} {
  const controller = new AbortController();
  let added = 0;
  let removed = 0;
  const signal = {
    get aborted() { return controller.signal.aborted; },
    get reason() { return controller.signal.reason; },
    addEventListener(...args: Parameters<AbortSignal["addEventListener"]>) {
      added += 1;
      controller.signal.addEventListener(...args);
    },
    removeEventListener(...args: Parameters<AbortSignal["removeEventListener"]>) {
      removed += 1;
      controller.signal.removeEventListener(...args);
    },
    throwIfAborted() { controller.signal.throwIfAborted(); },
  } as AbortSignal;
  return {
    signal,
    abort: () => controller.abort(),
    listenerCounts: () => ({ added, removed }),
  };
}
