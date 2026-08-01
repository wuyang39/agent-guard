import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { canonicalJson, digestJson, signNativeGuardPayload, verifyNativeGuardPayload } from "./index";

test("canonical JSON is stable across key order", () => {
  assert.equal(canonicalJson({ z: 1, nested: { b: true, a: "x" } }), canonicalJson({ nested: { a: "x", b: true }, z: 1 }));
  assert.equal(digestJson({ z: 1, nested: { b: true, a: "x" } }), digestJson({ nested: { a: "x", b: true }, z: 1 }));
});

test("Ed25519 signature rejects changed payload", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = { requestId: "req.1", action: "allow" };
  const signature = signNativeGuardPayload(payload, privateKey);
  assert.equal(verifyNativeGuardPayload(payload, signature, publicKey), true);
  assert.equal(verifyNativeGuardPayload({ ...payload, action: "deny" }, signature, publicKey), false);
});

test("canonical JSON rejects non-finite numbers and unsupported values", () => {
  assert.throws(() => canonicalJson({ value: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson({ value: Number.POSITIVE_INFINITY }), TypeError);
  assert.throws(() => canonicalJson({ value: undefined }), TypeError);
});

test("signature verification returns false for malformed signatures", () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  assert.equal(verifyNativeGuardPayload({ requestId: "req.1" }, "not+a+signature", publicKey), false);
});
