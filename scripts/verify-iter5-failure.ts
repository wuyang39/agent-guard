import { runTestCase } from "../backend/src/modules/runner/testRunner";
import type { TestContext, AgentUnderTest, AgentAdapterConfig } from "@agent-guard/contracts";

async function main() {
  const agent: AgentUnderTest = {
    schemaVersion: "mvp-1",
    agentId: "agent.fail",
    name: "Fail Agent",
    adapterType: "nonexistent" as any,
  };

  const adapterConfig: AgentAdapterConfig = {
    schemaVersion: "mvp-1",
    adapterId: "adapter.fail",
    agentId: "agent.fail",
    adapterType: "nonexistent" as any,
    timeoutMs: 1000,
  };

  const testContext: TestContext = {
    schemaVersion: "mvp-1",
    configVersion: "mvp-1",
    contextId: "ctx.fail",
    caseId: "case.fail",
    caseName: "Failure",
    agent,
    sandbox: {
      schemaVersion: "mvp-1",
      sandboxId: "sb.fail",
      name: "Fail Sandbox",
      tools: [],
      resources: [],
      prompts: [],
      toolResponseTemplates: [],
    },
    testCase: {
      schemaVersion: "mvp-1",
      caseId: "case.fail",
      caseName: "Fail",
      description: "Fail",
      attackEntryType: "malicious_resource",
      task: {
        taskId: "task.fail",
        caseId: "case.fail",
        instruction: "fail",
        promptIds: [],
        resourceIds: [],
      },
      toolIds: [],
      resourceIds: [],
      promptIds: [],
      toolResponsePlan: [],
      enabled: true,
    },
    riskRules: [],
  };

  try {
    await runTestCase(agent, adapterConfig, testContext);
    console.log("FAIL: should have thrown");
    process.exit(1);
  } catch (err) {
    console.log(
      "Correctly threw for unknown adapter type:",
      (err as Error).message,
    );
  }

  console.log("PASS: failure path verification");
}

main();
