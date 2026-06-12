import { createId, nowIso } from "../../shared";
import type { AgentAdapterConfig, AgentUnderTest } from "../agent/agentTypes";
import type { AgentMcpBridge } from "../agent/agentMcpBridge";
import type { TestContext } from "../config/schemas";
import type { TestRun, TestRunResult } from "./runTypes";
import type { RuntimeSupervisionRecord, SupervisionPolicyPack } from "@agent-guard/contracts";
import { TraceRecorder } from "../monitor/traceRecorder";
import { createMCPMonitor } from "../monitor/mcpMonitor";
import { createMcpSandboxForContext } from "../sandbox/mcpSandbox";
import type { AgentAdapter } from "../agent/agentAdapter";
import { createAgentAdapterRegistry } from "../agent/agentAdapter";
import { MockAgentAdapter } from "../agent/mockAgentSession";
import { createSupervisionBridge } from "../supervisor/supervisionBridge";
import { createAgentSupervisor } from "../supervisor/agentSupervisor";

export type RunTestCaseOptions = {
  supervisionPolicyPack?: SupervisionPolicyPack;
  runtimeSessionId?: string;
  /** 自定义 adapter（如 http_sample / openclaw）。不传则默认 MockAgentAdapter。 */
  customAdapter?: AgentAdapter;
};

export async function runTestCase(
  agent: AgentUnderTest,
  adapterConfig: AgentAdapterConfig,
  testContext: TestContext,
  options?: RunTestCaseOptions,
): Promise<TestRunResult> {
  // 1. validate
  if (!agent.schemaVersion) throw new Error("agent.schemaVersion required");
  if (!testContext.schemaVersion)
    throw new Error("testContext.schemaVersion required");
  const caseId = testContext.caseId;
  const contextId = testContext.contextId;
  const agentId = agent.agentId;
  const sandboxId = testContext.sandbox.sandboxId;

  // 2. 创建初始对象
  const runId = createId("run");
  const traceId = createId("trace");
  const testRun: TestRun = {
    schemaVersion: "mvp-1",
    runId,
    contextId,
    caseId,
    agentId,
    sandboxId,
    status: "running",
    startedAt: nowIso(),
  };

  // 3. 创建 Sandbox（正式入口）+ Monitor + Bridge
  const sandbox = createMcpSandboxForContext(testContext);
  const recorder = new TraceRecorder({ traceId, runId, contextId, caseId });
  const monitor = createMCPMonitor(sandbox, recorder);
  const bridge = monitor.createBridge();

  // 3b. 如果有策略包，包装 SupervisionBridge
  let activeBridge: AgentMcpBridge = bridge;
  const supervisionRecords: RuntimeSupervisionRecord[] = [];
  if (options?.supervisionPolicyPack) {
    const supervisor = createAgentSupervisor(options.supervisionPolicyPack);
    const runtimeSessionId =
      options.runtimeSessionId ?? createId("session");
    const supervised = createSupervisionBridge({
      baseBridge: bridge,
      supervisor,
      recorder,
      runtimeSessionId,
      agentId,
    });
    activeBridge = supervised;
  }

  // 4. 记录 test_started
  recorder.record("test_started", "system", { contextId, sandboxId });

  // 5. 创建 AgentSession
  const registry = createAgentAdapterRegistry();
  // 始终注册 MockAdapter 作为兜底
  registry.register(new MockAgentAdapter(testContext));
  // 如果有自定义 adapter（http_sample / openclaw），优先注册
  if (options?.customAdapter) {
    registry.register(options.customAdapter);
  }
  const adapter = registry.get(agent.adapterType);
  if (!adapter) {
    throw new Error(`No adapter registered for type: ${agent.adapterType}`);
  }
  const session = await adapter.createSession(agent, adapterConfig);

  // 5b. 为支持 sandbox 感知的 adapter 注入上下文
  if ("setSandboxContext" in session && typeof (session as Record<string, unknown>).setSandboxContext === "function") {
    (session as { setSandboxContext(ctx: Record<string, unknown>): void }).setSandboxContext({
      tools: (testContext.sandbox.tools ?? []).map((t) => ({
        toolId: t.toolId,
        toolName: t.name ?? t.toolId,
        description: t.description,
      })),
      resources: (testContext.sandbox.resources ?? []).map((r) => ({
        resourceId: r.resourceId,
        path: r.path,
        sensitivity: r.sensitivity,
        description: r.description,
      })),
      prompts: (testContext.sandbox.prompts ?? []).map((p) => ({
        promptId: p.promptId,
        attackEntryType: p.attackEntryType,
        instruction: p.content,
      })),
    });
  }

  // 6. 记录 task_sent
  const task = testContext.testCase.task;
  recorder.record("task_sent", "system", {
    taskId: task.taskId,
    instruction: task.instruction,
  });

  // 7. try/catch/finally
  try {
    const result = await session.sendTask(task, activeBridge, {
      runId,
      caseId,
      agentId,
    });

    // 检查 result.status：即便 adapter 没有 throw，显式 failed 也应传播
    if (result.status === "failed") {
      throw new Error(result.error ?? result.finalMessage ?? "Agent task failed");
    }

    recorder.record("agent_message", "agent", {
      message: result.finalMessage ?? "",
    });
    testRun.status = "completed";
  } catch (error) {
    recorder.record("system_error", "system", {
      code: "RUNNER_ERROR",
      message: error instanceof Error ? error.message : String(error),
    });
    testRun.status = "failed";
    testRun.error =
      error instanceof Error ? error.message : String(error);
  } finally {
    await session.close?.();
    testRun.endedAt = nowIso();

    // 收集监督记录
    const supervised = activeBridge as unknown as { getRecords?: () => RuntimeSupervisionRecord[] };
    if (typeof supervised.getRecords === "function") {
      supervisionRecords.push(...supervised.getRecords());
    }

    const trace = monitor.finalizeTrace({
      schemaVersion: "mvp-1",
      traceId,
      runId,
      contextId,
      caseId,
      agentId,
      sandboxId,
      status: testRun.status,
      startedAt: testRun.startedAt,
      endedAt: testRun.endedAt,
    });

    return { testRun, trace, supervisionRecords };
  }
}
