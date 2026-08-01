import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import test from "node:test";
import type {
  NativeGuardEvent,
  NativeGuardLeaseActivation,
  NativeToolDecisionRequest,
  RuntimeSupervisionRecord,
  SupervisionAction,
  SupervisionPolicy,
  SupervisionPolicyPack,
} from "@agent-guard/contracts";
import {
  digestJson,
  verifyNativeGuardPayload,
} from "@agent-guard/native-guard-protocol";
import { createNativeGuardLeaseService } from "./nativeGuardLeaseService";
import {
  createNativeToolDecisionService,
  NativeToolDecisionError,
  normalizeNativeToolAction,
} from "./nativeToolDecisionService";

const LEASE_NOW_MS = Date.parse("2026-08-01T00:00:00.000Z");
const DECISION_NOW = "2026-08-01T00:00:01.000Z";

test("redacts a nested matched parameter, signs the response, and records evidence", async () => {
  const fixture = createFixture({
    policies: [
      buildPolicy("redact", "payload.parameters.request.body", "secret"),
    ],
  });
  const request = fixture.request({
    params: { request: { body: "token=secret" } },
  });

  const result = await fixture.service.decide(request, fixture.credential);

  assert.equal(result.response.action, "redact");
  assert.deepEqual(result.response.rewrittenParams, {
    request: { body: "[REDACTED]" },
  });
  assert.equal(
    result.response.rewrittenParamsDigest,
    digestJson(result.response.rewrittenParams),
  );
  assert.equal(result.response.evaluatedParamsDigest, request.paramsDigest);
  assert.equal(result.record.inputEventId, "req.1");
  assert.equal(result.record.policyId, "policy.redact");
  const { signature, ...signedPayload } = result.response;
  assert.equal(
    verifyNativeGuardPayload(
      signedPayload,
      signature,
      createPublicKey(fixture.activation.decisionPublicKey),
    ),
    true,
  );
  assert.equal(fixture.appended.length, 1);
  assert.equal(JSON.stringify(fixture.appended).includes("token=secret"), false);
  assert.equal(JSON.stringify(fixture.appended).includes(fixture.credential), false);
});

test("uses deny, ask, redact, warn, allow priority and maps isolate to deny", async () => {
  for (const scenario of [
    { actions: ["redact", "ask", "deny"], expected: "deny" },
    { actions: ["redact", "ask"], expected: "ask" },
    { actions: ["warn", "redact"], expected: "redact" },
    { actions: ["allow", "warn"], expected: "warn" },
    { actions: ["allow"], expected: "allow" },
    { actions: ["isolate"], expected: "deny" },
  ] as const) {
    const fixture = createFixture({
      policies: scenario.actions.map((action, index) =>
        buildPolicy(
          action,
          action === "redact"
            ? "payload.parameters.request.body"
            : "payload.toolName",
          action === "redact" ? "public" : "web_fetch",
          index,
        ),
      ),
    });
    const result = await fixture.service.decide(
      fixture.request(),
      fixture.credential,
    );
    assert.equal(result.response.action, scenario.expected);
    assert.equal(result.record.action, scenario.expected);
    if (scenario.expected !== "redact") {
      assert.equal(result.response.rewrittenParams, undefined);
      assert.equal(result.response.rewrittenParamsDigest, undefined);
    }
  }
});

test("uses the default action when no policy matches", async () => {
  const fixture = createFixture({
    defaultAction: "allow",
    policies: [buildPolicy("deny", "payload.toolName", "other")],
  });
  const result = await fixture.service.decide(
    fixture.request(),
    fixture.credential,
  );
  assert.equal(result.response.action, "allow");
  assert.equal(result.response.reasonCode, "default_allow");
  assert.equal(result.record.policyId, "policy_pack.native.default");
});

test("normalizes trusted metadata without reserved-name bypasses or LLM use", () => {
  assert.equal(normalizeNativeToolAction({ toolName: "exec" }).targetType, "code_execution");
  assert.equal(normalizeNativeToolAction({ toolName: "agw__process" }).targetType, "code_execution");
  assert.equal(normalizeNativeToolAction({ toolKind: "write" }).targetType, "file_write");
  assert.equal(normalizeNativeToolAction({ toolInputKind: "apply_patch" }).targetType, "file_write");
  assert.equal(normalizeNativeToolAction({ providerId: "browser" }).targetType, "api_call");
  assert.equal(normalizeNativeToolAction({ toolName: "agent_guard__network" }).targetType, "api_call");
  const unknown = normalizeNativeToolAction({ toolName: "mystery" });
  assert.equal(unknown.targetType, "tool_call");
  assert.deepEqual(unknown.riskTags, ["unknown_side_effect"]);
  assert.equal(unknown.llmAssisted, false);
});

test("rejects authentication, binding, epoch, digest, schema, id, and time failures safely", async () => {
  const fixture = createFixture();
  const cases: Array<[string, NativeToolDecisionRequest, string]> = [
    ["wrong credential", fixture.request(), "wrong-secret"],
    ["wrong epoch", fixture.request({ leaseEpoch: 99 }), fixture.credential],
    ["wrong session", fixture.request({ sessionKey: "session.other" }), fixture.credential],
    ["wrong digest", fixture.request({ paramsDigest: "f".repeat(64) }), fixture.credential],
    ["wrong schema", fixture.request({ schemaVersion: "bad" as never }), fixture.credential],
    ["empty id", fixture.request({ toolCallId: " " }), fixture.credential],
    ["stale time", fixture.request({ requestedAt: "2026-07-31T23:59:00.000Z" }), fixture.credential],
    ["future time", fixture.request({ requestedAt: "2026-08-01T00:01:00.000Z" }), fixture.credential],
    ["noncanonical time", fixture.request({ requestedAt: "2026-08-01T00:00:01Z" }), fixture.credential],
  ];
  for (const [label, request, credential] of cases) {
    await assert.rejects(
      fixture.service.decide(request, credential),
      (error: unknown) => {
        assert.ok(error instanceof NativeToolDecisionError, label);
        const serialized = JSON.stringify({ message: error.message, code: error.code });
        assert.equal(serialized.includes(credential), false, label);
        assert.equal(serialized.includes(JSON.stringify(request.params)), false, label);
        return true;
      },
    );
  }

  assert.equal(
    fixture.leaseService.bindChild(
      fixture.activation.leaseId,
      fixture.activation.rootSessionKey,
      "session.child",
    ),
    true,
  );
  const child = await fixture.service.decide(
    fixture.request({ requestId: "req.child", toolCallId: "call.child", sessionKey: "session.child" }),
    fixture.credential,
  );
  assert.equal(child.record.runtimeSessionId, "session.child");
});

test("rejects noncanonical parameter structures", async () => {
  const fixture = createFixture();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const request = fixture.request();
  request.params = cyclic;
  request.paramsDigest = "a".repeat(64);
  await assert.rejects(
    fixture.service.decide(request, fixture.credential),
    hasCode("NATIVE_GUARD_INVALID_REQUEST"),
  );

  const invalidIdentity = fixture.request({
    requestId: "req.invalid-identity",
    toolCallId: "call.invalid-identity",
    derivedPaths: [undefined as never],
  });
  await assert.rejects(
    fixture.service.decide(invalidIdentity, fixture.credential),
    hasCode("NATIVE_GUARD_INVALID_REQUEST"),
  );
});

test("replays identical requests once and rejects request/tool-call identity conflicts", async () => {
  const fixture = createFixture();
  const request = fixture.request();
  const first = await fixture.service.decide(request, fixture.credential);
  const replay = await fixture.service.decide(structuredClone(request), fixture.credential);
  assert.deepEqual(replay, first);
  assert.equal(fixture.appended.length, 1);

  await assert.rejects(
    fixture.service.decide(
      { ...request, toolName: "different" },
      fixture.credential,
    ),
    hasCode("NATIVE_GUARD_REPLAY_CONFLICT"),
  );
  await assert.rejects(
    fixture.service.decide(
      { ...request, requestId: "req.2" },
      fixture.credential,
    ),
    hasCode("NATIVE_GUARD_TOOL_CALL_REPLAY"),
  );
});

test("invalidates old replay entries after renewal and fails closed at the cache bound", async () => {
  const fixture = createFixture({ maxRequestsPerLease: 1 });
  await fixture.service.decide(fixture.request(), fixture.credential);
  await assert.rejects(
    fixture.service.decide(
      fixture.request({ requestId: "req.2", toolCallId: "call.2" }),
      fixture.credential,
    ),
    hasCode("NATIVE_GUARD_CACHE_LIMIT"),
  );

  const renewed = fixture.leaseService.renew(fixture.activation.leaseId);
  await assert.rejects(
    fixture.service.decide(fixture.request(), fixture.credential),
    hasCode("NATIVE_GUARD_AUTHENTICATION_FAILED"),
  );
  const renewedResult = await fixture.service.decide(
    fixture.request({ leaseEpoch: renewed.leaseEpoch }),
    renewed.credential,
  );
  assert.equal(renewedResult.response.leaseEpoch, renewed.leaseEpoch);
});

test("merges multiple nested redactions and fails closed for unsafe or ineffective paths", async () => {
  const fixture = createFixture({
    policies: [
      buildPolicy("redact", "payload.parameters.request.body", "secret", 1),
      buildPolicy("redact", "payload.parameters.headers.authorization", "Bearer", 2),
    ],
  });
  const result = await fixture.service.decide(
    fixture.request({
      params: {
        request: { body: "secret" },
        headers: { authorization: "Bearer abc", keep: "yes" },
      },
    }),
    fixture.credential,
  );
  assert.deepEqual(result.response.rewrittenParams, {
    request: { body: "[REDACTED]" },
    headers: { authorization: "[REDACTED]", keep: "yes" },
  });

  for (const scenario of [
    {
      fieldPath: "payload.parameters.__proto__.value",
      params: JSON.parse('{"__proto__":{"value":"unsafe"}}') as Record<string, unknown>,
    },
    {
      fieldPath: "payload.parameters.request",
      params: { request: { body: "not-a-string-target" } },
    },
    {
      fieldPath: "payload.parameters.request.body",
      params: { request: { body: "[REDACTED]" } },
    },
  ]) {
    const unsafe = createFixture({
      policies: [buildPolicy("redact", scenario.fieldPath, undefined)],
    });
    await assert.rejects(
      unsafe.service.decide(
        unsafe.request({ params: scenario.params }),
        unsafe.credential,
      ),
      hasCode("NATIVE_GUARD_REDACTION_FAILED"),
    );
  }
});

test("maps matched api_call payload data redaction back to the original body", async () => {
  const policy = {
    ...buildPolicy("redact", "payload.data", "secret"),
    targetType: "api_call" as const,
  };
  const fixture = createFixture({ policies: [policy] });
  const result = await fixture.service.decide(
    fixture.request({
      toolName: "network",
      toolKind: "network",
      params: {
        method: "POST",
        url: "https://example.test/submit",
        body: "token=secret",
      },
    }),
    fixture.credential,
  );

  assert.equal(result.response.action, "redact");
  assert.deepEqual(result.response.rewrittenParams, {
    method: "POST",
    url: "https://example.test/submit",
    body: "[REDACTED]",
  });
  assert.equal(result.record.targetType, "api_call");
});

test("fails with lease-changed when renewal or revocation wins before signing", async () => {
  for (const race of ["renew", "revoke"] as const) {
    let fixture: ReturnType<typeof createFixture>;
    fixture = createFixture({
      beforeSign: async () => {
        if (race === "renew") {
          fixture.leaseService.renew(fixture.activation.leaseId);
        } else {
          fixture.leaseService.revoke(fixture.activation.leaseId);
        }
      },
    });
    await assert.rejects(
      fixture.service.decide(fixture.request(), fixture.credential),
      hasCode("NATIVE_GUARD_LEASE_CHANGED"),
    );
    assert.equal(fixture.appended.length, 0);
  }
});

type FixtureOptions = {
  policies?: SupervisionPolicy[];
  defaultAction?: SupervisionAction;
  maxRequestsPerLease?: number;
  beforeSign?: () => Promise<void>;
};

function createFixture(options: FixtureOptions = {}) {
  const policyPack = buildPolicyPack(options);
  const leaseService = createNativeGuardLeaseService({ now: () => LEASE_NOW_MS });
  const activation = leaseService.create({
    rootSessionKey: "session.root",
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: "http://127.0.0.1:4310",
  }).activation;
  const appended: Array<{
    event: NativeGuardEvent;
    record?: RuntimeSupervisionRecord;
  }> = [];
  let id = 0;
  const service = createNativeToolDecisionService({
    leaseService,
    eventStore: {
      async append(event, record) {
        appended.push({ event, record });
        return true;
      },
    },
    now: () => DECISION_NOW,
    createId: (prefix) => `${prefix}.${++id}`,
    maxRequestsPerLease: options.maxRequestsPerLease,
    beforeSign: options.beforeSign,
  });

  return {
    activation,
    credential: activation.credential,
    leaseService,
    appended,
    service,
    request(overrides: Partial<NativeToolDecisionRequest> & { params?: Record<string, unknown> } = {}) {
      const params = overrides.params ?? { request: { body: "public" } };
      return {
        schemaVersion: "native-guard-1",
        requestId: "req.1",
        leaseId: activation.leaseId,
        leaseEpoch: activation.leaseEpoch,
        sessionKey: "session.root",
        runId: "run.1",
        toolCallId: "call.1",
        toolName: "web_fetch",
        toolKind: "tool",
        toolInputKind: "json",
        providerId: "openclaw",
        params,
        paramsDigest: digestJson(params),
        requestedAt: "2026-08-01T00:00:00.500Z",
        ...overrides,
      } satisfies NativeToolDecisionRequest;
    },
  };
}

function buildPolicyPack(options: FixtureOptions): SupervisionPolicyPack {
  return {
    schemaVersion: "mvp-1",
    policyPackId: "policy_pack.native",
    agentId: "agent.native",
    sourceDetectionReportId: "detection.native",
    sourceRiskProfileId: "risk.native",
    policies: options.policies ?? [buildPolicy("allow", "payload.toolName", "web_fetch")],
    defaultAction: options.defaultAction ?? "allow",
    createdAt: "2026-07-31T00:00:00.000Z",
    expiresAt: "2026-08-02T00:00:00.000Z",
  };
}

function buildPolicy(
  action: SupervisionAction,
  fieldPath: string,
  value: string | undefined,
  suffix?: number,
): SupervisionPolicy {
  return {
    policyId: `policy.${action}${suffix ?? ""}`,
    sourceWeaknessIds: ["weakness.native"],
    name: `${action} policy`,
    description: "Native decision fixture.",
    targetType: "tool_call",
    action,
    riskLevel: "high",
    match: {
      relation: "all",
      matchers: [{
        fieldPath,
        operator: value === undefined ? "exists" : "contains",
        ...(value === undefined ? {} : { value }),
      }],
    },
    reason: `${action} by policy.`,
  };
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof NativeToolDecisionError && error.code === code;
}
