import { nowIso } from "../../shared";
import type {
  AgentAdapterConfig,
  AgentRunResult,
  AgentTask,
  AgentUnderTest,
} from "@agent-guard/contracts";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type { AgentRunMeta, AgentSession } from "./agentAdapter";

export class MockAgentSession implements AgentSession {
  public readonly agent: AgentUnderTest;
  public readonly config: AgentAdapterConfig;
  private readonly toolIds: string[];

  constructor(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
    toolIds: string[] = [],
  ) {
    this.agent = agent;
    this.config = config;
    this.toolIds = toolIds;
  }

  async sendTask(
    task: AgentTask,
    bridge?: AgentMcpBridge,
    runMeta?: AgentRunMeta,
  ): Promise<AgentRunResult> {
    const startedAt = nowIso();
    const finalMessages: string[] = [];

    try {
      // 1. 加载 prompts
      for (const promptId of task.promptIds) {
        if (bridge) {
          await bridge.handlePromptLoad(promptId);
          finalMessages.push(`[MockAgent] Loaded prompt: ${promptId}`);
        }
      }

      // 2. 访问 resources
      for (const resourceId of task.resourceIds) {
        if (bridge) {
          const access = await bridge.handleResourceAccess(resourceId);
          finalMessages.push(
            `[MockAgent] Read resource ${resourceId} (sensitivity=${access.sensitivity})`,
          );
        }
      }

      // 3. 调用 tools（toolIds 来自 TestCase 层级，由构造器传入）
      for (const toolId of this.toolIds) {
        if (bridge) {
          const result = await bridge.handleToolCall({
            toolId,
            parameters: { path: "/documents/test.md" },
          });
          finalMessages.push(
            `[MockAgent] Called ${toolId}: ${JSON.stringify(result.result)}`,
          );
        }
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
            : `[MockAgent] Completed task: ${task.instruction}`,
        startedAt,
        endedAt,
      };
    } catch (error) {
      return {
        schemaVersion: "mvp-1",
        runId: runMeta?.runId ?? "unknown",
        agentId: runMeta?.agentId ?? this.agent.agentId,
        caseId: runMeta?.caseId ?? task.caseId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        startedAt,
        endedAt: nowIso(),
      };
    }
  }

  async close(): Promise<void> {
    // no-op for mock
  }
}

export class MockAgentAdapter {
  readonly adapterType: "mock" = "mock";

  constructor(private readonly toolIds: string[] = []) {}

  async createSession(
    agent: AgentUnderTest,
    config: AgentAdapterConfig,
  ): Promise<AgentSession> {
    return new MockAgentSession(agent, config, this.toolIds);
  }
}
