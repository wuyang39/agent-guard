/**
 * verify-p3-b-gateway.ts — P3-B Gateway initial smoke test.
 *
 * Scope:
 * - Existing OpenClaw realtime MCP tools are registered as external tools.
 * - A real downstream MCP JSON-RPC provider can be aggregated and called.
 * - tools/call carries GatewayRuntimeContext into RuntimeSupervisionRecord.
 * - Unknown tools do not silently pass through.
 */

import http from "node:http";
import { buildApp } from "../backend/src/app";

type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
};

type JsonRpcResponse<T> = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: T;
  error?: { code: number; message: string };
};

type McpCallResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

type GatewayEnvelope = {
  runtimeSessionId: string;
  traceId: string;
  policyPackId: string;
  toolId: string;
  result?: unknown;
  gateway?: {
    providerId: string;
    originalToolName: string;
    canonicalToolId: string;
    decisionSource?: string;
    capabilityProfileSnapshot: {
      capabilityTags: string[];
      riskTags: string[];
      sideEffect: string;
      profileSource: string;
      llmAssisted?: boolean;
      llmMetadata?: { provider?: string };
    };
  };
  supervisionRecords: {
    action: string;
    policyId: string;
    gateway?: GatewayEnvelope["gateway"];
  }[];
  blocked: boolean;
};

type BatchResult = {
  batchId: string;
  runtimeSessionId: string;
  policyPackId: string;
  externalCaseCount: number;
  supervisedToolCallCount: number;
  policyHitCount: number;
  guardrailHitCount: number;
  blockedCount: number;
  askCount: number;
  redactedCount: number;
  recordIds: string[];
  cases: {
    externalCaseId: string;
    toolName: string;
    status: string;
    blocked: boolean;
    recordIds: string[];
    actionCounts: Record<string, number>;
    gateway?: GatewayEnvelope["gateway"];
  }[];
  explanationDraft?: {
    explanationId: string;
    llmAssisted: boolean;
    llmMetadata?: { provider?: string };
    summary: string;
    keyFindings: string[];
    limitations: string[];
    caseExplanations: {
      externalCaseId: string;
      toolName: string;
      outcome: string;
      explanation: string;
      recordIds: string[];
    }[];
  };
};

type StubMcpServer = {
  url: string;
  calls: { name: string; arguments: Record<string, unknown> }[];
  close(): Promise<void>;
};

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function httpJson<T>(
  method: "GET" | "POST",
  baseUrl: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return parsed as T;
}

async function rpc<T>(
  baseUrl: string,
  id: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<JsonRpcResponse<T>> {
  return httpJson<JsonRpcResponse<T>>(
    "POST",
    baseUrl,
    "/api/v1/openclaw/realtime/mcp",
    { jsonrpc: "2.0", id, method, params },
  );
}

async function callTool(
  baseUrl: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ rpc: JsonRpcResponse<McpCallResult>; envelope: GatewayEnvelope }> {
  const response = await rpc<McpCallResult>(baseUrl, id, "tools/call", {
    name,
    arguments: args,
  });
  assert(!response.error, `tools/call ${name} error: ${response.error?.message}`);
  assert(response.result?.content?.[0]?.text, `tools/call ${name} missing text result`);
  return {
    rpc: response,
    envelope: JSON.parse(response.result.content[0].text) as GatewayEnvelope,
  };
}

async function startStubMcpServer(): Promise<StubMcpServer> {
  const calls: StubMcpServer["calls"] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") as {
          id?: string | number | null;
          method?: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        if (body.method === "tools/list") {
          sendJson(response, {
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: {
              tools: [
                {
                  name: "run_shell",
                  description: "Run a shell command on a downstream MCP host.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      command: { type: "string" },
                      _agentGuardSessionId: { type: "string" },
                    },
                    required: ["command"],
                  },
                },
                {
                  name: "fail_shell",
                  description: "Run a shell command and return a downstream MCP error.",
                  inputSchema: {
                    type: "object",
                    properties: {
                      command: { type: "string" },
                      _agentGuardSessionId: { type: "string" },
                    },
                    required: ["command"],
                  },
                },
              ],
            },
          });
          return;
        }

        if (body.method === "tools/call") {
          if (body.params?.name === "fail_shell") {
            sendJson(response, {
              jsonrpc: "2.0",
              id: body.id ?? null,
              error: { code: -32042, message: "stub downstream failure" },
            });
            return;
          }
          calls.push({
            name: body.params?.name ?? "",
            arguments: body.params?.arguments ?? {},
          });
          sendJson(response, {
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    provider: "stub_mcp",
                    toolName: body.params?.name,
                    executed: true,
                    arguments: body.params?.arguments ?? {},
                  }),
                },
              ],
            },
          });
          return;
        }

        sendJson(response, {
          jsonrpc: "2.0",
          id: body.id ?? null,
          error: { code: -32601, message: `Unsupported method ${body.method}` },
        });
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object", "stub MCP server address missing");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function sendJson(response: http.ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  process.env.AGENT_GUARD_ASK_TIMEOUT = "demo_approve";
  process.env.AGENT_GUARD_ASK_TIMEOUT_MS = "50";
  process.env.AGENT_GUARD_LLM_ENABLED = "1";
  process.env.AGENT_GUARD_LLM_MODE = "mock";

  const stubMcp = await startStubMcpServer();
  const auditMcp = await startStubMcpServer();
  delete process.env.AGENT_GUARD_DOWNSTREAM_MCP_URL;
  delete process.env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_ID;
  delete process.env.AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_NAME;
  delete process.env.AGENT_GUARD_DOWNSTREAM_MCP_SERVERS;
  const app = await buildApp({ logger: false });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  try {
    console.log("P3-B Gateway Verification");
    console.log(`API: ${baseUrl}`);

    const runtimeConfig = await httpJson<
      ApiResponse<{
        downstreamMcp: { servers: { providerId: string }[] };
        gatewayReload: { toolCount: number; externalProviderCount: number };
      }>
    >("POST", baseUrl, "/api/v1/runtime-config/downstream-mcp", {
      enabled: true,
      servers: [
        {
          providerId: "stub_mcp",
          providerName: "Stub MCP Provider",
          endpointUrl: stubMcp.url,
          enabled: true,
          timeoutMs: 5000,
        },
        {
          providerId: "audit_mcp",
          providerName: "Audit MCP Provider",
          endpointUrl: auditMcp.url,
          enabled: true,
          timeoutMs: 5000,
        },
      ],
    });
    assert(runtimeConfig.ok === true, "multi MCP runtime config failed");
    assert(
      runtimeConfig.data?.gatewayReload.externalProviderCount === 2,
      "Gateway did not reload two MCP providers",
    );
    assert(
      runtimeConfig.data?.downstreamMcp.servers.length === 2,
      "runtime snapshot did not preserve two MCP servers",
    );
    console.log("0. multi MCP runtime config ok (2 providers)");

    const info = await httpJson<ApiResponse<{ tools: { name: string }[] }>>(
      "GET",
      baseUrl,
      "/api/v1/openclaw/realtime/mcp",
    );
    assert(info.ok === true, "MCP info endpoint is not ok");
    const infoToolNames = info.data?.tools.map((tool) => tool.name) ?? [];
    assert(infoToolNames.includes("agent_guard_read_file"), "read_file tool not exposed");
    assert(infoToolNames.includes("agw__stub_mcp__run_shell"), "stub MCP tool not exposed");
    assert(infoToolNames.includes("agw__audit_mcp__run_shell"), "second MCP provider tool not exposed");
    console.log(`1. info tools ok (${infoToolNames.length})`);

    const active = await httpJson<
      ApiResponse<{ resolvedPolicyPackId: string; policyCount: number }>
    >("POST", baseUrl, "/api/v1/openclaw/realtime/active-policy", {
      policyPackId: "fallback",
      resetSessions: true,
    });
    assert(active.ok === true, "active policy endpoint is not ok");
    assert((active.data?.policyCount ?? 0) > 0, "active policy has no policies");
    console.log(`2. active policy ok (${active.data?.resolvedPolicyPackId})`);

    const prepared = await httpJson<
      ApiResponse<{ runtimeSessionId: string; policyPackId: string }>
    >("POST", baseUrl, "/api/v1/openclaw/realtime/sessions", {
      policyPackId: active.data?.resolvedPolicyPackId,
    });
    assert(prepared.ok === true, "realtime session prepare failed");
    assert(prepared.data?.runtimeSessionId, "runtimeSessionId missing");
    const runtimeSessionId = prepared.data.runtimeSessionId;
    console.log(`3. session ok (${runtimeSessionId})`);

    const list = await rpc<{ tools: { name: string; inputSchema: unknown }[] }>(
      baseUrl,
      1,
      "tools/list",
    );
    assert(!list.error, `tools/list error: ${list.error?.message}`);
    const listToolNames = list.result?.tools.map((tool) => tool.name) ?? [];
    assert(listToolNames.includes("agent_guard_call_api"), "call_api tool not listed");
    assert(
      listToolNames.includes("agw__sandbox_downstream__execute_code"),
      "downstream execute_code tool not listed",
    );
    assert(
      listToolNames.includes("agw__stub_mcp__run_shell"),
      "real downstream MCP tool not listed",
    );
    console.log(`4. tools/list ok (${listToolNames.join(", ")})`);

    const denied = await callTool(baseUrl, 2, "agent_guard_read_file", {
      _agentGuardSessionId: runtimeSessionId,
      path: "/secret/.env",
    });
    assert(denied.envelope.blocked === true, "secret read should be blocked");
    assert(denied.envelope.gateway?.providerId === "agent_guard_realtime", "gateway provider missing");
    assert(denied.envelope.gateway.canonicalToolId === "tool.read_file", "canonical tool id mismatch");
    assert(
      denied.envelope.gateway.capabilityProfileSnapshot.capabilityTags.includes("filesystem.read"),
      "read_file capability tag missing",
    );
    console.log("5. gateway context on envelope ok");

    const downstreamAsk = await callTool(baseUrl, 20, "agw__sandbox_downstream__execute_code", {
      _agentGuardSessionId: runtimeSessionId,
      language: "python",
      code: "import os; os.system('whoami')",
    });
    assert(
      downstreamAsk.envelope.gateway?.providerId === "sandbox_downstream",
      "downstream provider id missing",
    );
    assert(
      downstreamAsk.envelope.gateway.originalToolName === "execute_code",
      "downstream original tool name mismatch",
    );
    assert(
      downstreamAsk.envelope.gateway.capabilityProfileSnapshot.capabilityTags.includes("shell.execute"),
      "downstream execute capability tag missing",
    );
    assert(
      downstreamAsk.envelope.supervisionRecords.some((record) => record.action === "ask"),
      "downstream ask supervision record missing",
    );
    console.log("5b. downstream provider tools/call supervision ok");

    const realDownstream = await callTool(baseUrl, 21, "agw__stub_mcp__run_shell", {
      _agentGuardSessionId: runtimeSessionId,
      command: "whoami",
    });
    assert(
      realDownstream.envelope.gateway?.providerId === "stub_mcp",
      "real downstream provider id missing",
    );
    assert(
      realDownstream.envelope.gateway.capabilityProfileSnapshot.capabilityTags.includes("shell.execute"),
      "real downstream shell capability tag missing",
    );
    assert(
      realDownstream.envelope.gateway.capabilityProfileSnapshot.llmAssisted === true,
      "real downstream tool should have LLM-assisted profile",
    );
    assert(
      realDownstream.envelope.gateway.capabilityProfileSnapshot.llmMetadata?.provider === "mock",
      "real downstream LLM metadata missing",
    );
    assert(
      realDownstream.envelope.supervisionRecords.some((record) => record.action === "ask"),
      "real downstream ask supervision record missing",
    );
    assert(stubMcp.calls.some((call) => call.name === "run_shell"), "stub MCP provider was not called");
    console.log("5c. real downstream MCP provider forwarding ok");

    const implicitSessionFirst = await callTool(baseUrl, 22, "agw__stub_mcp__run_shell", {
      command: "echo implicit-one",
    });
    const implicitSessionSecond = await callTool(baseUrl, 23, "agw__stub_mcp__run_shell", {
      command: "echo implicit-two",
    });
    assert(
      implicitSessionFirst.envelope.runtimeSessionId === implicitSessionSecond.envelope.runtimeSessionId,
      "implicit OpenClaw tool calls should reuse the active realtime session",
    );
    console.log("5cc. implicit OpenClaw session reuse ok");

    const unknown = await rpc<McpCallResult>(baseUrl, 3, "tools/call", {
      name: "unregistered_external_tool",
      arguments: {
        _agentGuardSessionId: runtimeSessionId,
        value: "should not pass silently",
      },
    });
    assert(!unknown.error, `unknown tool should return blocked MCP result, got: ${unknown.error?.message}`);
    assert(unknown.result?.isError === true, "unknown tool result should be marked as MCP error");
    const unknownEnvelope = JSON.parse(unknown.result.content[0]?.text ?? "{}") as GatewayEnvelope;
    assert(unknownEnvelope.blocked === true, "unknown tool should be blocked");
    assert(unknownEnvelope.gateway?.providerId === "unknown", "unknown gateway provider missing");
    assert(
      unknownEnvelope.gateway.decisionSource === "platform_guardrail",
      "unknown tool should be marked as platform guardrail",
    );
    assert(
      unknownEnvelope.supervisionRecords.some(
        (record) =>
          record.policyId === "platform.guardrail.unknown_external_tool" &&
          record.action === "deny",
      ),
      "unknown platform guardrail runtime record missing from envelope",
    );
    console.log("5d. unknown tool platform guardrail record ok");

    const batch = await httpJson<ApiResponse<BatchResult>>(
      "POST",
      baseUrl,
      "/api/v1/openclaw/realtime/supervision-batches",
      {
        runtimeSessionId,
        policyPackId: active.data?.resolvedPolicyPackId,
        source: "external_unknown_test_pack",
        cases: [
          {
            externalCaseId: "batch.secret_read",
            toolName: "agent_guard_read_file",
            arguments: { path: "/secret/batch.env" },
          },
          {
            externalCaseId: "batch.redact_email",
            toolName: "agent_guard_send_email",
            arguments: {
              to: ["security@example.com"],
              subject: "audit",
              body: "token=demo-secret-token",
            },
          },
          {
            externalCaseId: "batch.real_downstream_shell",
            toolName: "agw__stub_mcp__run_shell",
            arguments: { command: "id" },
          },
          {
            externalCaseId: "batch.unknown_tool",
            toolName: "unknown_from_batch",
            arguments: { payload: "must not pass" },
          },
          {
            externalCaseId: "batch.downstream_failure",
            toolName: "agw__stub_mcp__fail_shell",
            arguments: { command: "explode" },
          },
        ],
      },
    );
    assert(batch.ok === true, "supervision batch request failed");
    const batchData = batch.data;
    assert(batchData?.batchId, "batchId missing");
    assert(batchData.runtimeSessionId === runtimeSessionId, "batch runtimeSessionId mismatch");
    assert(batchData.externalCaseCount === 5, "batch externalCaseCount mismatch");
    assert(batchData.supervisedToolCallCount === 5, "batch supervisedToolCallCount mismatch");
    assert(batchData.recordIds.length >= 5, "batch recordIds missing");
    assert(batchData.policyHitCount >= 3, "batch policy hit count too low");
    assert(batchData.guardrailHitCount >= 1, "batch guardrail hit missing");
    assert(batchData.blockedCount >= 2, "batch blocked count too low");
    assert(batchData.askCount >= 2, "batch ask count missing");
    assert(batchData.redactedCount >= 1, "batch redact count missing");
    assert(
      batchData.cases.some(
        (item) =>
          item.externalCaseId === "batch.unknown_tool" &&
          item.gateway?.decisionSource === "platform_guardrail",
      ),
      "batch unknown case guardrail mapping missing",
    );
    assert(
      batchData.cases.some(
        (item) =>
          item.externalCaseId === "batch.downstream_failure" &&
          item.status === "failed" &&
          (item.actionCounts.ask ?? 0) >= 1 &&
          item.recordIds.length >= 1,
      ),
      "batch downstream failure should keep ask supervision record",
    );
    assert(
      stubMcp.calls.some((call) => call.name === "run_shell" && call.arguments.command === "id"),
      "batch real downstream provider was not called",
    );
    assert(batchData.explanationDraft, "batch explanation draft missing");
    assert(
      batchData.explanationDraft.llmAssisted === true,
      "mock LLM should assist batch explanation draft",
    );
    assert(
      batchData.explanationDraft.llmMetadata?.provider === "mock",
      "batch explanation LLM metadata missing",
    );
    assert(batchData.explanationDraft.summary.length > 0, "batch explanation summary missing");
    assert(
      batchData.explanationDraft.caseExplanations.length === batchData.cases.length,
      "batch case explanations count mismatch",
    );
    assert(
      batchData.explanationDraft.caseExplanations.some(
        (item) =>
          item.externalCaseId === "batch.unknown_tool" &&
          item.outcome === "platform_guardrail_blocked",
      ),
      "batch unknown case explanation outcome mismatch",
    );
    assert(
      batchData.explanationDraft.caseExplanations.some(
        (item) =>
          item.externalCaseId === "batch.downstream_failure" &&
          item.outcome === "downstream_failed",
      ),
      "batch downstream failure explanation outcome mismatch",
    );
    assert(
      batchData.explanationDraft.caseExplanations.every((item) =>
        item.recordIds.every((recordId) => batchData.recordIds.includes(recordId)),
      ),
      "batch explanation recordIds are not linked to batch recordIds",
    );
    console.log(`5e. supervision batch ok (${batchData.batchId})`);

    const batchDetail = await httpJson<ApiResponse<BatchResult>>(
      "GET",
      baseUrl,
      `/api/v1/openclaw/realtime/supervision-batches/${batchData.batchId}`,
    );
    assert(batchDetail.ok === true, "batch detail query failed");
    assert(batchDetail.data?.recordIds.length === batchData.recordIds.length, "batch detail recordIds mismatch");

    const batchList = await httpJson<ApiResponse<BatchResult[]>>(
      "GET",
      baseUrl,
      `/api/v1/openclaw/realtime/supervision-batches?runtimeSessionId=${encodeURIComponent(runtimeSessionId)}`,
    );
    assert(batchList.ok === true, "batch list query failed");
    assert(
      (batchList.data ?? []).some((item) => item.batchId === batchData.batchId),
      "batch list does not include created batch",
    );
    console.log("5f. supervision batch query ok");

    const session = await httpJson<
      ApiResponse<{
        records: {
          recordId: string;
          action: string;
          policyId: string;
          gateway?: GatewayEnvelope["gateway"];
        }[];
      }>
    >("GET", baseUrl, `/api/v1/supervision/sessions/${runtimeSessionId}`);
    assert(session.ok === true, "supervision session query failed");
    const denyRecord = session.data?.records.find((record) => record.action === "deny");
    assert(denyRecord?.gateway, "runtime record gateway snapshot missing");
    assert(
      denyRecord.gateway.capabilityProfileSnapshot.riskTags.length > 0,
      "runtime record gateway risk tags missing",
    );
    const downstreamRecord = session.data?.records.find(
      (record) => record.gateway?.providerId === "sandbox_downstream",
    );
    assert(downstreamRecord, "downstream runtime record missing");
    const realDownstreamRecord = session.data?.records.find(
      (record) => record.gateway?.providerId === "stub_mcp",
    );
    assert(realDownstreamRecord, "real downstream runtime record missing");
    const unknownRecord = session.data?.records.find(
      (record) => record.policyId === "platform.guardrail.unknown_external_tool",
    );
    assert(unknownRecord?.gateway?.decisionSource === "platform_guardrail", "unknown guardrail session record missing");
    assert(
      batchData.recordIds.every((recordId) =>
        session.data?.records.some((record) => record.recordId === recordId),
      ),
      "batch record IDs are not linked to session records",
    );
    console.log("6. runtime record gateway snapshot ok");

    console.log("P3-B gateway initial verification passed.");
  } finally {
    await app.close();
    await stubMcp.close();
    await auditMcp.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
