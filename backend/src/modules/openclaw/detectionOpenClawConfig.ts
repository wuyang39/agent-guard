import { createHash } from "node:crypto";

export type DetectionModelSelection = string | {
  primary?: string;
  fallbacks?: string[];
};

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
      model?: DetectionModelSelection;
    };
  };
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

/**
 * Project only OpenClaw's default model selector. Provider catalogs and model
 * aliases stay in the isolated agent's validated models.json snapshot.
 */
export function scrubDetectionOpenClawConfig(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) return {};
  const inputAgents = readDataProperty(input, "agents");
  const inputDefaults = isRecord(inputAgents.value) ? readDataProperty(inputAgents.value, "defaults") : { present: false, value: undefined };
  const hasDefaults = isRecord(inputAgents.value) && isRecord(inputDefaults.value);
  const source = hasDefaults ? inputDefaults.value as Record<string, unknown> : input;
  const model = readDataProperty(source, "model");
  return model.present ? { model: projectModelSelection(model.value) } : {};
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
  const model = modelInput === undefined ? undefined : projectModelSelection(modelInput);

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
  return generated;
}

export const buildDetectionOpenClawConfig = generateDetectionOpenClawConfig;
export const createDetectionOpenClawConfig = generateDetectionOpenClawConfig;

export function detectionConfigDigest(config: DetectionOpenClawConfig): string {
  return createHash("sha256").update(JSON.stringify(config), "utf8").digest("hex");
}

function projectModelSelection(value: unknown): DetectionModelSelection {
  if (typeof value === "string") return value;
  if (!isRecord(value)) throw invalidModelSelection();

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || (key !== "primary" && key !== "fallbacks"))) {
    throw invalidModelSelection();
  }

  const output: Exclude<DetectionModelSelection, string> = {};
  const primary = readDataProperty(value, "primary");
  if (primary.present) {
    if (typeof primary.value !== "string") throw invalidModelSelection();
    output.primary = primary.value;
  }
  const fallbacks = readDataProperty(value, "fallbacks");
  if (fallbacks.present) {
    if (!Array.isArray(fallbacks.value) || !fallbacks.value.every((entry) => typeof entry === "string")) {
      throw invalidModelSelection();
    }
    output.fallbacks = [...fallbacks.value];
  }
  return output;
}

function invalidModelSelection(): DetectionConfigError {
  return new DetectionConfigError(
    "INLINE_SECRET_UNSAFE",
    "Detection model selection must match OpenClaw's string or { primary, fallbacks } schema.",
  );
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
