import { createHash } from "node:crypto";

export type DetectionOpenClawConfig = {
  gateway: { mode: "local" };
  agents: {
    defaults: {
      sandbox: {
        mode: "all";
        scope: "session";
        backend: "docker";
        workspaceAccess: "ro";
        browser: { enabled: false };
        docker: {
          user: "65532:65532";
          image?: string;
          labels?: Record<string, string>;
          pidsLimit: 128;
          memory: "512m";
          memorySwap: "512m";
          cpus: 1;
          ulimits: { nofile: "1024:1024" };
          securityOpt: ["no-new-privileges:true"];
          readOnlyRoot: true;
          tmpfs: ["/tmp", "/var/tmp", "/run"];
          network: "none" | "internal" | string;
          capDrop: ["ALL"];
          binds: [];
        };
      };
      model?: unknown;
      models?: unknown;
    };
  };
  models?: { providers: unknown };
  tools: { elevated: { enabled: false } };
  plugins: {
    enabled: true;
    allow: ["agent-guard-supervision"];
    load: { paths: [string] };
    slots: { memory: "none" };
    entries: {
      "agent-guard-supervision": {
        enabled: true;
        config: {
          markerDir: string;
          spoolDir: string;
        };
      };
    };
  };
};

export class DetectionConfigError extends Error {
  constructor(public readonly code: "INLINE_SECRET_UNSAFE", message: string) {
    super(message);
    this.name = "DetectionConfigError";
  }
}

const SENSITIVE_KEY = /^(?:authorization|bearer|cookie|api|access|auth|client|private|secret|credential|password|passwd)?[_-]?(?:key|token|secret|password|passwd|credential|authorization|cookie)$/i;
const FORBIDDEN_KEY = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CONFIG_DEPTH = 32;

/**
 * Copy only a model/provider reference subtree. The input is deliberately
 * treated as untrusted: no user plugins, tools, mounts, browser or elevated
 * settings are ever merged into the generated profile.
 */
export function scrubDetectionOpenClawConfig(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const inputAgents = readDataProperty(input, "agents");
  const inputDefaults = isRecord(inputAgents.value) ? readDataProperty(inputAgents.value, "defaults") : { present: false, value: undefined };
  const hasDefaults = isRecord(inputAgents.value) && isRecord(inputDefaults.value);
  const source = hasDefaults ? inputDefaults.value as Record<string, unknown> : input;
  const output: Record<string, unknown> = {};
  for (const key of ["model", "models"] as const) {
    const property = readDataProperty(source, key);
    if (property.present) output[key] = scrubValue(property.value, key, 0);
  }
  const topLevelModels = readDataProperty(input, "models");
  const catalogProviders = hasDefaults && isRecord(topLevelModels.value)
    ? readDataProperty(topLevelModels.value, "providers")
    : readDataProperty(source, "providers");
  if (catalogProviders.present) {
    output.providers = scrubValue(catalogProviders.value, "providers", 0);
  }
  return output;
}

export type GenerateDetectionConfigOptions = {
  pluginRoot: string;
  markerDir: string;
  spoolDir: string;
  userConfig?: unknown;
  model?: unknown;
};

export function generateDetectionOpenClawConfig(
  options: GenerateDetectionConfigOptions,
): DetectionOpenClawConfig {
  const scrubbed = scrubDetectionOpenClawConfig(options.userConfig);
  const modelInput = options.model ?? scrubbed.model;
  const model = modelInput === undefined ? undefined : scrubValue(modelInput, "model", 0);
  const models = scrubbed.models;
  const providers = scrubbed.providers;

  const generated: DetectionOpenClawConfig = {
    gateway: { mode: "local" },
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          backend: "docker",
          workspaceAccess: "ro",
          browser: { enabled: false },
          docker: {
            user: "65532:65532",
            pidsLimit: 128,
            memory: "512m",
            memorySwap: "512m",
            cpus: 1,
            ulimits: { nofile: "1024:1024" },
            securityOpt: ["no-new-privileges:true"],
            readOnlyRoot: true,
            tmpfs: ["/tmp", "/var/tmp", "/run"],
            network: "none",
            capDrop: ["ALL"],
            binds: [],
          },
        },
      },
    },
    tools: { elevated: { enabled: false } },
    plugins: {
      enabled: true,
      allow: ["agent-guard-supervision"],
      load: { paths: [options.pluginRoot] },
      slots: { memory: "none" },
      entries: {
        "agent-guard-supervision": {
          enabled: true,
          config: {
            markerDir: options.markerDir,
            spoolDir: options.spoolDir,
          },
        },
      },
    },
  };
  if (model !== undefined) generated.agents.defaults.model = model;
  if (models !== undefined) generated.agents.defaults.models = models;
  if (providers !== undefined) generated.models = { providers };
  return generated;
}

export const buildDetectionOpenClawConfig = generateDetectionOpenClawConfig;
export const createDetectionOpenClawConfig = generateDetectionOpenClawConfig;

export function detectionConfigDigest(config: DetectionOpenClawConfig): string {
  return createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");
}

function scrubValue(value: unknown, parentKey: string, depth: number): unknown {
  if (depth > MAX_CONFIG_DEPTH) {
    throw new DetectionConfigError("INLINE_SECRET_UNSAFE", "Detection configuration is too deeply nested.");
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(parentKey)) {
      throw new DetectionConfigError("INLINE_SECRET_UNSAFE", "Inline secret cannot be copied into a detection profile.");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, parentKey, depth + 1));
  if (!isRecord(value)) return undefined;

  if (isSecretRefShaped(value)) {
    throw new DetectionConfigError("INLINE_SECRET_UNSAFE", "Detection profiles cannot resolve SecretRefs.");
  }

  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY.has(key)) {
      throw new DetectionConfigError("INLINE_SECRET_UNSAFE", "Detection configuration contains a forbidden key.");
    }
    if (key === "headers" || SENSITIVE_KEY.test(key)) {
      throw new DetectionConfigError("INLINE_SECRET_UNSAFE", "Secret-bearing fields cannot be copied into a detection profile.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.get || descriptor.set) {
      throw new DetectionConfigError("INLINE_SECRET_UNSAFE", "Detection configuration cannot contain accessors.");
    }
    const scrubbed = scrubValue(descriptor.value, key, depth + 1);
    if (scrubbed !== undefined) output[key] = scrubbed;
  }
  return output;
}

function isSecretRefShaped(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, "SecretRef") ||
    (Object.prototype.hasOwnProperty.call(value, "source") &&
      Object.prototype.hasOwnProperty.call(value, "provider") &&
      Object.prototype.hasOwnProperty.call(value, "id"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDataProperty(record: Record<string, unknown>, key: string): { present: boolean; value: unknown } {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || descriptor.get || descriptor.set) {
    throw new DetectionConfigError("INLINE_SECRET_UNSAFE", "Detection configuration cannot contain accessors.");
  }
  return { present: true, value: descriptor.value };
}
