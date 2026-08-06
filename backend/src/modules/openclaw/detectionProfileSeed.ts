import { constants as fsConstants, type Stats } from "node:fs";
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
  const explicitConfigPath = env.OPENCLAW_CONFIG_PATH?.trim();
  const configPath = explicitConfigPath
    ? resolveProfilePath(explicitConfigPath, homeDir)
    : path.join(stateDir, "openclaw.json");
  const lastGoodPath = `${configPath}.last-good`;
  const canonicalStateRoot = await assertTrustedDirectory(stateDir, "OpenClaw state root");
  const trustedConfigRoot = explicitConfigPath
    ? await assertTrustedDirectory(path.dirname(configPath), "OpenClaw config root")
    : canonicalStateRoot;

  let raw: string;
  try {
    raw = (await readStableTrustedFile(lastGoodPath, trustedConfigRoot)).toString("utf8");
  } catch (error) {
    if (error instanceof DetectionProfileSeedError) throw error;
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

async function assertTrustedDirectory(target: string, label: string): Promise<string> {
  const resolved = path.resolve(target);
  try {
    await assertNoSymlinkPath(resolved);
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory()) {
      throw new DetectionProfileSeedError(
        "MODEL_PROFILE_SEED_INVALID",
        `Detection ${label} is not a regular directory: ${resolved}.`,
      );
    }
    return await fs.realpath(resolved);
  } catch (error) {
    if (error instanceof DetectionProfileSeedError) throw error;
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection ${label} is unavailable or invalid: ${resolved}.`,
    );
  }
}

async function readStableTrustedFile(filePath: string, trustedRoot: string): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  await assertNoSymlinkPath(resolved);
  const canonical = await fs.realpath(resolved);
  if (!isPathInsideDirectory(canonical, trustedRoot)) {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection model configuration is outside the trusted OpenClaw root: ${resolved}.`,
    );
  }

  const preOpenStat = await fs.lstat(resolved);
  if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection model configuration is not a regular file: ${resolved}.`,
    );
  }
  const handle = await fs.open(resolved, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const openedStat = await handle.stat();
    const postOpenStat = await fs.lstat(resolved);
    if (
      !openedStat.isFile() ||
      postOpenStat.isSymbolicLink() ||
      !sameFileSnapshot(preOpenStat, openedStat) ||
      !sameFileSnapshot(openedStat, postOpenStat)
    ) {
      throw new DetectionProfileSeedError(
        "MODEL_PROFILE_SEED_INVALID",
        `Detection model configuration changed during validation: ${resolved}.`,
      );
    }
    const content = await handle.readFile();
    const postReadHandleStat = await handle.stat();
    const postReadPathStat = await fs.lstat(resolved);
    const postReadCanonical = await fs.realpath(resolved);
    if (
      postReadPathStat.isSymbolicLink() ||
      !sameFileSnapshot(openedStat, postReadHandleStat) ||
      !sameFileSnapshot(postReadHandleStat, postReadPathStat) ||
      !sameHostPath(canonical, postReadCanonical) ||
      !isPathInsideDirectory(postReadCanonical, trustedRoot)
    ) {
      throw new DetectionProfileSeedError(
        "MODEL_PROFILE_SEED_INVALID",
        `Detection model configuration changed while it was read: ${resolved}.`,
      );
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinkPath(target: string): Promise<void> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new DetectionProfileSeedError(
        "MODEL_PROFILE_SEED_INVALID",
        `Detection profile seed path contains a symbolic link or junction: ${current}.`,
      );
    }
  }
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  const sameIdentity = left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0
    ? left.dev === right.dev && left.ino === right.ino
    : left.birthtimeMs === right.birthtimeMs;
  return sameIdentity && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function isPathInsideDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && relative !== ".." && !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`);
}

function sameHostPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.normalize(path.resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
