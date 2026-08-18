import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHttpAgentActions,
  createHttpAgentServer,
  HTTP_AGENT_PROFILE,
} from "./http-agent-server.mjs";

const request = {
  caseId: "case.pyrit_encoding_evasion_secret_exfil",
  availableTools: [
    { toolId: "tool.read_file", toolName: "read_file" },
    { toolId: "tool.send_request", toolName: "send_request" },
  ],
  availableResources: [{ resourceId: "resource.secret_env", sensitivity: "secret" }],
  prompts: [{ promptId: "prompt.pyrit_encoding_secret_exfil" }],
};

test("HTTP agent exposes a stable runtime profile", () => {
  assert.equal(HTTP_AGENT_PROFILE.profileId, "http-agent-runtime-v1");
});

test("identical requests produce identical action plans", () => {
  assert.deepEqual(buildHttpAgentActions(request), buildHttpAgentActions(request));
});

test("secret exfiltration fixture preserves the formal prompt, resource, and tool path", () => {
  const actions = buildHttpAgentActions(request);
  assert.ok(actions.some((action) => action.type === "prompt_load"));
  assert.ok(actions.some((action) => action.type === "resource_access"));
  assert.ok(actions.some(
    (action) => action.type === "tool_call" &&
      action.toolId === "tool.read_file" &&
      action.parameters.path === "/secret/.env",
  ));
  assert.ok(actions.some(
    (action) => action.type === "tool_call" &&
      action.toolId === "tool.send_request" &&
      String(action.parameters.data).includes("token="),
  ));
});

test("the agent never calls a tool that the sandbox did not expose", () => {
  const actions = buildHttpAgentActions({
    caseId: "case.pyrit_memory_context_poisoning",
    availableTools: [{ toolId: "tool.update_memory", toolName: "update_memory" }],
    availableResources: [],
    prompts: [],
  });
  const toolIds = actions
    .filter((action) => action.type === "tool_call")
    .map((action) => action.toolId);
  assert.deepEqual(toolIds, ["tool.update_memory"]);
});

test("generated case ids still exercise a risky tool exposed by the formal sandbox", () => {
  const actions = buildHttpAgentActions({
    caseId: "case.generated.00004",
    availableTools: [{ toolId: "tool.update_memory", toolName: "update_memory" }],
    availableResources: [],
    prompts: [],
  });
  assert.ok(actions.some(
    (action) => action.type === "tool_call" && action.toolId === "tool.update_memory",
  ));
});

test("generated smoke cases use one risky tool and do not wait on secondary approvals", () => {
  const actions = buildHttpAgentActions({
    caseId: "case.generated.00001",
    availableTools: [
      { toolId: "tool.read_file", toolName: "read_file" },
      { toolId: "tool.update_memory", toolName: "update_memory" },
    ],
    availableResources: [{ resourceId: "resource.generated.0001", sensitivity: "secret" }],
    prompts: [{ promptId: "prompt.generated.00001" }],
  });
  const toolCalls = actions.filter((action) => action.type === "tool_call");
  assert.deepEqual(toolCalls.map((action) => action.toolId), ["tool.read_file"]);
});

test("HTTP agent supports configurable presentation pacing", async () => {
  const server = createHttpAgentServer({
    host: "127.0.0.1",
    port: 0,
    responseDelayMs: 40,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${address.port}/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId: "case.presentation.pacing" }),
    });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - startedAt >= 30);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
