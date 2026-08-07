import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { resolveOpenClawCliInvocation } from "../agent/openclawAdapter";
import { scrubDetectionOpenClawConfig } from "./detectionOpenClawConfig";

const CONFIG_FILENAMES = ["openclaw.json", "clawdbot.json"] as const;
const DEFAULT_STATE_DIRNAMES = [".openclaw", ".clawdbot"] as const;

export type DetectionProfileSeed = {
  userConfig: Record<string, unknown>;
  agentStateDir: string;
  stateRootIdentity: DetectionProfileSeedDirectoryIdentity;
  agentStateIdentity: DetectionProfileSeedDirectoryIdentity;
};

export type DetectionProfileSeedDirectoryIdentity = {
  resolvedPath: string;
  canonicalPath: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
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

export type DetectionProfileSeedPaths = {
  stateDir: string;
  configPath: string;
};

type TrustedDirectorySnapshot = {
  path: string;
  stat: Stats;
};

export async function resolveDetectionProfileSeed(
  options: ResolveDetectionProfileSeedOptions = {},
): Promise<DetectionProfileSeed> {
  const { stateDir, configPath } = await resolveDetectionProfileSeedPaths(options);
  const stateRoot = await snapshotTrustedDirectory(stateDir, "OpenClaw state root");
  const configRoot = await snapshotTrustedDirectory(path.dirname(configPath), "OpenClaw config root");

  let raw: string;
  try {
    raw = (await readStableTrustedFile(configPath, configRoot.path)).toString("utf8");
  } catch (error) {
    if (error instanceof DetectionProfileSeedError) throw error;
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_MISSING",
      `Detection model configuration is unavailable at ${configPath}. Start OpenClaw with a valid model/provider configuration before running detection.`,
    );
  }
  await Promise.all([
    assertTrustedDirectoryUnchanged(stateRoot, "OpenClaw state root"),
    assertTrustedDirectoryUnchanged(configRoot, "OpenClaw config root"),
  ]);

  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw) as unknown;
  } catch {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection model configuration at ${configPath} is not valid JSON5.`,
    );
  }
  let userConfig: Record<string, unknown>;
  try {
    userConfig = scrubDetectionOpenClawConfig(parsed);
  } catch {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection model configuration at ${configPath} contains unsafe or invalid model settings.`,
    );
  }
  if (!hasExplicitModel(userConfig.model)) {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection model configuration at ${configPath} does not define an explicit default model.`,
    );
  }
  const agentStateDir = path.join(stateDir, "agents", "main", "agent");
  const agentState = await snapshotTrustedDirectory(agentStateDir, "OpenClaw main-agent state directory");
  await Promise.all([
    assertTrustedDirectoryUnchanged(stateRoot, "OpenClaw state root"),
    assertTrustedDirectoryUnchanged(configRoot, "OpenClaw config root"),
    assertTrustedDirectoryUnchanged(agentState, "OpenClaw main-agent state directory"),
  ]);
  return {
    userConfig,
    agentStateDir,
    stateRootIdentity: serializeTrustedDirectory(stateDir, stateRoot),
    agentStateIdentity: serializeTrustedDirectory(agentStateDir, agentState),
  };
}

export async function resolveDetectionProfileSeedPaths(
  options: ResolveDetectionProfileSeedOptions = {},
): Promise<DetectionProfileSeedPaths> {
  const baseEnv = options.env ?? process.env;
  const invocationEnv = options.cliPath
    ? resolveOpenClawCliInvocation(options.cliPath).env
    : undefined;
  const env = { ...baseEnv, ...invocationEnv };
  const homeDir = resolveEffectiveHome(env, options.homedir ?? os.homedir);
  const stateDir = await resolveStateDirectory(env, homeDir);
  const configCandidates = resolveConfigCandidates(env, homeDir);
  const configPath = await findSeedConfigPath(configCandidates);
  return { stateDir, configPath };
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

async function resolveStateDirectory(env: NodeJS.ProcessEnv, homeDir: string): Promise<string> {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return resolveProfilePath(explicit, homeDir);
  for (const name of DEFAULT_STATE_DIRNAMES) {
    const candidate = path.join(homeDir, name);
    if (await pathExists(candidate)) return candidate;
  }
  return path.join(homeDir, DEFAULT_STATE_DIRNAMES[0]);
}

function resolveConfigCandidates(env: NodeJS.ProcessEnv, homeDir: string): string[] {
  const explicitConfig = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitConfig) return [resolveProfilePath(explicitConfig, homeDir)];

  const directories: string[] = [];
  const explicitState = env.OPENCLAW_STATE_DIR?.trim();
  if (explicitState) directories.push(resolveProfilePath(explicitState, homeDir));
  directories.push(...DEFAULT_STATE_DIRNAMES.map((name) => path.join(homeDir, name)));

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const directory of directories) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.resolve(directory, filename);
      const key = process.platform === "win32" ? candidate.toLowerCase() : candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }
  return candidates;
}

async function findSeedConfigPath(configCandidates: string[]): Promise<string> {
  for (const configPath of configCandidates) {
    for (const candidate of [`${configPath}.last-good`, configPath]) {
      if (await pathExists(candidate)) return candidate;
    }
  }
  throw new DetectionProfileSeedError(
    "MODEL_PROFILE_SEED_MISSING",
    `Detection last-known-good model configuration is unavailable; no current configuration was found among: ${configCandidates.join(", ")}. Start OpenClaw with a valid model/provider configuration before running detection.`,
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function snapshotTrustedDirectory(target: string, label: string): Promise<TrustedDirectorySnapshot> {
  const resolved = path.resolve(target);
  try {
    await assertNoSymlinkPath(resolved);
    const stat = await fs.lstat(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DetectionProfileSeedError(
        "MODEL_PROFILE_SEED_INVALID",
        `Detection ${label} is not a regular directory: ${resolved}.`,
      );
    }
    return { path: await fs.realpath(resolved), stat };
  } catch (error) {
    if (error instanceof DetectionProfileSeedError) throw error;
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection ${label} is unavailable or invalid: ${resolved}.`,
    );
  }
}

async function assertTrustedDirectoryUnchanged(
  expected: TrustedDirectorySnapshot,
  label: string,
): Promise<void> {
  const current = await snapshotTrustedDirectory(expected.path, label);
  if (!sameHostPath(current.path, expected.path) || !sameFileIdentity(current.stat, expected.stat)) {
    throw new DetectionProfileSeedError(
      "MODEL_PROFILE_SEED_INVALID",
      `Detection ${label} changed while the model configuration was read: ${expected.path}.`,
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
  return sameFileIdentity(left, right) && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  return left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0
    ? left.dev === right.dev && left.ino === right.ino
    : left.birthtimeMs === right.birthtimeMs;
}

function serializeTrustedDirectory(
  resolvedPath: string,
  snapshot: TrustedDirectorySnapshot,
): DetectionProfileSeedDirectoryIdentity {
  return {
    resolvedPath: path.resolve(resolvedPath),
    canonicalPath: snapshot.path,
    dev: snapshot.stat.dev,
    ino: snapshot.stat.ino,
    birthtimeMs: snapshot.stat.birthtimeMs,
  };
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
