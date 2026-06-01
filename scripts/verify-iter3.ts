import { TraceRecorder } from "../backend/src/modules/monitor/traceRecorder";
import { createMCPMonitor } from "../backend/src/modules/monitor/mcpMonitor";
import { createMockMcpSandboxRuntime } from "../backend/src/modules/sandbox/mockMcpSandboxRuntime";
import type { TestContext } from "@agent-guard/contracts";

const mockContext: TestContext = {
  schemaVersion: "mvp-1",
  configVersion: "mvp-1",
  contextId: "ctx.test",
  caseId: "case.test",
  caseName: "Test",
  agent: { schemaVersion: "mvp-1", agentId: "agent.demo", name: "Demo", adapterType: "mock" },
  sandbox: {
    schemaVersion: "mvp-1",
    sandboxId: "sb.test",
    name: "Test Sandbox",
    tools: [
      {
        toolId: "tool.read_file",
        name: "read_file",
        description: "Read",
        schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        parameters: [{ name: "path", type: "string", required: true }],
        riskTags: [{ tagId: "tag.read", category: "unauthorized_access", level: "high", description: "Read" }],
        riskLevel: "high",
        sideEffect: "read",
      },
    ],
    resources: [],
    prompts: [],
    toolResponseTemplates: [],
  },
  testCase: {
    schemaVersion: "mvp-1",
    caseId: "case.test",
    caseName: "Test",
    description: "Test",
    attackEntryType: "malicious_resource",
    task: { taskId: "task.test", caseId: "case.test", instruction: "test", promptIds: [], resourceIds: [] },
    toolIds: ["tool.read_file"],
    resourceIds: [],
    promptIds: [],
    toolResponsePlan: [],
    enabled: true,
  },
  riskRules: [],
};

async function verify() {
  const sandbox = createMockMcpSandboxRuntime(mockContext);
  const recorder = new TraceRecorder({ traceId: "trace.test", runId: "run.test", contextId: "ctx.test", caseId: "case.test" });
  const monitor = createMCPMonitor(sandbox, recorder);
  const bridge = monitor.createBridge();

  const result = await bridge.handleToolCall({ toolId: "tool.read_file", parameters: { path: "/f.txt" } });
  console.assert(result.callId !== "", "result has callId");

  const trace = monitor.finalizeTrace({
    schemaVersion: "mvp-1",
    traceId: "trace.test",
    runId: "run.test",
    contextId: "ctx.test",
    caseId: "case.test",
    agentId: "agent.demo",
    sandboxId: "sb.test",
    startedAt: new Date().toISOString(),
    status: "completed",
  });

  console.assert(trace.events.length === 2, `expected 2 events, got ${trace.events.length}`);
  console.assert(trace.events[0].type === "tool_call", "tool_call first");
  console.assert(trace.events[1].type === "tool_result", "tool_result second");
  console.assert(trace.events[0].sequence === 1, "seq starts at 1");
  console.assert(trace.events[1].sequence === 2, "seq increments");
  console.assert(
    (trace.events[0].payload as Record<string, unknown>).callId ===
    (trace.events[1].payload as Record<string, unknown>).callId,
    "callId matches between tool_call and tool_result",
  );

  console.log("PASS: iteration 3 verification");
}

verify().catch((err) => { console.error("FAIL:", err); process.exit(1); });
