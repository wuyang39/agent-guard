import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOpenClawCliInvocation } from "../agent/openclawAdapter";
import { scrubDetectionOpenClawConfig } from "./detectionOpenClawConfig";

export type DetectionProfileSeed = {
  userConfig: Record<string, unknown>;
  agentStateDir: string;
};

export class DetectionProfileSeedError extends Error {
  constructor(
    public readonly code: "MODEL_PROFILE_SEED_MISSING" | "MODEL_PROFILE_SEED_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "DetectionProfileSeedError";
  }
}

export type ResolveDetectionProfileSeedOptions = {
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
};

export async function resolveDetectionProfileSeed(
  options: ResolveDetectionProfileSeedOptions = {},
): Promise<DetectionProfileSeed> {
  const baseEnv = options.env ?? process.env;
  const invocationEnv = options.cliPath
    ? resolveOpenClawCliInvocation(options.cliPath).env
    : undefined;
  const env = { ...baseEnv, ...invocationEnv };
  const homeDir = resolveEffectiveHome(env, options.homedir ?? os.homedir);
  const stateDir = env.OPENCLAW_STATE_DIR?.trim()
    ? resolveProfilePath(env.OPENCLAW_STATE_DIR, homeDir)
    : path.join(homeDir, ".openclaw");
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim()
    ? resolveProfilePath(env.OPENCLAW_CONFIG_PATH, homeDir)
    : path.join(stateDir, "openclaw.json");
  const lastGoodPath = `${configPath}.last-good`;

  let raw: string;
  try {
    raw = await fs.readFile(lastGoodPath, "utf8");
  } catch {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_MISSING",
      `Detection last-known-good model configuration is unavailable at ${lastGoodPath}. Start OpenClaw with a valid model/provider configuration before running detection.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection last-known-good model configuration at ${lastGoodPath} is not valid JSON.`,
    );
  }
  let userConfig: Record<string, unknown>;
  try {
    userConfig = scrubDetectionOpenClawConfig(parsed);
  } catch {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection last-known-good model configuration at ${lastGoodPath} contains unsafe or invalid model/provider settings.`,
    );
  }
  if (!hasExplicitModel(userConfig.model)) {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection last-known-good model configuration at ${lastGoodPath} does not define an explicit default model.`,
    );
  }
  return {
    userConfig,
    agentStateDir: path.join(stateDir, "agents", "main", "agent"),
  };
}

function hasExplicitModel(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const primary = Object.getOwnPropertyDescriptor(value, "primary");
  return Boolean(primary && !primary.get && !primary.set && typeof primary.value === "string" && primary.value.trim());
}

function resolveEffectiveHome(env: NodeJS.ProcessEnv, homedir: () => string): string {
  const osHome = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const configured = env.OPENCLAW_HOME?.trim();
  if (!configured) return path.resolve(osHome);
  return resolveProfilePath(configured, path.resolve(osHome));
}

function resolveProfilePath(input: string, homeDir: string): string {
  const trimmed = input.trim();
  const expanded = trimmed === "~" || trimmed.startsWith(`~${path.sep}`) || /^[~][\\/]/.test(trimmed)
    ? `${homeDir}${trimmed.slice(1)}`
    : trimmed;
  return path.resolve(expanded);
}
