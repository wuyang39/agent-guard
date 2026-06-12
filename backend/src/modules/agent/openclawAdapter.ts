/**
 * openclawAdapter — OpenClaw CLI Adapter (AgentAdapter 实现)
 *
 * B-3 定位: 真实 OpenClaw 行为采集 + 事后影子监督（非实时阻断）
 *
 * 两段式:
 *   1. Detection pass: 执行 openclaw agent --json CLI → 解析 JSONL → 存入 parsedSessionRegistry
 *   2. 生成 PolicyPack 后: e2eRunService 用真实策略对 toolCalls 做 post-hoc replay
 */

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
import type { ParsedSession } from "./openclawTypes";

/** 模块级 parsed session 注册表 —— e2eRunService 通过 runId 查询 */
type ParsedEntry = { session: ParsedSession; jsonlPath: string };
const parsedRegistry = new Map<string, ParsedEntry[]>();

export function getParsedSessions(runId: string): ParsedEntry[] {
  return parsedRegistry.get(runId) ?? [];
}

export function clearParsedRegistry(): void {
  parsedRegistry.clear();
}

export type OpenClawAdapterOptions = {
  gatewayUrl?: string;
  timeoutMs?: number;
};

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
      );

      // 存入 registry 供 e2eRunService 做 post-hoc replay
      if (runMeta?.runId) {
        const entries = parsedRegistry.get(runMeta.runId) ?? [];
        entries.push({ session: result.session, jsonlPath: result.jsonlPath });
        parsedRegistry.set(runMeta.runId, entries);
      }

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
export async function checkOpenClawAvailable(): Promise<{
  available: boolean; version?: string; error?: string;
}> {
  const { exec } = await import("node:child_process");
  const cli = process.env.OPENCLAW_CLI ?? "openclaw";
  return new Promise((resolve) => {
    exec(`"${cli}" --version`, { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve({ available: false, error: `CLI not available: ${error.message?.slice(0, 100)}` });
      } else if (stdout.trim()) {
        resolve({ available: true, version: stdout.trim() });
      } else {
        resolve({ available: false, error: "Empty output" });
      }
    });
  });
}
