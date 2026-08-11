import assert from "node:assert/strict";
import test from "node:test";
import { mockBundle } from "./mockData";
import { runsApi } from "./runs";
import { agentsApi } from "./agents";
import { ApiRequestError } from "./core";
import type { CLineRunGroup } from "./types";

const sessionCoverage = {
  sessionKey: "agent:main:run.frontend.coverage",
  leaseId: "lease.frontend.coverage",
  leaseEpoch: 6,
  testRunIds: ["run.frontend.coverage"],
  eventsTotal: 3,
  reconciled: false,
  coverageBreachCount: 0,
  mismatchCount: 2,
  revokeError: "plugin did not acknowledge revoke",
} satisfies NonNullable<CLineRunGroup["nativeGuardCoverage"]>["sessions"][number];

const nativeGuardCoverage = {
  coverage: "conditional",
  eventsTotal: 3,
  reconciled: false,
  coverageBreachCount: 0,
  mismatchCount: 2,
  sessions: [sessionCoverage],
  runtimeFailures: [],
  leaseId: sessionCoverage.leaseId,
  leaseEpoch: sessionCoverage.leaseEpoch,
} satisfies NonNullable<CLineRunGroup["nativeGuardCoverage"]>;

test("run group API preserves authoritative per-session native guard coverage", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = (async () => ({
    async json() {
      return {
        ok: true,
        data: {
          runGroup: {
            runGroupId: "run_group.frontend.coverage",
            agentId: "agent.frontend.coverage",
            agentName: "Frontend coverage",
            adapterKind: "openclaw",
            status: "failed",
            phase: "failed",
            startedAt: "2026-08-07T00:00:00.000Z",
            caseIds: ["case.frontend.coverage"],
            caseCount: 1,
            testRunIds: ["run.frontend.coverage"],
            traceIds: ["trace.frontend.coverage"],
            riskReportIds: [],
            runtimeSessionIds: [],
            artifactIds: [],
            nativeGuardCoverage,
          },
        },
      };
    },
  })) as unknown as typeof fetch;

  const result = await runsApi.runGroup("run_group.frontend.coverage");
  assert.deepEqual(result.runGroup.nativeGuardCoverage, nativeGuardCoverage);
});

test("frontend mock run includes structured native guard session coverage", () => {
  const coverage = mockBundle.runGroup.nativeGuardCoverage;
  assert.ok(coverage);
  assert.equal(coverage.sessions.length, 1);
  assert.equal(coverage.leaseId, coverage.sessions[0]?.leaseId);
  assert.equal(coverage.leaseEpoch, coverage.sessions[0]?.leaseEpoch);
  assert.deepEqual(coverage.runtimeFailures, []);
});

test("run group API defensively normalizes legacy native guard coverage", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = (async () => ({
    async json() {
      return {
        ok: true,
        data: {
          runGroup: {
            runGroupId: "run_group.frontend.legacy-coverage",
            agentId: "agent.frontend.legacy-coverage",
            adapterKind: "openclaw",
            status: "failed",
            phase: "failed",
            startedAt: "2026-08-07T02:11:52.248Z",
            caseCount: 1,
            testRunIds: [],
            traceIds: [],
            riskReportIds: [],
            runtimeSessionIds: [],
            artifactIds: [],
            nativeGuardCoverage: {
              coverage: "misconfigured",
              eventsTotal: 0,
              reconciled: false,
              coverageBreachCount: 0,
            },
          },
        },
      };
    },
  })) as unknown as typeof fetch;

  const result = await runsApi.runGroup("run_group.frontend.legacy-coverage");
  assert.deepEqual(result.runGroup.nativeGuardCoverage, {
    coverage: "misconfigured",
    eventsTotal: 0,
    reconciled: false,
    coverageBreachCount: 0,
    mismatchCount: 0,
    sessions: [],
    runtimeFailures: [],
  });
});

test("run group API errors preserve the backend code and HTTP status", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = (async () => ({
    status: 404,
    async json() {
      return {
        ok: false,
        error: {
          code: "NOT_FOUND",
          message: "Run group run_group.transient not found",
        },
      };
    },
  })) as unknown as typeof fetch;

  await assert.rejects(
    () => runsApi.runGroup("run_group.transient"),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal((error as { code?: string }).code, "NOT_FOUND");
      assert.equal((error as { status?: number }).status, 404);
      return true;
    },
  );
});

test("OpenClaw API defaults use the competition 90-second timeout", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let runPayload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    if (init?.method === "POST") {
      runPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return {
        async json() {
          return { ok: true, data: { runGroup: {} } };
        },
      };
    }
    return {
      async json() {
        return {
          ok: true,
          data: { agents: [{}], activeAgent: {} },
        };
      },
    };
  }) as unknown as typeof fetch;

  const agents = await agentsApi.agents();
  assert.equal(agents.activeAgent.timeoutMs, 90_000);
  await runsApi.runE2E();
  assert.equal(
    (runPayload?.connection as { timeoutMs?: number } | undefined)?.timeoutMs,
    90_000,
  );
});
