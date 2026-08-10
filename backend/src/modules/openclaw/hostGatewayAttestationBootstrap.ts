import {
  createHash,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";

const MAX_BOOTSTRAP_BYTES = 4_096;

export type HostGatewayAttestationBootstrap = {
  attestationPublicKey: KeyObject;
  keyFingerprint: string;
};

export class HostGatewayAttestationBootstrapError extends Error {
  readonly code = "HOST_GATEWAY_ATTESTATION_BOOTSTRAP_INVALID";

  constructor() {
    super("Host Gateway attestation bootstrap is invalid.");
    this.name = "HostGatewayAttestationBootstrapError";
  }
}

export function readHostGatewayAttestationBootstrap(
  file: string,
): HostGatewayAttestationBootstrap {
  let fd: number | undefined;
  try {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw invalidBootstrap();
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BOOTSTRAP_BYTES) {
      throw invalidBootstrap();
    }
    const bytes = Buffer.alloc(MAX_BOOTSTRAP_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = readSync(fd, bytes, size, bytes.length - size, size);
      if (read === 0) break;
      size += read;
    }
    if (size !== stat.size || size > MAX_BOOTSTRAP_BYTES) throw invalidBootstrap();
    return parseBootstrap(bytes.subarray(0, size));
  } catch (error) {
    if (error instanceof HostGatewayAttestationBootstrapError) throw error;
    throw invalidBootstrap();
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The stable read result is already determined.
      }
    }
  }
}

function parseBootstrap(bytes: Buffer): HostGatewayAttestationBootstrap {
  if (
    bytes.length === 0 ||
    bytes[bytes.length - 1] !== 0x0a ||
    bytes.subarray(0, bytes.length - 1).includes(0x0a) ||
    bytes.subarray(0, bytes.length - 1).includes(0x0d)
  ) {
    throw invalidBootstrap();
  }
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, bytes.length - 1),
  );
  const value = JSON.parse(raw) as unknown;
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    value.contractVersion !== "native-guard-bootstrap-1" ||
    typeof value.attestationPublicKey !== "string" ||
    JSON.stringify(value) !== raw
  ) {
    throw invalidBootstrap();
  }
  const encoded = value.attestationPublicKey;
  const der = Buffer.from(encoded, "base64");
  if (der.length === 0 || der.toString("base64") !== encoded) throw invalidBootstrap();
  const attestationPublicKey = createPublicKey({ key: der, format: "der", type: "spki" });
  if (
    attestationPublicKey.type !== "public" ||
    attestationPublicKey.asymmetricKeyType !== "ed25519" ||
    attestationPublicKey.export({ format: "der", type: "spki" }).toString("base64") !== encoded
  ) {
    throw invalidBootstrap();
  }
  return {
    attestationPublicKey,
    keyFingerprint: `sha256:${createHash("sha256").update(der).digest("hex")}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidBootstrap(): HostGatewayAttestationBootstrapError {
  return new HostGatewayAttestationBootstrapError();
}
