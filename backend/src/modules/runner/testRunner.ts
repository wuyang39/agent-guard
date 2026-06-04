import { createId, nowIso } from "../../shared";
import type { AgentAdapterConfig, AgentUnderTest } from "../agent/agentTypes";
import type { TestContext } from "../config/schemas";
import type { TestRun, TestRunResult } from "./runTypes";
import type { SupervisionPolicyPack } from "@agent-guard/contracts";
import { TraceRecorder } from "../monitor/traceRecorder";
import { createMCPMonitor } from "../monitor/mcpMonitor";
import { createMcpSandboxForContext } from "../sandbox/mcpSandbox";
import { createAgentAdapterRegistry } from "../agent/agentAdapter";
import { MockAgentAdapter } from "../agent/mockAgentSession";

export type RunTestCaseOptions = {
  supervisionPolicyPack?: SupervisionPolicyPack;
  runtimeSessionId?: string;
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

  // 4. 记录 test_started
  recorder.record("test_started", "system", { contextId, sandboxId });

  // 5. 创建 AgentSession
  const registry = createAgentAdapterRegistry();
  registry.register(new MockAgentAdapter(testContext.testCase.toolIds));
  const adapter = registry.get(agent.adapterType);
  if (!adapter) {
    throw new Error(`No adapter registered for type: ${agent.adapterType}`);
  }
  const session = await adapter.createSession(agent, adapterConfig);

  // 6. 记录 task_sent
  const task = testContext.testCase.task;
  recorder.record("task_sent", "system", {
    taskId: task.taskId,
    instruction: task.instruction,
  });

  // 7. try/catch/finally
  try {
    const result = await session.sendTask(task, bridge, {
      runId,
      caseId,
      agentId,
    });
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

    return { testRun, trace, supervisionRecords: [] };
  }
}
