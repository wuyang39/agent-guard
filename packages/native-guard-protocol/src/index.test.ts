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

test("canonical JSON rejects sparse arrays", () => {
  assert.throws(() => canonicalJson(new Array(1)), TypeError);
  assert.equal(canonicalJson([null]), "[null]");
  assert.throws(() => canonicalJson([undefined]), TypeError);
});

test("canonical JSON rejects unpaired UTF-16 surrogates", () => {
  assert.throws(() => canonicalJson("\uD800"), TypeError);
  assert.throws(() => canonicalJson("\uDC00"), TypeError);
  assert.throws(() => canonicalJson({ ["\uD800"]: "value" }), TypeError);
  assert.throws(() => canonicalJson({ ["\uDC00"]: "value" }), TypeError);
  assert.equal(canonicalJson("\uD83D\uDE00"), JSON.stringify("\uD83D\uDE00"));
});

test("signing requires an Ed25519 private key", () => {
  const { privateKey: ed448PrivateKey } = generateKeyPairSync("ed448");
  const { publicKey: ed25519PublicKey } = generateKeyPairSync("ed25519");
  assert.throws(() => signNativeGuardPayload({ requestId: "req.1" }, ed448PrivateKey), TypeError);
  assert.throws(() => signNativeGuardPayload({ requestId: "req.1" }, ed25519PublicKey), TypeError);
});

test("verification requires an Ed25519 public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { publicKey: ed448PublicKey } = generateKeyPairSync("ed448");
  const payload = { requestId: "req.1", action: "allow" };
  const signature = signNativeGuardPayload(payload, privateKey);
  assert.equal(verifyNativeGuardPayload(payload, signature, ed448PublicKey), false);
  assert.equal(verifyNativeGuardPayload(payload, signature, privateKey), false);
  assert.equal(verifyNativeGuardPayload(payload, signature, publicKey), true);
});
