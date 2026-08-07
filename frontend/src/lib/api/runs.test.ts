import assert from "node:assert/strict";
import test from "node:test";
import { mockBundle } from "./mockData";
import { runsApi } from "./runs";
import type { CLineRunGroup } from "./types";

const sessionCoverage = {
  sessionKey: "agent:main:run.frontend.coverage",
  leaseId: "lease.frontend.coverage",
  leaseEpoch: 6,
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
});
