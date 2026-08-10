import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { AgentConnectionConfig, MainAgentSupervisionStatus } from "./lib/api/types";
import { agentGuardApi } from "./lib/api/client";
import { ApiRequestError } from "./lib/api/core";
import { mockBundle } from "./lib/api/mockData";
import {
  createLatestOperationGate,
  createRealtimeStreamController,
} from "./lib/models/realtime";
import { RunWorkflowPage } from "./pages/RunWorkflow/RunWorkflowPage";
import {
  MainSupervisionStatusPanel,
  REALTIME_EVENT_TYPES,
  nativeStatusFromError,
  startMainSupervision,
  stopMainSupervision,
} from "./pages/Supervision/LiveSupervisionPage";
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

test("live supervision subscribes to native tool hook events", () => {
  assert.ok(REALTIME_EVENT_TYPES.includes("native_tool_hook"));
});

test("starting main supervision opens the stream only after active coverage resolves", async () => {
  const order: string[] = [];
  let resolveStart: ((status: MainAgentSupervisionStatus) => void) | undefined;
  const startPromise = startMainSupervision("policy.frontend.main", {
    start(policyPackId) {
      order.push(`start:${policyPackId}`);
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    },
    openStream() {
      order.push("open");
    },
  });

  await Promise.resolve();
  assert.deepEqual(order, ["start:policy.frontend.main"]);
  resolveStart?.(mainSupervisionStatus());
  const status = await startPromise;

  assert.equal(status.coverage, "active");
  assert.deepEqual(order, ["start:policy.frontend.main", "open"]);
});

test("starting main supervision does not open the stream when activation fails", async () => {
  let openCount = 0;

  await assert.rejects(
    () => startMainSupervision("policy.frontend.main", {
      async start() {
        throw new Error("gateway unavailable");
      },
      openStream() {
        openCount += 1;
      },
    }),
    /gateway unavailable/,
  );

  assert.equal(openCount, 0);
});

test("an HTTP 503 error cannot be mistaken for a native supervision status", async () => {
  assert.equal(
    nativeStatusFromError(new ApiRequestError("gateway unavailable", "GATEWAY_ERROR", 503)),
    undefined,
  );

  let thrown: unknown;
  try {
    await startMainSupervision("policy.frontend.main", {
      async start() {
        return {
          ...mainSupervisionStatus(),
          coverage: "conditional",
          reasonCode: "LEASE_RECOVERY_REQUIRED",
        };
      },
      openStream() {},
    });
  } catch (error) {
    thrown = error;
  }
  assert.deepEqual(nativeStatusFromError(thrown), {
    ...mainSupervisionStatus(),
    coverage: "conditional",
    reasonCode: "LEASE_RECOVERY_REQUIRED",
  });
});

test("a deferred start cannot open SSE after its lifecycle is invalidated", async () => {
  const gate = createLatestOperationGate();
  gate.mount();
  const operation = gate.begin();
  let resolveStart: ((status: MainAgentSupervisionStatus) => void) | undefined;
  let openCount = 0;

  const startPromise = startMainSupervision("policy.frontend.main", {
    start() {
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    },
    openStream() {
      openCount += 1;
    },
  }, operation);

  gate.dispose();
  resolveStart?.(mainSupervisionStatus());
  await startPromise;
  assert.equal(openCount, 0);
});

test("stream construction failure preserves active supervision and reports listening separately", async () => {
  let listeningError: unknown;
  const status = await startMainSupervision("policy.frontend.main", {
    async start() {
      return mainSupervisionStatus();
    },
    openStream() {
      throw new Error("ask stream construction failed");
    },
    onListeningError(error) {
      listeningError = error;
    },
  });

  assert.equal(status.coverage, "active");
  assert.match(String(listeningError), /ask stream construction failed/);
});

test("starting main supervision rejects non-active responses without opening the stream", async () => {
  let openCount = 0;

  await assert.rejects(
    () => startMainSupervision("policy.frontend.main", {
      async start() {
        return {
          ...mainSupervisionStatus(),
          coverage: "conditional",
          mainLeaseCount: 1,
          reasonCode: "LEASE_RECOVERY_REQUIRED",
        };
      },
      openStream() {
        openCount += 1;
      },
    }),
    /LEASE_RECOVERY_REQUIRED/,
  );

  assert.equal(openCount, 0);
});

test("stopping main supervision leaves an existing event stream open", async () => {
  let closeCount = 0;
  const stream = createRealtimeStreamController({
    eventTypes: [],
    createEventSource() {
      return {
        onerror: null,
        addEventListener() {},
        close() {
          closeCount += 1;
        },
      };
    },
    onEvent() {},
    onAskConfig() {},
    onAskDecision() {},
    onAskResolved() {},
    onError() {},
    onStreamingChange() {},
  });
  stream.open({
    mainUrl: "http://main.test/events",
    askUrl: "http://main.test/asks",
    runtimeSessionId: "runtime.synthetic",
    includeHistory: false,
  });

  const status = await stopMainSupervision(async () => ({
    ...mainSupervisionStatus(),
    coverage: "off",
    mainLeaseCount: 0,
  }));

  assert.equal(status.coverage, "off");
  assert.equal(stream.isOpen(), true);
  assert.equal(closeCount, 0);
  stream.close();
});

test("main supervision status panel renders scope, lease state, diagnostics, and controls", (t) => {
  const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = reactGlobal.React;
  t.after(() => {
    reactGlobal.React = previousReact;
  });
  reactGlobal.React = React;

  const markup = renderToStaticMarkup(React.createElement(MainSupervisionStatusPanel, {
    status: {
      ...mainSupervisionStatus(),
      coverage: "recovery",
      reasonCode: "LEASE_RECONCILIATION_REQUIRED",
      detail: "Gateway lease ownership needs reconciliation.",
    },
    commandPending: false,
    streaming: true,
    onRefresh() {},
    onStart() {},
    onStartListening() {},
    onStop() {},
    onStopListening() {},
  }));

  for (const expected of [
    "开始监督",
    "停止监督",
    "停止监听",
    "main Agent 全部当前/未来会话",
    "recovery",
    "policy.frontend.main",
    "mainLeaseCount",
    "1",
    "activeLeaseCount",
    "2",
    "gateway.frontend",
    "2026",
    "LEASE_RECONCILIATION_REQUIRED",
    "Gateway lease ownership needs reconciliation.",
  ]) {
    assert.match(markup, new RegExp(expected));
  }
});

test("main supervision status panel can restart SSE listening independently", (t) => {
  const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = reactGlobal.React;
  t.after(() => {
    reactGlobal.React = previousReact;
  });
  reactGlobal.React = React;

  const markup = renderToStaticMarkup(React.createElement(MainSupervisionStatusPanel, {
    status: mainSupervisionStatus(),
    commandPending: false,
    streaming: false,
    onRefresh() {},
    onStart() {},
    onStop() {},
    onStartListening() {},
    onStopListening() {},
  }));

  assert.match(markup, /监听事件/);
  assert.match(markup, /开始监督/);
});

test("pending native commands disable start, stop, and native status refresh", (t) => {
  const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = reactGlobal.React;
  t.after(() => {
    reactGlobal.React = previousReact;
  });
  reactGlobal.React = React;

  const markup = renderToStaticMarkup(React.createElement(MainSupervisionStatusPanel, {
    status: mainSupervisionStatus(),
    commandPending: true,
    streaming: true,
    onRefresh() {},
    onStart() {},
    onStop() {},
    onStartListening() {},
    onStopListening() {},
  }));

  assert.match(markup, /<button[^>]*disabled=""[^>]*>处理中\.\.\.<\/button>/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>停止监督<\/button>/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>刷新监督<\/button>/);
});

function mainSupervisionStatus(): MainAgentSupervisionStatus {
  return {
    coverage: "active",
    scope: { kind: "agent", agentId: "main" },
    policyPackId: "policy.frontend.main",
    leaseId: "lease.frontend.main",
    leaseEpoch: 8,
    expiresAt: "2026-08-10T08:30:00.000Z",
    gatewayInstanceId: "gateway.frontend",
    activeLeaseCount: 2,
    mainLeaseCount: 1,
  };
}

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
