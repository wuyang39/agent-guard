/**
 * verify-openclaw-realtime-mcp.ts — OpenClaw realtime MCP supervision smoke test.
 *
 * This verifies the product path OpenClaw can use after configuring an MCP
 * server/proxy: JSON-RPC initialize -> tools/list -> tools/call -> persisted
 * supervision records + trace query.
 */

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

type AgentGuardToolEnvelope = {
  runtimeSessionId: string;
  traceId: string;
  policyPackId: string;
  blocked: boolean;
  supervisionRecords: { action: string; targetType: string; policyId: string }[];
  result?: unknown;
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
): Promise<{ rpc: JsonRpcResponse<McpCallResult>; envelope: AgentGuardToolEnvelope }> {
  const response = await rpc<McpCallResult>(baseUrl, id, "tools/call", {
    name,
    arguments: args,
  });
  assert(!response.error, `tools/call ${name} error: ${response.error?.message}`);
  assert(response.result?.content?.[0]?.text, `tools/call ${name} missing text result`);
  return {
    rpc: response,
    envelope: JSON.parse(response.result.content[0].text) as AgentGuardToolEnvelope,
  };
}

async function readEventStreamUntil(
  baseUrl: string,
  pattern: RegExp,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  let body = "";

  try {
    const response = await fetch(
      `${baseUrl}/api/v1/openclaw/realtime/events/stream?replay=1`,
      { signal: controller.signal },
    );
    assert(response.ok, `events stream returned ${response.status}`);
    assert(response.body, "events stream missing body");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        body += new TextDecoder().decode(value);
        if (pattern.test(body)) {
          controller.abort();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch {
    // Abort after matching is expected.
  } finally {
    clearTimeout(timeout);
  }

  return body;
}

async function main(): Promise<void> {
  process.env.AGENT_GUARD_ASK_TIMEOUT = "demo_approve";
  process.env.AGENT_GUARD_ASK_TIMEOUT_MS = "50";

  const app = await buildApp({ logger: false });
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  try {
    console.log("OpenClaw Realtime MCP Verification");
    console.log(`API: ${baseUrl}`);

    const info = await httpJson<
      ApiResponse<{ tools: { name: string }[]; transport: string; mode: string }>
    >("GET", baseUrl, "/api/v1/openclaw/realtime/mcp");
    assert(info.ok === true, "MCP info endpoint is not ok");
    assert(info.data?.transport === "streamable-http", "transport is not streamable-http");
    assert(
      info.data.tools.some((tool) => tool.name === "agent_guard_read_file"),
      "agent_guard_read_file not exposed",
    );
    console.log(`1. endpoint ok, tools=${info.data.tools.length}`);

    const active = await httpJson<
      ApiResponse<{ resolvedPolicyPackId: string; policyCount: number }>
    >("POST", baseUrl, "/api/v1/openclaw/realtime/active-policy", {
      policyPackId: "fallback",
      resetSessions: true,
    });
    assert(active.ok === true, "active policy endpoint is not ok");
    assert(
      active.data?.resolvedPolicyPackId === "policy_pack.openclaw.realtime.fallback",
      "fallback active policy not set",
    );
    assert((active.data?.policyCount ?? 0) > 0, "active policy has no policies");
    console.log(`1b. active policy ok (${active.data.resolvedPolicyPackId})`);

    const prepared = await httpJson<
      ApiResponse<{ runtimeSessionId: string; policyPackId: string; traceId: string }>
    >("POST", baseUrl, "/api/v1/openclaw/realtime/sessions", {
      policyPackId: active.data.resolvedPolicyPackId,
    });
    assert(prepared.ok === true, "realtime session prepare failed");
    assert(prepared.data?.runtimeSessionId?.startsWith("session."), "backend did not generate session id");
    const runtimeSessionId = prepared.data.runtimeSessionId;
    console.log(`1c. prepared session ok (${runtimeSessionId})`);

    const init = await rpc<{ capabilities: { tools: unknown }; serverInfo: { name: string } }>(
      baseUrl,
      1,
      "initialize",
      { protocolVersion: "2024-11-05" },
    );
    assert(!init.error, `initialize error: ${init.error?.message}`);
    assert(init.result?.capabilities?.tools, "initialize missing tools capability");
    console.log(`2. initialize ok (${init.result.serverInfo.name})`);

    const list = await rpc<{ tools: { name: string }[] }>(baseUrl, 2, "tools/list");
    assert(!list.error, `tools/list error: ${list.error?.message}`);
    const toolNames = list.result?.tools.map((tool) => tool.name) ?? [];
    assert(toolNames.includes("agent_guard_execute_code"), "execute_code tool not listed");
    console.log(`3. tools/list ok (${toolNames.join(", ")})`);

    const denied = await callTool(baseUrl, 3, "agent_guard_read_file", {
      _agentGuardSessionId: runtimeSessionId,
      path: "/secret/.env",
    });
    assert(denied.rpc.result?.isError === true, "secret read should return isError");
    assert(denied.envelope.blocked === true, "secret read should be blocked");
    console.log("4. deny path ok");

    const asked = await callTool(baseUrl, 4, "agent_guard_execute_code", {
      _agentGuardSessionId: runtimeSessionId,
      language: "python",
      code: "import os; os.system('whoami')",
    });
    assert(asked.rpc.result?.isError !== true, "demo-approved ask should continue");
    assert(
      asked.envelope.supervisionRecords.some((record) => record.action === "ask"),
      "ask record missing",
    );
    console.log("5. ask path ok");

    const redacted = await callTool(baseUrl, 5, "agent_guard_call_api", {
      _agentGuardSessionId: runtimeSessionId,
      method: "POST",
      url: "https://safe.example.test/upload",
      body: "token=demo-secret-token",
    });
    assert(redacted.rpc.result?.isError !== true, "redact should not block");
    assert(
      redacted.envelope.supervisionRecords.some((record) => record.action === "redact"),
      "redact record missing",
    );
    console.log("6. redact path ok");

    const session = await httpJson<
      ApiResponse<{
        records: { action: string; targetType: string }[];
        actionCounts: Record<string, number>;
      }>
    >("GET", baseUrl, `/api/v1/supervision/sessions/${runtimeSessionId}`);
    assert(session.ok === true, "supervision session query failed");
    assert((session.data?.actionCounts.deny ?? 0) >= 1, "deny count missing");
    assert((session.data?.actionCounts.ask ?? 0) >= 1, "ask count missing");
    assert((session.data?.actionCounts.redact ?? 0) >= 1, "redact count missing");
    console.log(
      `7. supervision query ok (records=${session.data?.records.length}, deny=${session.data?.actionCounts.deny}, ask=${session.data?.actionCounts.ask}, redact=${session.data?.actionCounts.redact})`,
    );

    const trace = await httpJson<ApiResponse<{ trace: { traceId: string; events: unknown[] } }>>(
      "GET",
      baseUrl,
      `/api/v1/traces/${redacted.envelope.traceId}`,
    );
    assert(trace.ok === true, "trace query failed");
    assert(trace.data?.trace.traceId === redacted.envelope.traceId, "traceId mismatch");
    assert((trace.data?.trace.events.length ?? 0) > 0, "trace events missing");
    console.log(`8. trace query ok (events=${trace.data?.trace.events.length})`);

    const streamBody = await readEventStreamUntil(baseUrl, /event: supervision_decision/);
    assert(
      streamBody.includes("event: supervision_decision"),
      "events stream did not replay supervision_decision",
    );
    assert(streamBody.includes("policy.openclaw.realtime.deny_secret_read"), "events stream missing deny policy");
    console.log("9. realtime events stream ok");

    console.log("OpenClaw realtime MCP supervision verified.");
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
