import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { createNativeGuardEventStore } from "../../storage/nativeGuardEventStore";
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

test("matches stored tool-profile policies against a canonical native tool id", async () => {
  const fixture = createFixture({
    policies: [{
      ...buildPolicy("deny", "targetId", "tool.execute_code"),
      targetType: "code_execution",
      match: {
        relation: "all",
        matchers: [{
          fieldPath: "targetId",
          operator: "equals",
          value: "tool.execute_code",
        }],
      },
    }],
  });

  const result = await fixture.service.decide(
    fixture.request({
      toolCallId: "call.random-runtime-id",
      toolName: "exec",
      params: { command: "echo guarded" },
    }),
    fixture.credential,
  );

  assert.equal(result.response.action, "deny");
  assert.equal(result.record.policyId, "policy.deny");
});

test("rejects bounded parameter violations before policy persistence or signing", async (t) => {
  for (const [name, params] of [
    ["bytes", paramsAtCanonicalBytes(256 * 1024 + 1)],
    ["depth", paramsAtDepth(33)],
    ["keys", { nested: paramsWithKeys(4_096) }],
    ["prototype", JSON.parse('{"safe":true,"__proto__":{"polluted":true}}')],
  ] as const) {
    await t.test(name, async () => {
      let beforeSignCalls = 0;
      const fixture = createFixture({
        beforeSign: async () => { beforeSignCalls += 1; },
      });

      await assert.rejects(
        () => fixture.service.decide(fixture.request({ params }), fixture.credential),
        hasCode("NATIVE_GUARD_INVALID_REQUEST"),
      );
      assert.equal(beforeSignCalls, 0);
      assert.equal(fixture.appended.length, 0);
    });
  }
});

test("accepts exact parameter bounds in the real decision service", async () => {
  for (const params of [
    paramsAtCanonicalBytes(256 * 1024),
    paramsWithKeys(4_096),
    paramsAtDepth(32),
  ]) {
    const fixture = createFixture({ defaultAction: "allow", policies: [] });
    const result = await fixture.service.decide(
      fixture.request({ params }),
      fixture.credential,
    );
    assert.equal(result.response.action, "allow");
  }
});

test("rejects an oversized rewritten parameter object before signing", async () => {
  let beforeSignCalls = 0;
  const fixture = createFixture({
    policies: [buildPolicy("redact", "payload.parameters.body", "secret")],
    beforeSign: async () => { beforeSignCalls += 1; },
  });
  const params = paramsAtCanonicalBytesWithFields(
    { body: "secret", padding: "" },
    "padding",
    256 * 1024,
  );

  await assert.rejects(
    () => fixture.service.decide(fixture.request({ params }), fixture.credential),
    hasCode("NATIVE_GUARD_INVALID_REQUEST"),
  );
  assert.equal(beforeSignCalls, 0);
  assert.equal(fixture.appended.length, 0);
});

test("normalizes trusted metadata without reserved-name bypasses or LLM use", () => {
  for (const toolName of [
    "exec",
    "process",
    "shell",
    "bash",
    "run_command",
    "powershell",
    "cmd",
    "execute_command",
    "agent_guard__shell",
  ]) {
    assert.equal(normalizeNativeToolAction({ toolName }).targetType, "code_execution", toolName);
  }
  for (const toolName of [
    "write_file",
    "edit_file",
    "apply_patch",
    "create_file",
    "patch",
    "agw__write_file",
  ]) {
    assert.equal(normalizeNativeToolAction({ toolName }).targetType, "file_write", toolName);
  }
  for (const toolName of [
    "web_fetch",
    "web_search",
    "http_request",
    "fetch",
    "curl",
    "browser",
    "browser_navigate",
    "network",
    "agw__web_fetch",
  ]) {
    assert.equal(normalizeNativeToolAction({ toolName }).targetType, "api_call", toolName);
  }
  assert.equal(normalizeNativeToolAction({ toolName: "custom", toolKind: "shell" }).targetType, "code_execution");
  assert.equal(
    normalizeNativeToolAction({
      toolName: "custom",
      toolKind: "code_mode_exec",
      toolInputKind: "typescript",
    }).targetType,
    "code_execution",
  );
  assert.equal(normalizeNativeToolAction({ toolName: "custom", toolInputKind: "apply_patch" }).targetType, "file_write");
  assert.equal(normalizeNativeToolAction({ toolName: "custom", providerId: "browser" }).targetType, "tool_call");
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

test("retries the same signed envelope after an ambiguous append failure", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-decision-"));
  try {
    const delegate = createNativeGuardEventStore({ rootDir });
    const attempts: Array<{
      event: NativeGuardEvent;
      record?: RuntimeSupervisionRecord;
    }> = [];
    let throwAfterWrite = true;
    const fixture = createFixture({
      eventStore: {
        async append(event, record) {
          attempts.push(structuredClone({ event, record }));
          const appended = await delegate.append(event, record);
          if (throwAfterWrite) {
            throwAfterWrite = false;
            throw new Error("ambiguous append result");
          }
          return appended;
        },
      },
    });
    const request = fixture.request();

    await assert.rejects(
      fixture.service.decide(request, fixture.credential),
      /ambiguous append result/,
    );
    const result = await fixture.service.decide(request, fixture.credential);

    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0]);
    assert.equal(result.response.decisionId, attempts[0].event.decisionId);
    assert.deepEqual(await delegate.listByRun("run.1"), [attempts[0].event]);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("keeps an ambiguous old-epoch request tombstoned after renewal", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-decision-"));
  try {
    const delegate = createNativeGuardEventStore({ rootDir });
    let throwAfterWrite = true;
    const fixture = createFixture({
      eventStore: {
        async append(event, record) {
          const appended = await delegate.append(event, record);
          if (throwAfterWrite) {
            throwAfterWrite = false;
            throw new Error("ambiguous append result");
          }
          return appended;
        },
      },
    });
    await assert.rejects(
      fixture.service.decide(fixture.request(), fixture.credential),
      /ambiguous append result/,
    );
    const renewed = fixture.leaseService.renew(fixture.activation.leaseId);
    await assert.rejects(
      fixture.service.decide(
        fixture.request({ leaseEpoch: renewed.leaseEpoch }),
        renewed.credential,
      ),
      hasCode("NATIVE_GUARD_REPLAY_CONFLICT"),
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("never treats a first-attempt false append as persisted success", async () => {
  let appendCalls = 0;
  const fixture = createFixture({
    eventStore: {
      async append() {
        appendCalls += 1;
        return false;
      },
    },
  });
  const request = fixture.request();
  await assert.rejects(
    fixture.service.decide(request, fixture.credential),
    hasCode("NATIVE_GUARD_EVENT_CONFLICT"),
  );
  await assert.rejects(
    fixture.service.decide(request, fixture.credential),
    hasCode("NATIVE_GUARD_REPLAY_CONFLICT"),
  );
  assert.equal(appendCalls, 1);
});

test("fails closed when the global pending decision count is exhausted", async () => {
  const fixture = createFixture({
    maxPendingDecisions: 1,
    eventStore: {
      async append() {
        throw new Error("ambiguous pending write");
      },
    },
  });
  await assert.rejects(
    fixture.service.decide(fixture.request(), fixture.credential),
    /ambiguous pending write/,
  );
  const policyPack = buildPolicyPack({});
  const second = fixture.leaseService.create({
    rootSessionKey: "session.pending-second",
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: "http://127.0.0.1:4310",
  }).activation;
  const request = fixture.request({
    requestId: "req.pending-second",
    leaseId: second.leaseId,
    leaseEpoch: second.leaseEpoch,
    sessionKey: second.rootSessionKey,
    toolCallId: "call.pending-second",
    params: { body: "payload-secret-value" },
  });
  await assert.rejects(
    fixture.service.decide(request, second.credential),
    (error: unknown) => {
      assert.ok(error instanceof NativeToolDecisionError);
      assert.equal(error.code, "NATIVE_GUARD_PENDING_LIMIT");
      assert.equal(JSON.stringify(error).includes("payload-secret-value"), false);
      return true;
    },
  );
});

test("fails closed before append when one pending envelope exceeds the byte limit", async () => {
  let appendCalls = 0;
  const fixture = createFixture({
    maxPendingBytes: 1,
    eventStore: {
      async append() {
        appendCalls += 1;
        return true;
      },
    },
  });
  await assert.rejects(
    fixture.service.decide(
      fixture.request({ params: { body: "oversized-payload-secret" } }),
      fixture.credential,
    ),
    hasCode("NATIVE_GUARD_PENDING_LIMIT"),
  );
  assert.equal(appendCalls, 0);
});

test("clears ambiguous pending state after renewal while keeping old ids tombstoned", async () => {
  let appendCalls = 0;
  const fixture = createFixture({
    maxPendingDecisions: 1,
    eventStore: {
      async append() {
        appendCalls += 1;
        if (appendCalls === 1) throw new Error("ambiguous pending write");
        return true;
      },
    },
  });
  await assert.rejects(
    fixture.service.decide(fixture.request(), fixture.credential),
    /ambiguous pending write/,
  );
  const renewed = fixture.leaseService.renew(fixture.activation.leaseId);
  const result = await fixture.service.decide(
    fixture.request({
      requestId: "req.after-pending-renew",
      toolCallId: "call.after-pending-renew",
      leaseEpoch: renewed.leaseEpoch,
    }),
    renewed.credential,
  );
  assert.equal(result.response.leaseEpoch, renewed.leaseEpoch);
  await assert.rejects(
    fixture.service.decide(
      fixture.request({ leaseEpoch: renewed.leaseEpoch }),
      renewed.credential,
    ),
    hasCode("NATIVE_GUARD_REPLAY_CONFLICT"),
  );
});

test("clears revoked and expired pending state before authenticating another lease", async () => {
  for (const lifecycle of ["revoke", "expire"] as const) {
    let leaseNowMs = LEASE_NOW_MS;
    let decisionNowMs = LEASE_NOW_MS + 500;
    let appendCalls = 0;
    const fixture = createFixture({
      leaseNow: () => leaseNowMs,
      decisionNow: () => new Date(decisionNowMs).toISOString(),
      ttlMs: 1_000,
      maxPendingDecisions: 1,
      eventStore: {
        async append() {
          appendCalls += 1;
          if (appendCalls === 1) throw new Error("ambiguous pending write");
          return true;
        },
      },
    });
    await assert.rejects(
      fixture.service.decide(fixture.request(), fixture.credential),
      /ambiguous pending write/,
    );
    if (lifecycle === "revoke") {
      fixture.leaseService.revoke(fixture.activation.leaseId);
    } else {
      leaseNowMs += 2_000;
      decisionNowMs = leaseNowMs;
    }
    const policyPack = buildPolicyPack({});
    const next = fixture.leaseService.create({
      rootSessionKey: `session.after-${lifecycle}`,
      mode: "supervision",
      policyPack,
      policyPackDigest: digestJson(policyPack),
      backendUrl: "http://127.0.0.1:4310",
    }).activation;
    const result = await fixture.service.decide(
      fixture.request({
        requestId: `req.after-${lifecycle}`,
        leaseId: next.leaseId,
        leaseEpoch: next.leaseEpoch,
        sessionKey: next.rootSessionKey,
        toolCallId: `call.after-${lifecycle}`,
      }),
      next.credential,
    );
    assert.equal(result.response.leaseId, next.leaseId);
  }
});

test("keeps request and tool-call tombstones across lease renewal", async () => {
  const fixture = createFixture({ maxRequestsPerLease: 3 });
  await fixture.service.decide(fixture.request(), fixture.credential);

  const renewed = fixture.leaseService.renew(fixture.activation.leaseId);
  await assert.rejects(
    fixture.service.decide(fixture.request(), fixture.credential),
    hasCode("NATIVE_GUARD_AUTHENTICATION_FAILED"),
  );
  await assert.rejects(
    fixture.service.decide(
      fixture.request({ leaseEpoch: renewed.leaseEpoch }),
      renewed.credential,
    ),
    hasCode("NATIVE_GUARD_REPLAY_CONFLICT"),
  );
  await assert.rejects(
    fixture.service.decide(
      fixture.request({
        requestId: "req.2",
        leaseEpoch: renewed.leaseEpoch,
      }),
      renewed.credential,
    ),
    hasCode("NATIVE_GUARD_TOOL_CALL_REPLAY"),
  );
  const renewedResult = await fixture.service.decide(
    fixture.request({
      requestId: "req.2",
      toolCallId: "call.2",
      leaseEpoch: renewed.leaseEpoch,
    }),
    renewed.credential,
  );
  assert.equal(renewedResult.response.leaseEpoch, renewed.leaseEpoch);
});

test("enforces replay capacity across lease epochs", async () => {
  const fixture = createFixture({ maxRequestsPerLease: 1 });
  await fixture.service.decide(fixture.request(), fixture.credential);
  const renewed = fixture.leaseService.renew(fixture.activation.leaseId);
  await assert.rejects(
    fixture.service.decide(
      fixture.request({
        requestId: "req.after-renew",
        toolCallId: "call.after-renew",
        leaseEpoch: renewed.leaseEpoch,
      }),
      renewed.credential,
    ),
    hasCode("NATIVE_GUARD_CACHE_LIMIT"),
  );
});

test("extends tombstone lifetime to a renewed lease expiry", async () => {
  let leaseNowMs = LEASE_NOW_MS;
  let decisionNowMs = LEASE_NOW_MS + 500;
  const fixture = createFixture({
    leaseNow: () => leaseNowMs,
    decisionNow: () => new Date(decisionNowMs).toISOString(),
    ttlMs: 2_000,
  });
  await fixture.service.decide(fixture.request(), fixture.credential);

  leaseNowMs += 1_000;
  const renewed = fixture.leaseService.renew(fixture.activation.leaseId, 5_000);
  leaseNowMs += 2_000;
  decisionNowMs = leaseNowMs;
  await assert.rejects(
    fixture.service.decide(
      fixture.request({ leaseEpoch: renewed.leaseEpoch }),
      renewed.credential,
    ),
    hasCode("NATIVE_GUARD_REPLAY_CONFLICT"),
  );
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
      expectedCode: "NATIVE_GUARD_INVALID_REQUEST",
    },
    {
      fieldPath: "payload.parameters.request",
      params: { request: { body: "not-a-string-target" } },
      expectedCode: "NATIVE_GUARD_REDACTION_FAILED",
    },
    {
      fieldPath: "payload.parameters.request.body",
      params: { request: { body: "[REDACTED]" } },
      expectedCode: "NATIVE_GUARD_REDACTION_FAILED",
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
      hasCode(scenario.expectedCode),
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

test("redacts the string fallback when the primary api data field is non-string", async () => {
  const policy = {
    ...buildPolicy("redact", "payload.data", "secret"),
    targetType: "api_call" as const,
  };
  const fixture = createFixture({ policies: [policy] });
  const result = await fixture.service.decide(
    fixture.request({
      toolName: "http_request",
      params: {
        method: "POST",
        url: "https://example.test/submit",
        data: null,
        body: "token=secret",
      },
    }),
    fixture.credential,
  );

  assert.deepEqual(result.response.rewrittenParams, {
    method: "POST",
    url: "https://example.test/submit",
    data: null,
    body: "[REDACTED]",
  });
});

test("redacts file and code fallback fields selected by runtime payloads", async () => {
  for (const scenario of [
    {
      toolName: "write_file",
      targetType: "file_write" as const,
      fieldPath: "payload.contentPreview",
      params: { content: null, patch: "replace secret" },
      expected: { content: null, patch: "[REDACTED]" },
    },
    {
      toolName: "execute_command",
      targetType: "code_execution" as const,
      fieldPath: "payload.codePreview",
      params: { code: null, command: "echo secret" },
      expected: { code: null, command: "[REDACTED]" },
    },
  ]) {
    const policy = {
      ...buildPolicy("redact", scenario.fieldPath, "secret"),
      targetType: scenario.targetType,
    };
    const fixture = createFixture({ policies: [policy] });
    const result = await fixture.service.decide(
      fixture.request({ toolName: scenario.toolName, params: scenario.params }),
      fixture.credential,
    );
    assert.deepEqual(result.response.rewrittenParams, scenario.expected);
  }
});

test("redacts only matchers that actually matched in a relation-any policy", async () => {
  const policy = buildPolicy(
    "redact",
    "payload.parameters.request.body",
    "secret",
  );
  policy.match = {
    relation: "any",
    matchers: [
      {
        fieldPath: "payload.parameters.request.body",
        operator: "contains",
        value: "secret",
      },
      {
        fieldPath: "payload.parameters.publicValue",
        operator: "contains",
        value: "secret",
      },
    ],
  };
  const fixture = createFixture({ policies: [policy] });
  const result = await fixture.service.decide(
    fixture.request({
      params: {
        request: { body: "token=secret" },
        publicValue: "keep me",
      },
    }),
    fixture.credential,
  );

  assert.deepEqual(result.response.rewrittenParams, {
    request: { body: "[REDACTED]" },
    publicValue: "keep me",
  });
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

for (const race of ["renew", "revoke"] as const) {
  test(`fails with lease-changed when ${race} wins during event append`, async () => {
    let entered!: () => void;
    let release!: () => void;
    const appendEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const appendBlocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    let appendCalls = 0;
    const fixture = createFixture({
      maxPendingDecisions: 1,
      eventStore: {
        async append() {
          appendCalls += 1;
          if (appendCalls === 1) {
            entered();
            await appendBlocker;
          }
          return true;
        },
      },
    });
    const pendingResult = fixture.service.decide(
      fixture.request(),
      fixture.credential,
    );
    await appendEntered;
    const renewed = race === "renew"
      ? fixture.leaseService.renew(fixture.activation.leaseId)
      : undefined;
    if (race === "revoke") {
      fixture.leaseService.revoke(fixture.activation.leaseId);
    }
    release();

    await assert.rejects(
      pendingResult,
      hasCode("NATIVE_GUARD_LEASE_CHANGED"),
    );

    if (renewed) {
      await assert.rejects(
        fixture.service.decide(
          fixture.request({ leaseEpoch: renewed.leaseEpoch }),
          renewed.credential,
        ),
        hasCode("NATIVE_GUARD_REPLAY_CONFLICT"),
      );
      const next = await fixture.service.decide(
        fixture.request({
          requestId: "req.after-append-renew",
          toolCallId: "call.after-append-renew",
          leaseEpoch: renewed.leaseEpoch,
        }),
        renewed.credential,
      );
      assert.equal(next.response.leaseEpoch, renewed.leaseEpoch);
    } else {
      const policyPack = buildPolicyPack({});
      const nextLease = fixture.leaseService.create({
        rootSessionKey: "session.after-append-revoke",
        mode: "supervision",
        policyPack,
        policyPackDigest: digestJson(policyPack),
        backendUrl: "http://127.0.0.1:4310",
      }).activation;
      const next = await fixture.service.decide(
        fixture.request({
          requestId: "req.after-append-revoke",
          leaseId: nextLease.leaseId,
          leaseEpoch: nextLease.leaseEpoch,
          sessionKey: nextLease.rootSessionKey,
          toolCallId: "call.after-append-revoke",
        }),
        nextLease.credential,
      );
      assert.equal(next.response.leaseId, nextLease.leaseId);
    }
  });
}

test("does not let a slow lease block decisions for another lease", async () => {
  let hookCalls = 0;
  let entered!: () => void;
  let release!: () => void;
  const hookEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createFixture({
    beforeSign: async () => {
      hookCalls += 1;
      if (hookCalls === 1) {
        entered();
        await blocker;
      }
    },
  });
  const policyPack = buildPolicyPack({});
  const second = fixture.leaseService.create({
    rootSessionKey: "session.second",
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: "http://127.0.0.1:4310",
  }).activation;

  const firstPromise = fixture.service.decide(
    fixture.request(),
    fixture.credential,
  );
  await hookEntered;
  const secondPromise = fixture.service.decide(
    fixture.request({
      requestId: "req.second",
      leaseId: second.leaseId,
      leaseEpoch: second.leaseEpoch,
      sessionKey: second.rootSessionKey,
      toolCallId: "call.second",
    }),
    second.credential,
  );
  const secondFinishedFirst = await Promise.race([
    secondPromise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  release();
  await Promise.allSettled([firstPromise, secondPromise]);
  assert.equal(secondFinishedFirst, true);
});

test("singleflights concurrent copies of the same request", async () => {
  let hookCalls = 0;
  let entered!: () => void;
  let release!: () => void;
  const hookEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocker = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createFixture({
    beforeSign: async () => {
      hookCalls += 1;
      entered();
      await blocker;
    },
  });
  const request = fixture.request();
  const first = fixture.service.decide(request, fixture.credential);
  await hookEntered;
  const second = fixture.service.decide(
    structuredClone(request),
    fixture.credential,
  );
  release();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(hookCalls, 1);
  assert.equal(fixture.appended.length, 1);
});

type FixtureOptions = {
  policies?: SupervisionPolicy[];
  defaultAction?: SupervisionAction;
  maxRequestsPerLease?: number;
  beforeSign?: () => Promise<void>;
  eventStore?: {
    append(
      event: NativeGuardEvent,
      record?: RuntimeSupervisionRecord,
    ): Promise<boolean>;
  };
  leaseNow?: () => number;
  decisionNow?: () => string;
  ttlMs?: number;
  maxPendingDecisions?: number;
  maxPendingBytes?: number;
};

function createFixture(options: FixtureOptions = {}) {
  const policyPack = buildPolicyPack(options);
  const leaseService = createNativeGuardLeaseService({
    now: options.leaseNow ?? (() => LEASE_NOW_MS),
  });
  const activation = leaseService.create({
    rootSessionKey: "session.root",
    mode: "supervision",
    policyPack,
    policyPackDigest: digestJson(policyPack),
    backendUrl: "http://127.0.0.1:4310",
    ttlMs: options.ttlMs,
  }).activation;
  const appended: Array<{
    event: NativeGuardEvent;
    record?: RuntimeSupervisionRecord;
  }> = [];
  let id = 0;
  const service = createNativeToolDecisionService({
    leaseService,
    eventStore: options.eventStore ?? {
      async append(event, record) {
        appended.push({ event, record });
        return true;
      },
    },
    now: options.decisionNow ?? (() => DECISION_NOW),
    createId: (prefix) => `${prefix}.${++id}`,
    maxRequestsPerLease: options.maxRequestsPerLease,
    maxPendingDecisions: options.maxPendingDecisions,
    maxPendingBytes: options.maxPendingBytes,
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
    targetType: "api_call",
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

function paramsAtCanonicalBytes(bytes: number): Record<string, unknown> {
  return paramsAtCanonicalBytesWithFields({ body: "" }, "body", bytes);
}

function paramsAtCanonicalBytesWithFields<T extends Record<string, unknown>>(
  params: T,
  paddingKey: keyof T,
  bytes: number,
): T {
  const baseBytes = Buffer.byteLength(JSON.stringify(params), "utf8");
  assert.ok(bytes >= baseBytes);
  params[paddingKey] = "x".repeat(bytes - baseBytes) as T[keyof T];
  assert.equal(Buffer.byteLength(JSON.stringify(params), "utf8"), bytes);
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
