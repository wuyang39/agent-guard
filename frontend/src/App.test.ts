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
  MainSupervisionToggleButton,
  REALTIME_EVENT_TYPES,
  nativeStatusFromError,
  openNativeSupervisionStream,
  reconcileNativeStatusAfterStartFailure,
  startMainSupervision,
  stopNativeSupervisionStream,
  stopMainSupervision,
} from "./pages/Supervision/LiveSupervisionPage";
import {
  DEFAULT_SELECTION_CASE_COUNT,
  MAX_SELECTION_CASE_COUNT,
  MIN_SELECTION_CASE_COUNT,
  SELECTION_CASE_COUNT_PRESETS,
  normalizeSelectionCaseCount,
} from "./selectionDefaults";
import { resolveDesktopApiAddress } from "./App";

test("desktop diagnostics derive their endpoint and port from the configured API base", () => {
  assert.deepEqual(resolveDesktopApiAddress("http://127.0.0.1:5199"), {
    apiPort: "5199",
    endpoint: "127.0.0.1:5199",
  });
});

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
    async ensureAccess() {
      order.push("ensure");
    },
    async mintEventCapability() {
      order.push("mint");
    },
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
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["ensure", "mint", "start:policy.frontend.main"]);
  resolveStart?.(mainSupervisionStatus());
  const status = await startPromise;

  assert.equal(status.coverage, "active");
  assert.deepEqual(order, ["ensure", "mint", "start:policy.frontend.main", "open"]);
});

test("event capability mint failure prevents activation and stream opening", async () => {
  const order: string[] = [];

  await assert.rejects(
    () => startMainSupervision("policy.frontend.main", {
      async ensureAccess() {
        order.push("ensure");
      },
      async mintEventCapability() {
        order.push("mint");
        throw new Error("event capability unavailable");
      },
      async start() {
        order.push("start");
        return mainSupervisionStatus();
      },
      openStream() {
        order.push("open");
      },
    }),
    /event capability unavailable/,
  );

  assert.deepEqual(order, ["ensure", "mint"]);
});

test("bootstrap access failure prevents event minting and activation", async () => {
  const order: string[] = [];

  await assert.rejects(
    () => startMainSupervision("policy.frontend.main", {
      async ensureAccess() {
        order.push("ensure");
        throw new Error("browser pairing required");
      },
      async mintEventCapability() {
        order.push("mint");
      },
      async start() {
        order.push("start");
        return mainSupervisionStatus();
      },
      openStream() {
        order.push("open");
      },
    }),
    /browser pairing required/,
  );

  assert.deepEqual(order, ["ensure"]);
});

test("manual stream opening mints event access before constructing EventSource", async () => {
  const order: string[] = [];

  await openNativeSupervisionStream({
    async mintEventCapability() {
      order.push("mint");
    },
    openStream() {
      order.push("open");
    },
  });

  assert.deepEqual(order, ["mint", "open"]);
});

test("manual event mint failure never reports an opened stream", async () => {
  let openCount = 0;

  await assert.rejects(
    () => openNativeSupervisionStream({
      async mintEventCapability() {
        throw new Error("event mint failed");
      },
      openStream() {
        openCount += 1;
      },
    }),
    /event mint failed/,
  );

  assert.equal(openCount, 0);
});

test("stopping while event capability minting is pending prevents a stale stream open", async () => {
  const gate = createLatestOperationGate();
  gate.mount();
  let resolveMint: (() => void) | undefined;
  let openCount = 0;
  let closeCount = 0;

  const pendingOpen = openNativeSupervisionStream({
    mintEventCapability() {
      return new Promise<void>((resolve) => {
        resolveMint = resolve;
      });
    },
    openStream() {
      openCount += 1;
    },
  }, gate.begin());

  stopNativeSupervisionStream(
    () => {
      closeCount += 1;
    },
    () => gate.invalidate(),
  );
  resolveMint?.();
  await pendingOpen;

  assert.equal(closeCount, 1);
  assert.equal(openCount, 0);
});

test("the latest stream reopen wins when event capability mints resolve out of order", async () => {
  const gate = createLatestOperationGate();
  gate.mount();
  const resolvers: Array<() => void> = [];
  const openedModes: string[] = [];

  function reopen(mode: string): Promise<void> {
    return openNativeSupervisionStream({
      mintEventCapability() {
        return new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      },
      openStream() {
        openedModes.push(mode);
      },
    }, gate.begin());
  }

  const first = reopen("live");
  const second = reopen("history");
  resolvers[1]?.();
  await second;
  resolvers[0]?.();
  await first;

  assert.deepEqual(openedModes, ["history"]);
});

test("starting main supervision does not open the stream when activation fails", async () => {
  let openCount = 0;

  await assert.rejects(
    () => startMainSupervision("policy.frontend.main", {
      ...accessCommands(),
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
      ...accessCommands(),
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
    ...accessCommands(),
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
  await assert.rejects(startPromise, /no longer current/);
  assert.equal(openCount, 0);
});

test("stream construction failure preserves active supervision and reports listening separately", async () => {
  let listeningError: unknown;
  const status = await startMainSupervision("policy.frontend.main", {
    ...accessCommands(),
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

test("activation failure refreshes authoritative native status without replacing the start error", async () => {
  const gate = createLatestOperationGate();
  gate.mount();
  const operation = gate.begin();
  const statuses: MainAgentSupervisionStatus[] = [];
  const errors: string[] = [];

  await reconcileNativeStatusAfterStartFailure({
    error: new ApiRequestError("activation gateway timeout", "GATEWAY_TIMEOUT", 503),
    operation,
    async loadStatus() {
      return {
        ...mainSupervisionStatus(),
        coverage: "conditional",
        reasonCode: "LEASE_OWNERSHIP_UNCERTAIN",
      };
    },
    applyStatus(status) {
      statuses.push(status);
    },
    applyError(message) {
      errors.push(message);
    },
  });

  assert.equal(statuses.at(-1)?.coverage, "conditional");
  assert.deepEqual(errors, ["activation gateway timeout"]);
});

test("stale activation failure refresh cannot overwrite a newer operation", async () => {
  const gate = createLatestOperationGate();
  gate.mount();
  const operation = gate.begin();
  let resolveStatus: ((status: MainAgentSupervisionStatus) => void) | undefined;
  const statuses: MainAgentSupervisionStatus[] = [];

  const pending = reconcileNativeStatusAfterStartFailure({
    error: new ApiRequestError("activation failed", "GATEWAY_ERROR", 503),
    operation,
    loadStatus() {
      return new Promise((resolve) => {
        resolveStatus = resolve;
      });
    },
    applyStatus(status) {
      statuses.push(status);
    },
    applyError() {},
  });
  await Promise.resolve();
  gate.begin();
  resolveStatus?.({ ...mainSupervisionStatus(), coverage: "recovery" });
  await pending;

  assert.deepEqual(statuses, []);
});

test("status refresh failure keeps the previous status and original activation error", async () => {
  const gate = createLatestOperationGate();
  gate.mount();
  const statuses: MainAgentSupervisionStatus[] = [];
  const errors: string[] = [];

  await reconcileNativeStatusAfterStartFailure({
    error: new ApiRequestError("activation failed", "GATEWAY_ERROR", 503),
    operation: gate.begin(),
    async loadStatus() {
      throw new Error("status refresh failed");
    },
    applyStatus(status) {
      statuses.push(status);
    },
    applyError(message) {
      errors.push(message);
    },
  });

  assert.deepEqual(statuses, []);
  assert.deepEqual(errors, ["activation failed"]);
});

test("starting main supervision rejects non-active responses without opening the stream", async () => {
  let openCount = 0;

  await assert.rejects(
    () => startMainSupervision("policy.frontend.main", {
      ...accessCommands(),
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

test("active main supervision renders one stop control without internal status details", (t) => {
  const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = reactGlobal.React;
  t.after(() => {
    reactGlobal.React = previousReact;
  });
  reactGlobal.React = React;

  const markup = renderToStaticMarkup(React.createElement(MainSupervisionToggleButton, {
    status: {
      ...mainSupervisionStatus(),
      coverage: "recovery",
      reasonCode: "LEASE_RECONCILIATION_REQUIRED",
      detail: "Gateway lease ownership needs reconciliation.",
    },
    commandPending: false,
    onStart() {},
    onStop() {},
  }));

  assert.match(markup, /停止监督/);
  assert.equal(markup.match(/<button/g)?.length, 1);
  assert.doesNotMatch(
    markup,
    /开始监督|刷新监督|监听事件|停止监听|policy\.frontend|mainLeaseCount|gateway\.frontend|LEASE_RECONCILIATION_REQUIRED/,
  );
});

test("inactive main supervision renders one start control", (t) => {
  const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = reactGlobal.React;
  t.after(() => {
    reactGlobal.React = previousReact;
  });
  reactGlobal.React = React;

  const markup = renderToStaticMarkup(React.createElement(MainSupervisionToggleButton, {
    status: {
      ...mainSupervisionStatus(),
      coverage: "ready",
      policyPackId: undefined,
      leaseId: undefined,
      leaseEpoch: undefined,
      expiresAt: undefined,
      mainLeaseCount: 0,
    },
    commandPending: false,
    onStart() {},
    onStop() {},
  }));

  assert.match(markup, /开始监督/);
  assert.equal(markup.match(/<button/g)?.length, 1);
  assert.doesNotMatch(markup, /停止监督|刷新监督|监听事件|停止监听/);
});

test("pending native command replaces the toggle label and disables it", (t) => {
  const reactGlobal = globalThis as typeof globalThis & { React?: typeof React };
  const previousReact = reactGlobal.React;
  t.after(() => {
    reactGlobal.React = previousReact;
  });
  reactGlobal.React = React;

  const markup = renderToStaticMarkup(React.createElement(MainSupervisionToggleButton, {
    status: mainSupervisionStatus(),
    commandPending: true,
    onStart() {},
    onStop() {},
  }));

  assert.match(markup, /<button[^>]*disabled=""[^>]*>处理中\.\.\.<\/button>/);
  assert.doesNotMatch(markup, /开始监督|停止监督|刷新监督|监听事件|停止监听/);
});

function accessCommands() {
  return {
    async ensureAccess() {},
    async mintEventCapability() {},
  };
}

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

test("local HTTP runtime uses the five-case rule profile", async () => {
  const { buildLlmSelectionRequest, isHttpRuntimeAgent, selectionTargetProfile } =
    await import("./App");
  const config = {
    adapterKind: "http_sample",
    agentId: "agent.http.runtime",
    caseIds: [
      "case.resource_injection",
      "case.tool_response_injection",
      "case.tool_abuse_path_traversal",
      "case.authorization_bypass_admin_api",
      "case.pyrit_memory_context_poisoning",
    ],
  } as AgentConnectionConfig;

  assert.equal(isHttpRuntimeAgent(config), true);
  assert.equal(selectionTargetProfile(config, 120), "smoke");
  assert.deepEqual(buildLlmSelectionRequest(config, 120), {
    schemaVersion: "mvp-1",
    agentId: "agent.http.runtime",
    manifestId: "corpus_manifest.derived.local_config",
    targetProfile: "smoke",
    selectionMode: "rule_only",
    maxCaseCount: 5,
    minCaseCount: 5,
    requiredAttackFamilies: [
      "prompt_injection",
      "data_leakage",
      "tool_hijack",
    ],
    requiredTargetSurfaces: ["tool_call", "file_access"],
    preferredCaseIds: [
      "case.resource_injection",
      "case.tool_response_injection",
      "case.tool_abuse_path_traversal",
      "case.authorization_bypass_admin_api",
      "case.pyrit_memory_context_poisoning",
    ],
    includeExternalTools: true,
    adapterKind: "http_sample",
  });
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
