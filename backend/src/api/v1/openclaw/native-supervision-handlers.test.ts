import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  MainAgentSupervisionServiceError,
  type MainAgentSupervisionService,
  type MainAgentSupervisionStatus,
} from "../../../modules/openclaw/mainAgentSupervisionService";
import { openClawNativeSupervisionRoutes } from "./native-supervision-handlers";

test("native supervision routes expose only public service status without a control token", async () => {
  const calls: string[] = [];
  const app = await routeApp(serviceFixture({ calls }));

  const initial = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
  });
  const started = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/start",
    payload: { policyPackId: "policy.main" },
  });
  const stopped = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
  });

  assert.equal(initial.statusCode, 200);
  assert.equal(started.statusCode, 200);
  assert.equal(stopped.statusCode, 200);
  assert.deepEqual(calls, ["status", "start:policy.main", "stop"]);
  assert.deepEqual(responseData(started), activeStatus());
  assert.doesNotMatch(started.body, /credential|control.?token|secret/i);
  await app.close();
});

test("start accepts only an exact bounded policyPackId body", async () => {
  const app = await routeApp(serviceFixture());
  for (const payload of [
    undefined,
    {},
    { policyPackId: "" },
    { policyPackId: "x".repeat(257) },
    { policyPackId: "policy.main", agentId: "main" },
    { policyPackId: "policy.main", controlToken: "secret" },
  ]) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/openclaw/native-supervision/start",
      ...(payload === undefined ? {} : { payload }),
    });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(response.json().error.code, "MAIN_AGENT_SUPERVISION_INVALID_REQUEST");
  }
  await app.close();
});

test("stop accepts no body or an exact empty object", async () => {
  const app = await routeApp(serviceFixture());

  const absent = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
  });
  const empty = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
    payload: {},
  });
  const additional = await app.inject({
    method: "POST",
    url: "/api/v1/openclaw/native-supervision/stop",
    payload: { agentId: "main" },
  });

  assert.equal(absent.statusCode, 200);
  assert.equal(empty.statusCode, 200);
  assert.equal(additional.statusCode, 400);
  assert.equal(additional.json().error.code, "MAIN_AGENT_SUPERVISION_INVALID_REQUEST");
  await app.close();
});

test("stable service errors map to their 400, 409, and 503 responses", async () => {
  for (const statusCode of [400, 409, 503] as const) {
    const service = serviceFixture();
    service.start = async () => {
      throw new MainAgentSupervisionServiceError(
        `MAIN_AGENT_SUPERVISION_${String(statusCode)}`,
        statusCode,
        `stable ${String(statusCode)}`,
      );
    };
    const app = await routeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/openclaw/native-supervision/start",
      payload: { policyPackId: "policy.main" },
    });

    assert.equal(response.statusCode, statusCode);
    assert.deepEqual(response.json().error, {
      code: `MAIN_AGENT_SUPERVISION_${String(statusCode)}`,
      message: `stable ${String(statusCode)}`,
    });
    await app.close();
  }
});

test("unexpected dependency failures are sanitized as unavailable", async () => {
  const service = serviceFixture();
  service.status = async () => {
    throw new Error("secret gateway token leaked");
  };
  const app = await routeApp(service);

  const response = await app.inject({
    method: "GET",
    url: "/api/v1/openclaw/native-supervision",
  });

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "MAIN_AGENT_SUPERVISION_UNAVAILABLE");
  assert.doesNotMatch(response.body, /secret|gateway token/i);
  await app.close();
});

async function routeApp(service: MainAgentSupervisionService) {
  const app = Fastify({ logger: false });
  await app.register(openClawNativeSupervisionRoutes, { service });
  return app;
}

function serviceFixture(options: { calls?: string[] } = {}): MainAgentSupervisionService {
  return {
    async status() {
      options.calls?.push("status");
      return idleStatus();
    },
    async start(policyPackId) {
      options.calls?.push(`start:${policyPackId}`);
      return activeStatus();
    },
    async stop() {
      options.calls?.push("stop");
      return idleStatus();
    },
    async close() {},
  };
}

function idleStatus(): MainAgentSupervisionStatus {
  return {
    coverage: "ready",
    scope: { kind: "agent", agentId: "main" },
    activeLeaseCount: 0,
    mainLeaseCount: 0,
  };
}

function activeStatus(): MainAgentSupervisionStatus {
  return {
    coverage: "active",
    scope: { kind: "agent", agentId: "main" },
    policyPackId: "policy.main",
    leaseId: "lease-1",
    leaseEpoch: 1,
    expiresAt: "2026-08-10T00:05:00.000Z",
    gatewayInstanceId: "gateway.instance.test",
    activeLeaseCount: 1,
    mainLeaseCount: 1,
  };
}

function responseData(response: { json(): unknown }): unknown {
  return (response.json() as { data: unknown }).data;
}
