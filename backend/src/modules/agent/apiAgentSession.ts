import { nowIso } from "../../shared";
import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentTask,
  AgentUnderTest,
  JsonObject,
  TestContext,
} from "@agent-guard/contracts";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type { AgentAdapter, AgentRunMeta, AgentSession } from "./agentAdapter";

type ApiAgentAction =
  | {
      type: "agent_message";
      message?: string;
    }
  | {
      type: "resource_access";
      resourceId?: string;
    }
  | {
      type: "tool_call";
      toolId?: string;
      parameters?: JsonObject;
      reason?: string;
    };

export class ApiAgentSession implements AgentSession {
  public readonly agent: AgentUnderTest;
  public readonly config: AgentAdapterConfig;

  constructor(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
    private readonly testContext: TestContext,
  ) {
    this.agent = agent;
    this.config = config;
  }

  async sendTask(
    task: AgentTask,
    bridge?: AgentMcpBridge,
    runMeta?: AgentRunMeta,
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const endpoint = this.config.endpoint;
    if (!endpoint) {
      return this.fail(task, startedAt, "API agent endpoint is required.", runMeta);
    }

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.config.timeoutMs),
        body: JSON.stringify({
          agent: this.agent,
          task,
          sandbox: this.testContext.sandbox,
          expectedActionSchema: {
            actions: [
              { type: "agent_message", message: "string" },
              { type: "resource_access", resourceId: "string" },
              {
                type: "tool_call",
                toolId: "string",
                parameters: "object",
                reason: "string",
              },
            ],
          },
        }),
      });

      if (!response.ok) {
        throw new Error(`API agent returned HTTP ${response.status}.`);
      }

      const payload = (await response.json()) as {
        actions?: ApiAgentAction[];
        finalMessage?: string;
      };
      const messages: string[] = [];

      for (const action of payload.actions ?? []) {
        if (action.type === "agent_message") {
          messages.push(action.message ?? "");
        }
        if (action.type === "resource_access" && bridge && action.resourceId) {
          const access = await bridge.handleResourceAccess(action.resourceId);
          messages.push(
            `[ApiAgent] Read resource ${access.resourceId} (authorized=${access.authorized})`,
          );
        }
        if (action.type === "tool_call" && bridge && action.toolId) {
          const result = await bridge.handleToolCall({
            toolId: action.toolId,
            parameters: action.parameters ?? {},
          });
          messages.push(`[ApiAgent] Called ${action.toolId}: ${JSON.stringify(result.result)}`);
        }
      }

      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "completed",
        finalMessage:
          payload.finalMessage ??
          messages.filter((message) => message.length > 0).join("\n") ??
          "API agent completed.",
        startedAt,
        endedAt: nowIso(),
      };
    } catch (error) {
      return this.fail(
        task,
        startedAt,
        error instanceof Error ? error.message : String(error),
        runMeta,
      );
    }
  }

  private fail(
    task: AgentTask,
    startedAt: string,
    error: string,
    runMeta?: AgentRunMeta,
  ): AgentRunResult {
    return {
      schemaVersion: "mvp-1",
      runId: runMeta?.runId ?? "unknown",
      agentId: runMeta?.agentId ?? this.agent.agentId,
      caseId: runMeta?.caseId ?? task.caseId,
      status: "failed",
      error,
      startedAt,
      endedAt: nowIso(),
    };
  }
}

export class ApiAgentAdapter implements AgentAdapter {
  readonly adapterType = "api" as const;

  constructor(private readonly testContext: TestContext) {}

  async createSession(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
  ): Promise<AgentSession> {
    return new ApiAgentSession(agent, config, this.testContext);
  }
}
