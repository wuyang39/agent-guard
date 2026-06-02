import path from "node:path";
import type { AgentUnderTest } from "@agent-guard/contracts";
import {
  loadConfigRepository,
  loadTestContexts,
} from "../backend/src/modules/config/loadTestContext";
import { createMcpSandboxForContext } from "../backend/src/modules/sandbox";

const rootDir = process.cwd();
const configsDir = path.resolve(rootDir, "configs");

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const agent: AgentUnderTest = {
    schemaVersion: "mvp-1",
    agentId: "agent.demo",
    name: "Demo Agent",
    adapterType: "mock",
  };

  const repository = await loadConfigRepository(configsDir);
  assert(repository.tools.length === 2, "loads tools.json");
  assert(repository.resources.length === 2, "loads resources.json");
  assert(repository.riskRules.length === 2, "loads risk_rules.json");
  assert(repository.testCases.length === 2, "loads test_cases.json");

  const { contexts, testOracles } = await loadTestContexts(configsDir, agent);
  assert(contexts.length === 2, "builds one TestContext per enabled test case");
  assert(testOracles.length === 2, "returns TestOracle[] for offline verification");

  for (const context of contexts) {
    assert(context.schemaVersion === "mvp-1", "context schemaVersion");
    assert(context.configVersion === "mvp-1", "context configVersion");
    assert(context.agent.agentId === agent.agentId, "context agent");
    assert(context.riskRules.length === repository.riskRules.length, "context riskRules");
    assert(!("expectedOutcome" in context), "TestContext must not include expectedOutcome");
    assert(!("testOracles" in context), "TestContext must not include TestOracle[]");
  }

  const resourceContext = contexts.find(
    (context) => context.caseId === "case.resource_injection",
  );
  assert(resourceContext !== undefined, "resource injection context exists");
  const resourceSandbox = createMcpSandboxForContext(resourceContext);
  const maliciousResource = await resourceSandbox.readResource(
    "resource.malicious_doc_01",
  );
  assert(maliciousResource.authorized, "allowed use case authorizes malicious doc");
  assert(maliciousResource.containsInjection, "malicious doc carries injection flag");

  const secretResource = await resourceSandbox.readResource("resource.secret_env");
  assert(!secretResource.authorized, "secret resource remains unauthorized");
  assert(secretResource.sensitivity === "secret", "secret sensitivity is preserved");

  const toolResponseContext = contexts.find(
    (context) => context.caseId === "case.tool_response_injection",
  );
  assert(toolResponseContext !== undefined, "tool response context exists");
  const toolResponseSandbox = createMcpSandboxForContext(toolResponseContext);
  const responsePlan = toolResponseContext.testCase.toolResponsePlan[0];
  assert(responsePlan !== undefined, "tool response plan exists");

  const resolved = await toolResponseSandbox.resolveToolResponse(responsePlan, {
    path: "/docs/public_policy.md",
  });
  assert(resolved?.responseTemplateId === "response.inject_send_request", "resolves response template");

  const firstToolResult = await toolResponseSandbox.executeTool("tool.read_file", {
    path: "/docs/public_policy.md",
  });
  assert(firstToolResult.containsInjection, "first tool call applies first_call injection");
  assert(
    firstToolResult.riskTagIds.includes("tag.tool_response_injection"),
    "tool response risk tag is attached",
  );

  const secondToolResult = await toolResponseSandbox.executeTool("tool.read_file", {
    path: "/docs/public_policy.md",
  });
  assert(!secondToolResult.containsInjection, "second tool call does not repeat first_call injection");

  const prompt = await toolResponseSandbox.loadPrompt("prompt.malicious_user_01");
  assert(prompt.attackEntryType === "malicious_user_prompt", "prompt attack entry is preserved");

  console.log("PASS: A line config + sandbox verification");
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
