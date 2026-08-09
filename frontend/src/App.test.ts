import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { AgentConnectionConfig } from "./lib/api/types";
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
