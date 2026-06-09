/**
 * openclawAdapter — OpenClaw CLI Adapter (AgentAdapter 实现)
 *
 * B-3 定位: 真实 OpenClaw 行为采集 + 事后影子监督（非实时阻断）
 *
 * 通过 spawn("openclaw", ["agent", "--json", ...]) 执行任务，
 * 解析 session JSONL 提取 tool_call 事件，
 * 对每个 tool_call 做影子 sandbox + supervision 判定。
 */

import { nowIso } from "../../shared";
import type { AgentAdapter, AgentRunMeta, AgentSession } from "./agentAdapter";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentTask,
  AgentUnderTest,
  RuntimeSupervisionRecord,
} from "@agent-guard/contracts";
import { runOpenClawSession } from "./openclawSession";

/** 模块级影子记录注册表 —— e2eRunService 通过 runId 查询 */
const shadowRegistry = new Map<string, RuntimeSupervisionRecord[]>();

export function getShadowRecords(runId: string): RuntimeSupervisionRecord[] {
  return shadowRegistry.get(runId) ?? [];
}

export function clearShadowRegistry(): void {
  shadowRegistry.clear();
}

export type OpenClawAdapterOptions = {
  /** OpenClaw Gateway URL (仅用于可用性检测) */
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
  /** 当前 run 产出的影子监督记录（post-hoc） */
  public shadowRecords: RuntimeSupervisionRecord[] = [];

  constructor(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
    options: OpenClawAdapterOptions,
  ) {
    this.agent = agent;
    this.config = config;
    this.gatewayUrl = options.gatewayUrl ?? DEFAULT_GATEWAY;
  }

  /** 注入 sandbox 上下文（由 testRunner 在 sendTask 前调用） */
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

    if (!bridge) {
      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "failed",
        error: "OpenClaw adapter requires a bridge for shadow supervision",
        startedAt,
        endedAt: nowIso(),
      };
    }

    try {
      const result = await runOpenClawSession(
        task,
        bridge,
        {
          runId: runMeta?.runId ?? "unknown",
          caseId: runMeta?.caseId ?? task.caseId,
          agentId: runMeta?.agentId ?? this.agent.agentId,
        },
        {
          tools: this.sandboxTools,
          resources: this.sandboxResources,
        },
      );

      // 保存影子监督记录到注册表（供 e2eRunService 收集）
      this.shadowRecords = result.shadowRecords;
      if (runMeta?.runId) {
        shadowRegistry.set(runMeta.runId, result.shadowRecords);
      }

      // 构建 finalMessage，标注影子模式
      const shadowSummary =
        result.shadowRecords.length > 0
          ? `\n\n[Shadow Supervision — Post-Hoc Analysis]\n` +
            result.shadowRecords
              .map(
                (r) =>
                  `  ${r.action}: ${r.decisionReason.slice(0, 200)}`,
              )
              .join("\n") +
            `\n\nNote: These are post-hoc shadow judgments, NOT real-time blocks. ` +
            `The OpenClaw agent executed all tool calls natively. ` +
            `Real-time interception requires P3 MCP Proxy or Interceptor Plugin.`
          : "";

      const endedAt = nowIso();

      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "completed",
        finalMessage:
          result.session.finalAnswer + shadowSummary,
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

  async close(): Promise<void> {
    // no persistent connection
  }
}

/** 检测 OpenClaw CLI 是否可用 */
export async function checkOpenClawAvailable(): Promise<{
  available: boolean;
  version?: string;
  error?: string;
}> {
  const { exec } = await import("node:child_process");
  const cli = process.env.OPENCLAW_CLI ?? "openclaw";
  return new Promise((resolve) => {
    exec(`"${cli}" --version`, { timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve({
          available: false,
          error: `OpenClaw CLI not available: ${error.message?.slice(0, 100)}`,
        });
      } else if (stdout.trim()) {
        resolve({ available: true, version: stdout.trim() });
      } else {
        resolve({ available: false, error: "OpenClaw CLI returned empty output" });
      }
    });
  });
}
