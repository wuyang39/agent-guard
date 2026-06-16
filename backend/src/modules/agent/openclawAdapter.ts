/**
 * openclawAdapter — OpenClaw CLI Adapter (AgentAdapter 实现)
 *
 * 定位: 真实 OpenClaw 行为采集。CLI 检测阶段负责生成 trace、
 * RiskReport、DetectionReport、RiskProfile 和 PolicyPack；实时监督
 * 由 OpenClaw realtime MCP 入口承接。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { nowIso } from "../../shared";
import type { AgentAdapter, AgentRunMeta, AgentSession } from "./agentAdapter";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentTask,
  AgentUnderTest,
} from "@agent-guard/contracts";
import { runOpenClawSession } from "./openclawSession";

export type OpenClawAdapterOptions = {
  gatewayUrl?: string;
  cliPath?: string;
  timeoutMs?: number;
};

const CLI_CANDIDATES = [
  process.env.OPENCLAW_CLI,
  "openclaw",
].filter((value): value is string => Boolean(value && value.trim()));

export function resolveOpenClawCliPath(preferredCliPath?: string): string {
  if (preferredCliPath?.trim()) {
    return resolveCommandPath(preferredCliPath.trim());
  }
  for (const candidate of CLI_CANDIDATES) {
    if (candidate === "openclaw") {
      return resolveCommandPath(candidate);
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return resolveCommandPath(process.env.OPENCLAW_CLI ?? "openclaw");
}

export type OpenClawCliInvocation = {
  command: string;
  argsPrefix: string[];
  displayPath: string;
  shell: boolean;
  env?: Record<string, string>;
};

export function resolveOpenClawCliInvocation(preferredCliPath?: string): OpenClawCliInvocation {
  const cliPath = resolveOpenClawCliPath(preferredCliPath);
  const npmShimTarget = resolveWindowsNpmShimTarget(cliPath);
  if (npmShimTarget) {
    return {
      command: process.execPath,
      argsPrefix: [npmShimTarget.target],
      displayPath: cliPath,
      shell: false,
      env: npmShimTarget.env,
    };
  }
  return {
    command: cliPath,
    argsPrefix: [],
    displayPath: cliPath,
    shell: shouldUseWindowsShell(cliPath),
  };
}

const DEFAULT_GATEWAY =
  process.env.OPENCLAW_GATEWAY_URL ?? "http://localhost:18789";

export class OpenClawAdapter implements AgentAdapter {
  readonly adapterType = "openclaw" as AgentUnderTest["adapterType"];

  constructor(private readonly options: OpenClawAdapterOptions = {}) {}

  async createSession(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
  ): Promise<AgentSession> {
    return new OpenClawSession(agent, config, this.options);
  }
}

export class OpenClawSession implements AgentSession {
  public readonly agent: AgentUnderTest;
  public readonly config: AgentAdapterConfig;
  private readonly gatewayUrl: string;
  private readonly cliPath?: string;
  private readonly timeoutMs?: number;
  private sandboxTools: { toolId: string; toolName?: string; description?: string }[] = [];
  private sandboxResources: { resourceId: string; path?: string; sensitivity?: string; description?: string }[] = [];

  constructor(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
    options: OpenClawAdapterOptions,
  ) {
    this.agent = agent;
    this.config = config;
    this.gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY;
    this.cliPath = options.cliPath;
    this.timeoutMs = options.timeoutMs;
  }

  setSandboxContext(ctx: {
    tools: { toolId: string; toolName?: string; description?: string }[];
    resources: { resourceId: string; path?: string; sensitivity?: string; description?: string }[];
  }): void {
    this.sandboxTools = ctx.tools;
    this.sandboxResources = ctx.resources;
  }

  async sendTask(
    task: AgentTask,
    bridge?: AgentMcpBridge,
    runMeta?: AgentRunMeta,
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();

    try {
      const result = await runOpenClawSession(
        task,
        bridge,  // ← 传入 bridge：tool calls 将通过 bridge 写入 trace
        {
          runId: runMeta?.runId ?? "unknown",
          caseId: runMeta?.caseId ?? task.caseId,
          agentId: runMeta?.agentId ?? this.agent.agentId,
        },
        { tools: this.sandboxTools, resources: this.sandboxResources },
        { cliPath: this.cliPath, timeoutMs: this.timeoutMs },
      );

      const endedAt = nowIso();
      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "completed",
        finalMessage: result.session.finalAnswer,
        startedAt,
        endedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "failed",
        error: message,
        finalMessage: `[OpenClaw Error] ${message}`,
        startedAt,
        endedAt: nowIso(),
      };
    }
  }

  async close(): Promise<void> {}
}

/** 检测 OpenClaw CLI 是否可用 */
export async function checkOpenClawAvailable(cliPath?: string): Promise<{
  available: boolean; version?: string; error?: string;
}> {
  const cli = resolveOpenClawCliInvocation(cliPath);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cli.command, [...cli.argsPrefix, "--version"], {
      windowsHide: true,
      shell: cli.shell,
      env: { ...process.env, ...cli.env },
    });
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        resolve({ available: false, error: "CLI version check timed out." });
      }
    }, 10_000);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ available: false, error: `CLI not available: ${error.message.slice(0, 100)}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const version = stdout.trim();
      if (code === 0 && version) {
        resolve({ available: true, version });
      } else {
        resolve({
          available: false,
          error: stderr.trim() ? stderr.trim().slice(0, 160) : "Empty output",
        });
      }
    });
  });
}

function shouldUseWindowsShell(commandPath: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/i.test(commandPath);
}

function resolveWindowsNpmShimTarget(commandPath: string): {
  target: string;
  env?: Record<string, string>;
} | undefined {
  if (process.platform !== "win32" || !/\.cmd$/i.test(commandPath)) {
    return undefined;
  }
  const baseDir = path.dirname(commandPath);
  const parentDir = path.dirname(baseDir);
  const candidateTargets = [
    {
      target: path.join(baseDir, "node_modules", "openclaw", "openclaw.mjs"),
      env: resolveOpenClawLocalEnv(
        path.basename(baseDir).toLowerCase() === "cli" ? parentDir : baseDir,
      ),
    },
    {
      target: path.join(baseDir, "cli", "node_modules", "openclaw", "openclaw.mjs"),
      env: resolveOpenClawLocalEnv(baseDir),
    },
  ];
  return candidateTargets.find((candidate) => fs.existsSync(candidate.target));
}

function resolveOpenClawLocalEnv(rootDir: string): Record<string, string> | undefined {
  const configDir = path.join(rootDir, "config");
  const configPath = path.join(configDir, "openclaw.json");
  if (!fs.existsSync(configPath)) return undefined;
  return {
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_CONFIG_DIR: configDir,
    OPENCLAW_HOME: rootDir,
  };
}

function resolveCommandPath(commandPath: string): string {
  if (process.platform !== "win32") return commandPath;
  if (path.isAbsolute(commandPath) || commandPath.includes("\\") || commandPath.includes("/")) {
    return commandPath;
  }

  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const pathExts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.toLowerCase());
  const hasExtension = path.extname(commandPath).length > 0;
  const candidates = hasExtension
    ? [commandPath]
    : [...pathExts.map((ext) => `${commandPath}${ext}`), commandPath];

  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (fs.existsSync(fullPath)) return fullPath;
    }
  }

  return commandPath;
}
