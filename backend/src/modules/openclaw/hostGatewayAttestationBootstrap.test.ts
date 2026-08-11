import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HostGatewayAttestationBootstrapError,
  readHostGatewayAttestationBootstrap,
} from "./hostGatewayAttestationBootstrap";

test("reads one exact canonical Ed25519 host bootstrap record", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-guard-host-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "bootstrap.json");
  const { publicKey } = generateKeyPairSync("ed25519");
  const encoded = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await writeFile(file, `${JSON.stringify({
    contractVersion: "native-guard-bootstrap-1",
    attestationPublicKey: encoded,
  })}\n`, "utf8");

  const bootstrap = readHostGatewayAttestationBootstrap(file);

  assert.equal(bootstrap.attestationPublicKey.asymmetricKeyType, "ed25519");
  assert.equal(
    bootstrap.attestationPublicKey.export({ format: "der", type: "spki" }).toString("base64"),
    encoded,
  );
  assert.match(bootstrap.keyFingerprint, /^sha256:[a-f0-9]{64}$/);
});

test("rejects malformed, noncanonical, oversized, and non-Ed25519 host bootstrap files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-guard-host-bootstrap-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ed25519 = generateKeyPairSync("ed25519").publicKey
    .export({ format: "der", type: "spki" }).toString("base64");
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
    .export({ format: "der", type: "spki" }).toString("base64");
  const cases = [
    "",
    JSON.stringify({ contractVersion: "native-guard-bootstrap-1", attestationPublicKey: ed25519 }),
    ` ${JSON.stringify({ contractVersion: "native-guard-bootstrap-1", attestationPublicKey: ed25519 })}\n`,
    `${JSON.stringify({ contractVersion: "native-guard-bootstrap-1", attestationPublicKey: ed25519, extra: true })}\n`,
    `${JSON.stringify({ contractVersion: "native-guard-bootstrap-1", attestationPublicKey: "AAAA" })}\n`,
    `${JSON.stringify({ contractVersion: "native-guard-bootstrap-1", attestationPublicKey: rsa })}\n`,
    "x".repeat(4_097),
  ];

  for (const [index, content] of cases.entries()) {
    const file = path.join(root, `invalid-${String(index)}.json`);
    await writeFile(file, content, "utf8");
    assert.throws(
      () => readHostGatewayAttestationBootstrap(file),
      (error: unknown) => error instanceof HostGatewayAttestationBootstrapError &&
        error.code === "HOST_GATEWAY_ATTESTATION_BOOTSTRAP_INVALID" &&
        !error.message.includes(root),
    );
  }
});

test("rejects missing and relative bootstrap paths without reflecting them", () => {
  for (const file of ["relative-secret-bootstrap.json", path.resolve("missing-secret-bootstrap.json")]) {
    assert.throws(
      () => readHostGatewayAttestationBootstrap(file),
      (error: unknown) => error instanceof HostGatewayAttestationBootstrapError &&
        !error.message.includes("secret-bootstrap"),
    );
  }
});
