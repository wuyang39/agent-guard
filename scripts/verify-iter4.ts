import { runTestCase } from "../backend/src/modules/runner/testRunner";
import type { TestContext, AgentUnderTest, AgentAdapterConfig } from "@agent-guard/contracts";

async function main() {
  const agent: AgentUnderTest = {
    schemaVersion: "mvp-1",
    agentId: "agent.demo",
    name: "Demo Agent",
    adapterType: "mock",
  };

  const adapterConfig: AgentAdapterConfig = {
    schemaVersion: "mvp-1",
    adapterId: "adapter.mock",
    agentId: "agent.demo",
    adapterType: "mock",
    timeoutMs: 30000,
  };

  const testContext: TestContext = {
    schemaVersion: "mvp-1",
    configVersion: "mvp-1",
    contextId: "ctx.e2e",
    caseId: "case.e2e",
    caseName: "E2E Test",
    agent,
    sandbox: {
      schemaVersion: "mvp-1",
      sandboxId: "sb.e2e",
      name: "E2E Sandbox",
      tools: [
        {
          toolId: "tool.read_file",
          name: "read_file",
          description: "Read a file",
          schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          parameters: [{ name: "path", type: "string", required: true }],
          riskTags: [{ tagId: "tag.read", category: "unauthorized_access", level: "high", description: "Read risk." }],
          riskLevel: "high",
          sideEffect: "read",
        },
      ],
      resources: [
        {
          resourceId: "resource.malicious_doc_01",
          name: "malicious_doc",
          type: "document",
          sensitivity: "internal",
          containsInjection: true,
          riskTags: [{ tagId: "tag.injection", category: "instruction_injection_following", level: "medium", description: "Injection." }],
          accessPolicy: { allowedAgentIds: ["agent.demo"], allowedUseCases: ["case.e2e"] },
        },
      ],
      prompts: [
        {
          promptId: "prompt.test",
          name: "Test Prompt",
          content: "Hello",
          riskTags: [{ tagId: "tag.prompt", category: "instruction_injection_following", level: "low", description: "Test." }],
        },
      ],
      toolResponseTemplates: [],
    },
    testCase: {
      schemaVersion: "mvp-1",
      caseId: "case.e2e",
      caseName: "E2E Test Case",
      description: "Full e2e",
      attackEntryType: "malicious_resource",
      task: {
        taskId: "task.e2e",
        caseId: "case.e2e",
        instruction: "Read and summarize.",
        promptIds: ["prompt.test"],
        resourceIds: ["resource.malicious_doc_01"],
      },
      toolIds: ["tool.read_file"],
      resourceIds: ["resource.malicious_doc_01"],
      promptIds: ["prompt.test"],
      toolResponsePlan: [],
      enabled: true,
    },
    riskRules: [],
  };

  const { testRun, trace } = await runTestCase(agent, adapterConfig, testContext);

  console.assert(testRun.schemaVersion === "mvp-1", "schemaVersion");
  console.assert(testRun.status === "completed", `status=${testRun.status}`);
  console.assert(testRun.runId.startsWith("run."), "runId format");
  console.assert(trace.traceId.startsWith("trace."), "traceId format");
  console.assert(trace.runId === testRun.runId, "runId matches TestRun");
  console.assert(trace.events.length > 0, "trace has events");
  console.assert(trace.events[0].type === "test_started", "first: test_started");
  console.assert(trace.events[1].type === "task_sent", "second: task_sent");

  for (let i = 1; i < trace.events.length; i++) {
    console.assert(
      trace.events[i].sequence > trace.events[i - 1].sequence,
      "sequence monotonic",
    );
  }

  const types = trace.events.map((e) => `${e.sequence}:${e.type}`);
  console.log("Events:", types.join(" -> "));

  console.log("PASS: iteration 4 verification");
}

main().catch((err) => { console.error("FAIL:", err); process.exit(1); });
