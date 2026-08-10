import assert from "node:assert/strict";
import test from "node:test";
import {
  createNativeSupervisionAccessService,
} from "./nativeSupervisionAccessService";

const BOOTSTRAP = "b".repeat(43);

test("exchanges a bootstrap token once for an independent control capability", () => {
  let nowMs = 100;
  const service = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    now: () => nowMs,
    createToken: sequenceTokenFactory("c"),
  });

  const control = service.exchangeBootstrap(BOOTSTRAP);
  assert.ok(control);
  assert.equal(control.expiresAtMs, nowMs + 8 * 60 * 60 * 1_000);
  assert.equal(service.authenticateControl(control.token), true);
  assert.equal(service.authenticateEvents(control.token), false);
  assert.equal(service.exchangeBootstrap(BOOTSTRAP), undefined);
});

test("rejects malformed, incorrect, and expired bootstrap tokens without consuming a valid token", () => {
  let nowMs = 100;
  const service = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    now: () => nowMs,
    bootstrapTtlMs: 20,
    createToken: sequenceTokenFactory("c"),
  });

  assert.equal(service.exchangeBootstrap("short"), undefined);
  assert.equal(service.exchangeBootstrap("x".repeat(43)), undefined);
  assert.ok(service.exchangeBootstrap(BOOTSTRAP));

  const expired = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    now: () => nowMs,
    bootstrapTtlMs: 20,
  });
  nowMs += 20;
  assert.equal(expired.exchangeBootstrap(BOOTSTRAP), undefined);
});

test("issues an event-only capability from control and expires each class independently", () => {
  let nowMs = 100;
  const service = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    now: () => nowMs,
    controlTtlMs: 50,
    eventTtlMs: 20,
    createToken: sequenceTokenFactory("c", "e"),
  });
  const control = service.exchangeBootstrap(BOOTSTRAP)!;
  const events = service.issueEventCapability(control.token)!;

  assert.equal(service.authenticateControl(events.token), false);
  assert.equal(service.authenticateEvents(events.token), true);
  assert.equal(service.issueEventCapability(events.token), undefined);

  nowMs += 20;
  assert.equal(service.authenticateEvents(events.token), false);
  assert.equal(service.authenticateControl(control.token), true);
  nowMs += 30;
  assert.equal(service.authenticateControl(control.token), false);
});

test("does not accept capability tokens created by another backend generation", () => {
  const first = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    createToken: sequenceTokenFactory("c", "e"),
  });
  const control = first.exchangeBootstrap(BOOTSTRAP)!;
  const events = first.issueEventCapability(control.token)!;
  const restarted = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    createToken: sequenceTokenFactory("d"),
  });

  assert.equal(restarted.authenticateControl(control.token), false);
  assert.equal(restarted.authenticateEvents(events.token), false);
});

test("bounds retained capabilities by evicting the oldest live token", () => {
  let nowMs = 0;
  const service = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    now: () => nowMs,
    maxControlSessions: 2,
    maxEventCapabilities: 2,
    createToken: sequenceTokenFactory("c", "d", "e", "f", "g", "h"),
  });
  const control = service.exchangeBootstrap(BOOTSTRAP)!;
  nowMs += 1;
  const second = service.issueEventCapability(control.token)!;
  nowMs += 1;
  const third = service.issueEventCapability(control.token)!;
  nowMs += 1;
  const fourth = service.issueEventCapability(control.token)!;

  assert.equal(service.authenticateEvents(second.token), false);
  assert.equal(service.authenticateEvents(third.token), true);
  assert.equal(service.authenticateEvents(fourth.token), true);
});

test("rejects invalid configuration and generated token values", () => {
  assert.throws(
    () => createNativeSupervisionAccessService({ bootstrapToken: "short" }),
    /bootstrapToken/,
  );
  const service = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    createToken: () => "short",
  });
  assert.throws(() => service.exchangeBootstrap(BOOTSTRAP), /createToken result/);
});

test("never reuses a token across control and event capability classes", () => {
  const repeated = "c".repeat(43);
  let issuance = 0;
  const service = createNativeSupervisionAccessService({
    bootstrapToken: BOOTSTRAP,
    createToken: () => {
      issuance += 1;
      return issuance < 3 ? repeated : "e".repeat(43);
    },
  });
  const control = service.exchangeBootstrap(BOOTSTRAP)!;
  const events = service.issueEventCapability(control.token)!;

  assert.notEqual(events.token, repeated);
  assert.equal(service.authenticateControl(events.token), false);
  assert.equal(service.authenticateEvents(control.token), false);
});

function sequenceTokenFactory(...prefixes: string[]): () => string {
  let index = 0;
  return () => `${prefixes[index++ % prefixes.length]}${String(index).padStart(42, "0")}`;
}
