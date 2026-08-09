import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { AgentConnectionConfig } from "./lib/api/types";
import { agentGuardApi } from "./lib/api/client";
import { mockBundle } from "./lib/api/mockData";
import { RunWorkflowPage } from "./pages/RunWorkflow/RunWorkflowPage";
import {
  DEFAULT_SELECTION_CASE_COUNT,
  MAX_SELECTION_CASE_COUNT,
  MIN_SELECTION_CASE_COUNT,
  SELECTION_CASE_COUNT_PRESETS,
  normalizeSelectionCaseCount,
} from "./selectionDefaults";

test("competition workflow defaults to five selected cases", () => {
  assert.equal(DEFAULT_SELECTION_CASE_COUNT, 5);
});

test("competition workflow caps selection at 120 cases", () => {
  assert.equal(MAX_SELECTION_CASE_COUNT, 120);
  assert.equal(normalizeSelectionCaseCount(120), 120);
  assert.equal(normalizeSelectionCaseCount(121), 120);
  assert.equal(normalizeSelectionCaseCount(500), 120);
});

test("competition workflow keeps the 5, 10, 30, and 120 presets", () => {
  assert.deepEqual(SELECTION_CASE_COUNT_PRESETS, [5, 10, 30, 120]);
});

test("competition workflow renders a 120-case number input maximum", () => {
  const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = reactGlobal.React;
  reactGlobal.React = React;
  const markup = renderToStaticMarkup(React.createElement(RunWorkflowPage, {
    summaryState: {
      status: "ready",
      source: "api",
      data: {
        schemaVersion: "mvp-1",
        recentRunGroups: [],
        totals: {},
        countsByCategory: {},
      },
    } as never,
    selectionPlanState: { status: "idle" },
    selectionCaseCount: DEFAULT_SELECTION_CASE_COUNT,
    running: false,
    planning: false,
    canceling: false,
    onCreateSelectionPlan() {},
    onCancelRun() {},
    onRun() {},
    onSelectionCaseCountChange() {},
  }));
  reactGlobal.React = previousReact;

  assert.match(markup, /<input[^>]*max="120"[^>]*type="number"/);
});

test("OpenClaw selection budgets preserve the 80, 81, and 120 target profiles", async () => {
  const { buildLlmSelectionRequest, selectionTargetProfile } = await import("./App");

  const config = {
    adapterKind: "openclaw",
    agentId: "agent.openclaw.selection-budget",
  } as AgentConnectionConfig;
  assert.equal(selectionTargetProfile(config, 80), "openclaw");
  assert.equal(selectionTargetProfile(config, 81), "regression");
  assert.equal(selectionTargetProfile(config, 120), "regression");
  assert.equal(
    buildLlmSelectionRequest(config, 1).minCaseCount,
    MIN_SELECTION_CASE_COUNT,
  );
  assert.equal(
    buildLlmSelectionRequest(config, 120).minCaseCount,
    MAX_SELECTION_CASE_COUNT,
  );
});

test("run polling retries a transient run-group NOT_FOUND response", async (t) => {
  const appModule = await import("./App");
  const candidate = (appModule as unknown as {
    waitForRunGroup?: (
      runGroupId: string,
      timeoutMs: number,
      onProgress?: (runGroup: typeof mockBundle.runGroup) => void,
      shouldStop?: () => boolean,
      pollIntervalMs?: number,
    ) => Promise<typeof mockBundle.runGroup | undefined>;
  }).waitForRunGroup;
  assert.equal(typeof candidate, "function");

  const original = agentGuardApi.runGroup;
  t.after(() => {
    agentGuardApi.runGroup = original;
  });
  let attempts = 0;
  agentGuardApi.runGroup = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error("Run group run_group.transient not found"), {
        code: "NOT_FOUND",
        status: 404,
      });
    }
    return {
      runGroup: {
        ...mockBundle.runGroup,
        runGroupId: "run_group.transient",
        status: "completed",
      },
    };
  };

  const progress: string[] = [];
  const result = await candidate!(
    "run_group.transient",
    1_000,
    (runGroup) => progress.push(runGroup.status),
    undefined,
    0,
  );

  assert.equal(attempts, 2);
  assert.equal(result?.status, "completed");
  assert.deepEqual(progress, ["completed"]);
});

test("run polling stops after three transient NOT_FOUND retries", async (t) => {
  const { waitForRunGroup } = await import("./App");
  const original = agentGuardApi.runGroup;
  t.after(() => {
    agentGuardApi.runGroup = original;
  });
  let attempts = 0;
  agentGuardApi.runGroup = async () => {
    attempts += 1;
    throw Object.assign(new Error("Run group run_group.missing not found"), {
      code: "NOT_FOUND",
      status: 404,
    });
  };

  await assert.rejects(
    () => waitForRunGroup("run_group.missing", 1_000, undefined, undefined, 0),
    /run_group\.missing not found/,
  );
  assert.equal(attempts, 4);
});

test("run polling does not retry non-NOT_FOUND errors", async (t) => {
  const { waitForRunGroup } = await import("./App");
  const original = agentGuardApi.runGroup;
  t.after(() => {
    agentGuardApi.runGroup = original;
  });
  let attempts = 0;
  agentGuardApi.runGroup = async () => {
    attempts += 1;
    throw Object.assign(new Error("backend unavailable"), {
      code: "INTERNAL_ERROR",
      status: 500,
    });
  };

  await assert.rejects(
    () => waitForRunGroup("run_group.error", 1_000, undefined, undefined, 0),
    /backend unavailable/,
  );
  assert.equal(attempts, 1);
});

test("run polling stays active beyond the former twenty-minute cutoff", async (t) => {
  const appModule = await import("./App");
  const candidate = (appModule as unknown as {
    waitForRunGroup?: (
      runGroupId: string,
      timeoutMs?: number,
      onProgress?: (runGroup: typeof mockBundle.runGroup) => void,
      shouldStop?: () => boolean,
      pollIntervalMs?: number,
    ) => Promise<typeof mockBundle.runGroup | undefined>;
  }).waitForRunGroup;
  assert.equal(typeof candidate, "function");

  const original = agentGuardApi.runGroup;
  const originalNow = Date.now;
  t.after(() => {
    agentGuardApi.runGroup = original;
    Date.now = originalNow;
  });
  let now = 0;
  let attempts = 0;
  Date.now = () => now;
  agentGuardApi.runGroup = async () => {
    attempts += 1;
    const completed = attempts > 1;
    if (!completed) {
      now = 1_200_001;
    }
    return {
      runGroup: {
        ...mockBundle.runGroup,
        runGroupId: "run_group.long-running",
        status: completed ? "completed" : "running",
      },
    };
  };

  const result = await candidate!(
    "run_group.long-running",
    undefined,
    undefined,
    undefined,
    0,
  );

  assert.equal(attempts, 2);
  assert.equal(result?.status, "completed");
});

test("unbounded run polling still exits when cancellation is requested", async (t) => {
  const { waitForRunGroup } = await import("./App");
  const original = agentGuardApi.runGroup;
  t.after(() => {
    agentGuardApi.runGroup = original;
  });
  let attempts = 0;
  let stopChecks = 0;
  agentGuardApi.runGroup = async () => {
    attempts += 1;
    return {
      runGroup: {
        ...mockBundle.runGroup,
        runGroupId: "run_group.cancelled",
        status: "running",
      },
    };
  };

  const result = await waitForRunGroup(
    "run_group.cancelled",
    undefined,
    undefined,
    () => {
      stopChecks += 1;
      return stopChecks > 1;
    },
    0,
  );

  assert.equal(result, undefined);
  assert.equal(attempts, 1);
});

test("run polling keeps an explicit timeout for bounded callers", async (t) => {
  const { waitForRunGroup } = await import("./App");
  const original = agentGuardApi.runGroup;
  const originalNow = Date.now;
  t.after(() => {
    agentGuardApi.runGroup = original;
    Date.now = originalNow;
  });
  let now = 0;
  let attempts = 0;
  Date.now = () => now;
  agentGuardApi.runGroup = async () => {
    attempts += 1;
    now = 1_001;
    return {
      runGroup: {
        ...mockBundle.runGroup,
        runGroupId: "run_group.bounded",
        status: "running",
      },
    };
  };

  const result = await waitForRunGroup(
    "run_group.bounded",
    1_000,
    undefined,
    undefined,
    0,
  );

  assert.equal(result, undefined);
  assert.equal(attempts, 1);
});
