/**
 * openclawAdapter — OpenClaw CLI Adapter (AgentAdapter 实现)
 *
 * 定位: 真实 OpenClaw 行为采集。CLI 检测阶段负责生成 trace、
 * RiskReport、DetectionReport、RiskProfile 和 PolicyPack；实时监督
 * 由 OpenClaw realtime MCP 入口承接。
 */

import fs from "node:fs";
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
    return preferredCliPath.trim();
  }
  for (const candidate of CLI_CANDIDATES) {
    if (candidate === "openclaw") {
      return candidate;
    }
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return process.env.OPENCLAW_CLI ?? "openclaw";
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
  const cli = resolveOpenClawCliPath(cliPath);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cli, ["--version"], {
      windowsHide: true,
      shell: shouldUseWindowsShell(cli),
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
