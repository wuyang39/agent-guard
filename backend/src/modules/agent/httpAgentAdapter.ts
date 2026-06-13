/**
 * httpAgentAdapter — HTTP Sample Agent Adapter
 *
 * 将外部 HTTP Agent 接入 Agent Guard runner → sandbox → supervision 链路。
 *
 * 流程:
 *   AgentTask → HttpAgentRequest → POST {endpointUrl}
 *   → HttpAgentResponse.actions[]
 *   → 逐条调用 AgentMcpBridge (handleToolCall / handleResourceAccess / handlePromptLoad)
 *   → AgentRunResult (含真实 HTTP agent 产生的 trace events)
 */

import { nowIso } from "../../shared";
import type {
  AgentAdapter,
  AgentRunMeta,
  AgentSession,
} from "./agentAdapter";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentTask,
  AgentUnderTest,
} from "@agent-guard/contracts";
import type {
  HttpAgentAction,
  HttpAgentConnection,
  HttpAgentPromptInfo,
  HttpAgentRequest,
  HttpAgentResourceInfo,
  HttpAgentToolInfo,
  HttpAgentResponse,
} from "./httpAgentTypes";

const DEFAULT_TIMEOUT_MS = 15_000;

export class HttpAgentAdapter implements AgentAdapter {
  readonly adapterType = "http_sample" as AgentUnderTest["adapterType"];

  constructor(
    private readonly connection: HttpAgentConnection,
  ) {}

  async createSession(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
  ): Promise<AgentSession> {
    return new HttpAgentSession(agent, config, this.connection);
  }
}

export class HttpAgentSession implements AgentSession {
  public readonly agent: AgentUnderTest;
  public readonly config: AgentAdapterConfig;
  private readonly connection: HttpAgentConnection;
  private sandboxTools: HttpAgentToolInfo[] = [];
  private sandboxResources: HttpAgentResourceInfo[] = [];
  private sandboxPrompts: HttpAgentPromptInfo[] = [];

  constructor(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
    connection: HttpAgentConnection,
  ) {
    this.agent = agent;
    this.config = config;
    this.connection = {
      timeoutMs: connection.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      endpointUrl: connection.endpointUrl,
      mode: connection.mode,
    };
  }

  /** 更新 sandbox 上下文 —— 在每次 sendTask 前由 runner 调用 */
  setSandboxContext(ctx: {
    tools: HttpAgentToolInfo[];
    resources: HttpAgentResourceInfo[];
    prompts: HttpAgentPromptInfo[];
  }): void {
    this.sandboxTools = ctx.tools;
    this.sandboxResources = ctx.resources;
    this.sandboxPrompts = ctx.prompts;
  }

  async sendTask(
    task: AgentTask,
    bridge?: AgentMcpBridge,
    runMeta?: AgentRunMeta,
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const finalMessages: string[] = [];

    try {
      // 1. 构造请求（含 sandbox 上下文）
      const request = buildHttpRequest(
        task,
        this.sandboxTools,
        this.sandboxResources,
        this.sandboxPrompts,
      );

      // 2. 发 HTTP POST
      const response = await postJson<HttpAgentResponse>(
        this.connection.endpointUrl,
        request,
        this.connection.timeoutMs,
      );

      // 3. 逐个处理 actions，通过 bridge 进入 sandbox + supervision
      for (const action of response.actions) {
        await this.processAction(action, bridge, finalMessages);
      }

      const endedAt = nowIso();

      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "completed",
        finalMessage:
          finalMessages.length > 0
            ? finalMessages.join("\n")
            : response.finalMessage || "[HTTP Agent] No message",
        startedAt,
        endedAt,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `[HTTP Agent] ${this.connection.endpointUrl}: ${message}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
  }

  async close(): Promise<void> {
    // no persistent connection to close
  }

  private async processAction(
    action: HttpAgentAction,
    bridge: AgentMcpBridge | undefined,
    messages: string[],
  ): Promise<void> {
    switch (action.type) {
      case "agent_message":
        messages.push(action.message);
        break;

      case "tool_call":
        if (bridge) {
          const result = await bridge.handleToolCall({
            toolId: action.toolId,
            toolName: action.toolName,
            parameters: action.parameters,
          });
          const blocked = (result.result as Record<string, unknown>)?.blocked;
          messages.push(
            `[HTTP Agent] Called ${action.toolId}` +
              (blocked ? " (BLOCKED by supervision)" : "") +
              (action.reason ? ` — ${action.reason}` : ""),
          );
        }
        break;

      case "resource_access":
        if (bridge) {
          const access = await bridge.handleResourceAccess(action.resourceId);
          messages.push(
            `[HTTP Agent] Read resource ${action.resourceId} (sensitivity=${access.sensitivity})` +
              (action.reason ? ` — ${action.reason}` : ""),
          );
        }
        break;

      case "prompt_load":
        if (bridge) {
          await bridge.handlePromptLoad(action.promptId);
          messages.push(`[HTTP Agent] Loaded prompt: ${action.promptId}`);
        }
        break;
    }
  }
}

// ---- helpers ----

function buildHttpRequest(
  task: AgentTask,
  tools: HttpAgentToolInfo[],
  resources: HttpAgentResourceInfo[],
  prompts: HttpAgentPromptInfo[],
): HttpAgentRequest {
  return {
    task: {
      taskId: task.taskId,
      instruction: task.instruction,
    },
    caseId: task.caseId,
    availableTools: tools,
    availableResources: resources,
    prompts,
  };
}

async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(
        `HTTP agent returned ${resp.status}: ${text.slice(0, 200)}`,
      );
    }

    return (await resp.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`HTTP agent request timed out after ${timeoutMs}ms`);
    }
    if (err instanceof TypeError && err.message.includes("fetch")) {
      throw new Error(
        `Cannot connect to HTTP agent at ${url}: ${err.message}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
