import assert from "node:assert/strict";
import http from "node:http";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import type { NativeSupervisionAccessService } from "../../../modules/openclaw/nativeSupervisionAccessService";
import {
  emitNativeToolHookEvent,
  subscribeRealtimeEvents,
} from "../../../modules/openclaw/realtimeMcpServer";
import {
  NATIVE_SUPERVISION_CONTROL_COOKIE,
  NATIVE_SUPERVISION_EVENTS_COOKIE,
} from "./native-supervision-handlers";
import { openClawRealtimeMcpRoutes } from "./realtime-mcp-handlers";

const ALLOWED_ORIGIN = "http://127.0.0.1:5173";
const EVENT_TOKEN = "e".repeat(43);

test("realtime events reject missing, null, and malicious origins before subscribing", async (t) => {
  const fixture = await startFixture(t);

  for (const origin of [undefined, "null", `${ALLOWED_ORIGIN}.evil`, "https://127.0.0.1:5173"]) {
    const response = await requestUntil(fixture.url, {
      headers: {
        ...(origin === undefined ? {} : { origin }),
        cookie: `${NATIVE_SUPERVISION_EVENTS_COOKIE}=${EVENT_TOKEN}`,
      },
      stopWhen: firstFrameOrEnd,
    });
    assert.equal(response.statusCode, 403, String(origin));
    assert.equal(JSON.parse(response.body).error.code, "NATIVE_SUPERVISION_ORIGIN_FORBIDDEN");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  }
  assert.equal(fixture.subscribeCalls(), 0);
});

test("realtime events require the read-only event cookie before subscribing", async (t) => {
  const fixture = await startFixture(t);

  for (const cookie of [
    undefined,
    `${NATIVE_SUPERVISION_EVENTS_COOKIE}=${"x".repeat(43)}`,
    `${NATIVE_SUPERVISION_CONTROL_COOKIE}=${EVENT_TOKEN}`,
  ]) {
    const response = await requestUntil(fixture.url, {
      headers: {
        origin: ALLOWED_ORIGIN,
        ...(cookie === undefined ? {} : { cookie }),
      },
      stopWhen: firstFrameOrEnd,
    });
    assert.equal(response.statusCode, 401, String(cookie));
    assert.equal(JSON.parse(response.body).error.code, "NATIVE_SUPERVISION_ACCESS_REQUIRED");
  }
  assert.equal(fixture.subscribeCalls(), 0);
});

test("authorized realtime events echo the exact origin and stream native guard hooks", async (t) => {
  const fixture = await startFixture(t);
  let emitted = false;
  const response = await requestUntil(fixture.url, {
    headers: {
      origin: ALLOWED_ORIGIN,
      cookie: `${NATIVE_SUPERVISION_EVENTS_COOKIE}=${EVENT_TOKEN}`,
    },
    onBody(body) {
      if (emitted || !body.includes("event: config")) return;
      emitted = true;
      emitNativeToolHookEvent({
        runtimeSessionId: "agent:main:cli:sse-auth-test",
        toolCallId: "call.sse-auth-test",
        toolName: "read",
        action: "deny",
        coverage: "active",
        detail: { source: "native_guard" },
      });
    },
    stopWhen: (body) => (
      body.includes("event: native_tool_hook") &&
      body.includes('"toolId":"call.sse-auth-test"')
    ),
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], ALLOWED_ORIGIN);
  assert.equal(response.headers["access-control-allow-credentials"], "true");
  assert.match(String(response.headers.vary), /(?:^|,\s*)Origin(?:,|$)/i);
  assert.notEqual(response.headers["access-control-allow-origin"], "*");
  assert.match(response.body, /event: native_tool_hook/);
  assert.match(response.body, /"runtimeSessionId":"agent:main:cli:sse-auth-test"/);
  assert.match(response.body, /"toolId":"call.sse-auth-test"/);
  assert.match(response.body, /"source":"native_guard"/);
  assert.equal(fixture.subscribeCalls(), 1);
});

async function startFixture(t: TestContext): Promise<{
  url: string;
  subscribeCalls(): number;
}> {
  let calls = 0;
  const app = Fastify({ logger: false });
  await app.register(openClawRealtimeMcpRoutes, {
    accessService: accessServiceFixture(),
    allowedOrigins: [ALLOWED_ORIGIN],
    subscribeEvents(listener, options) {
      calls += 1;
      return subscribeRealtimeEvents(listener, options);
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${String(address.port)}/api/v1/openclaw/realtime/events/stream?replay=0`,
    subscribeCalls: () => calls,
  };
}

function accessServiceFixture(): NativeSupervisionAccessService {
  return {
    exchangeBootstrap: () => undefined,
    issueEventCapability: () => undefined,
    authenticateControl: () => false,
    authenticateEvents: (token) => token === EVENT_TOKEN,
  };
}

function firstFrameOrEnd(body: string, ended: boolean): boolean {
  return ended || body.includes("\n\n");
}

function requestUntil(
  url: string,
  options: {
    headers: http.OutgoingHttpHeaders;
    stopWhen(body: string, ended: boolean): boolean;
    onBody?(body: string): void;
  },
): Promise<{
  statusCode: number | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: http.IncomingMessage | undefined;
    const timeout = setTimeout(() => finish(new Error("Timed out waiting for SSE response")), 3_000);
    const request = http.get(url, { headers: options.headers }, (incoming) => {
      response = incoming;
      incoming.setEncoding("utf8");
      let body = "";
      incoming.on("data", (chunk: string) => {
        body += chunk;
        options.onBody?.(body);
        if (options.stopWhen(body, false)) finish(undefined, body);
      });
      incoming.on("end", () => {
        if (options.stopWhen(body, true)) finish(undefined, body);
      });
      incoming.on("error", (error) => {
        if (!settled) finish(error);
      });
    });
    request.on("error", (error) => {
      if (!settled) finish(error);
    });

    function finish(error?: Error, body = ""): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = response
        ? { statusCode: response.statusCode, headers: response.headers, body }
        : undefined;
      response?.destroy();
      request.destroy();
      if (error || !result) reject(error ?? new Error("SSE response did not start"));
      else resolve(result);
    }
  });
}
