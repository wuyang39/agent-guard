# OpenClaw Per-Case Sandbox Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Let one OpenClaw RunGroup execute up to 120 cases through one healthy Gateway while attesting and deleting each completed session container before the next case.

**Architecture:** Add an idempotent per-session attestation-and-removal boundary to \`DetectionSandboxManager\`, then pass that boundary into each E2E detection attempt before its risk report is committed. A run-scoped runtime controller owns the replaceable manager/adapter pair so a genuine Gateway runtime failure can rebuild the runtime and retry only the current uncommitted case once.

**Tech Stack:** TypeScript, Node test runner, Fastify, React/Vite, OpenClaw controlled fork, Docker

---

## Workspace Constraint

The working tree already contains approved fast-detection edits in several files used by this plan. Preserve those edits and work with them. Never stage or commit the existing deletion of \`docs/p4-native-tool-bypass-defense-plan.md\`. Before every commit, run \`git diff --cached --name-status\` and confirm that deletion is absent.

## File Structure

- Modify \`backend/src/modules/openclaw/detectionSandboxManager.ts\`: exact session-container attestation, removal, verification, and idempotent tombstones.
- Modify \`backend/src/modules/openclaw/detectionSandboxManager.test.ts\`: exact-container cleanup and fail-closed identity behavior.
- Create \`backend/src/services/openclawDetectionRuntime.ts\`: current replaceable manager/adapter runtime without RunGroup or report responsibilities.
- Create \`backend/src/services/openclawDetectionRuntime.test.ts\`: lazy start, restart, attempt wrapping, and disposal.
- Modify \`backend/src/services/e2eRunService.ts\`: 120-case limit, per-case finalizer, runtime retry, evidence aggregation, and removal of end-of-run container attestation.
- Modify \`backend/src/services/e2eRunService.test.ts\`: commit ordering, classification, aggregation, and limits.
- Modify \`backend/src/api/types.ts\` and \`frontend/src/lib/api/types.ts\`: stable runtime-failure category.
- Modify \`frontend/src/App.tsx\`, \`frontend/src/App.test.ts\`, and \`frontend/src/pages/RunWorkflow/RunWorkflowPage.tsx\`: 120-case product limit.
- Modify \`docs/C/openclaw-detection-live-runbook.md\`: live acceptance.

### Task 1: Add exact per-session container cleanup

**Files:**
- Modify: \`backend/src/modules/openclaw/detectionSandboxManager.ts\`
- Test: \`backend/src/modules/openclaw/detectionSandboxManager.test.ts\`

- [ ] **Step 1: Write failing manager tests**

Add tests using the existing command-runner fixtures:

~~~ts
test("attestAndCleanupSession removes only the attested session container", async () => {
  const fixture = managerWithSessionContainers({
    sessions: [
      { sessionKey: "agent:main:run.one", containerId: "container-one" },
      { sessionKey: "agent:main:run.two", containerId: "container-two" },
    ],
  });

  const evidence = await fixture.manager.attestAndCleanupSession("agent:main:run.one");

  assert.equal(evidence.containerId, "container-one");
  assert.deepEqual(fixture.removedIds, ["container-one"]);
  assert.deepEqual(fixture.remainingIds(), ["container-two"]);
});

test("attestAndCleanupSession is idempotent after verified removal", async () => {
  const fixture = managerWithSessionContainers({
    sessions: [{ sessionKey: "agent:main:run.one", containerId: "container-one" }],
  });
  const first = await fixture.manager.attestAndCleanupSession("agent:main:run.one");
  const second = await fixture.manager.attestAndCleanupSession("agent:main:run.one");
  assert.deepEqual(second, first);
  assert.equal(fixture.removeCalls, 1);
});

test("attestAndCleanupSession rejects an ambiguous session identity", async () => {
  const fixture = managerWithSessionContainers({
    sessions: [
      { sessionKey: "agent:main:run.one", containerId: "container-one" },
      { sessionKey: "agent:main:run.one", containerId: "container-copy" },
    ],
  });
  await assert.rejects(
    fixture.manager.attestAndCleanupSession("agent:main:run.one"),
    (error: unknown) =>
      error instanceof SandboxAttestationError &&
      error.code === "CONTAINER_ATTESTATION_MISMATCH",
  );
  assert.equal(fixture.removeCalls, 0);
});

test("attestAndCleanupSession fails when exact removal cannot be verified", async () => {
  const fixture = managerWithSessionContainers({
    sessions: [{ sessionKey: "agent:main:run.one", containerId: "container-one" }],
    keepAfterRemove: true,
  });
  await assert.rejects(
    fixture.manager.attestAndCleanupSession("agent:main:run.one"),
    /still exists after removal/,
  );
});
~~~

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

~~~powershell
node --import tsx --test --test-name-pattern "attestAndCleanupSession" backend/src/modules/openclaw/detectionSandboxManager.test.ts
~~~

Expected: FAIL because \`attestAndCleanupSession\` and its fixture do not exist.

- [ ] **Step 3: Implement idempotent exact-container cleanup**

Add:

~~~ts
private readonly cleanedSessionEvidence = new Map<string, DetectionSandboxEvidence>();

async attestAndCleanupSession(sessionKey: string): Promise<DetectionSandboxEvidence> {
  const existing = this.cleanedSessionEvidence.get(sessionKey);
  if (existing) return cloneDetectionSandboxEvidence(existing);

  return this.runWhileGatewayAlive(async () => {
    const evidence = await this.attestSessionWhileAlive(sessionKey, "after");
    const containerId = evidence.containerId;
    if (!containerId) {
      throw new SandboxAttestationError(
        "CONTAINER_ATTESTATION_MISMATCH",
        "Attested session " + sessionKey + " did not resolve an exact container.",
      );
    }

    const removed = await this.command("docker", ["rm", "-f", containerId]);
    if (removed.exitCode !== 0) {
      throw new SandboxAttestationError(
        "SESSION_CONTAINER_CLEANUP_FAILED",
        "Attested session container " + containerId + " could not be removed.",
      );
    }

    const verify = await this.command("docker", [
      "inspect", "--format", "{{.Id}}", containerId,
    ]);
    if (verify.exitCode === 0) {
      throw new SandboxAttestationError(
        "SESSION_CONTAINER_CLEANUP_FAILED",
        "Attested session container " + containerId + " still exists after removal.",
      );
    }

    const accepted = cloneDetectionSandboxEvidence(evidence);
    this.cleanedSessionEvidence.set(sessionKey, accepted);
    return cloneDetectionSandboxEvidence(accepted);
  });
}
~~~

Add a clone helper that copies the complete evidence object. Keep full \`cleanup()\` unchanged as the final residual-resource sweep.

- [ ] **Step 4: Run manager tests**

~~~powershell
node --import tsx --test --test-name-pattern "attestAndCleanupSession|container attestation|cleanup" backend/src/modules/openclaw/detectionSandboxManager.test.ts
~~~

Expected: all selected tests PASS.

- [ ] **Step 5: Commit the manager boundary**

~~~powershell
git add -- backend/src/modules/openclaw/detectionSandboxManager.ts backend/src/modules/openclaw/detectionSandboxManager.test.ts
git diff --cached --name-status
git commit -m "feat: clean attested OpenClaw session containers"
~~~

### Task 2: Add a replaceable run-scoped runtime controller

**Files:**
- Create: \`backend/src/services/openclawDetectionRuntime.ts\`
- Create: \`backend/src/services/openclawDetectionRuntime.test.ts\`

- [ ] **Step 1: Write failing controller tests**

~~~ts
test("runtime controller reuses a healthy runtime and replaces it on restart", async () => {
  const started: number[] = [];
  const disposed: number[] = [];
  const controller = createOpenClawDetectionRuntimeController({
    async start() {
      const generation = started.length + 1;
      started.push(generation);
      return fakeRuntime(generation, () => disposed.push(generation));
    },
  });

  assert.equal(await controller.run((runtime) => runtime.generation), 1);
  assert.equal(await controller.run((runtime) => runtime.generation), 1);
  await controller.restart();
  assert.equal(await controller.run((runtime) => runtime.generation), 2);
  await controller.dispose();

  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(disposed, [1, 2]);
});

test("runtime controller disposal is idempotent", async () => {
  let disposed = 0;
  const controller = createOpenClawDetectionRuntimeController({
    async start() { return fakeRuntime(1, () => { disposed += 1; }); },
  });
  await controller.run(async () => "ok");
  await controller.dispose();
  await controller.dispose();
  assert.equal(disposed, 1);
});
~~~

- [ ] **Step 2: Run and confirm failure**

~~~powershell
node --import tsx --test backend/src/services/openclawDetectionRuntime.test.ts
~~~

Expected: FAIL because the controller module does not exist.

- [ ] **Step 3: Implement the controller**

Create these public types and operations:

~~~ts
export type OpenClawDetectionRuntime = {
  generation: number;
  manager: DetectionSandboxManager;
  adapter: AgentAdapter;
  eventStore: NativeGuardEventStore;
  preflightEvidence: DetectionSandboxEvidence;
};

export function createOpenClawDetectionRuntimeController(options: {
  start(): Promise<OpenClawDetectionRuntime>;
}) {
  let current: OpenClawDetectionRuntime | undefined;
  let disposed = false;

  const ensure = async () => {
    if (disposed) throw new Error("OpenClaw detection runtime is disposed.");
    current ??= await options.start();
    return current;
  };

  return {
    async run<T>(
      operation: (runtime: OpenClawDetectionRuntime, signal: AbortSignal) => Promise<T>,
    ) {
      const runtime = await ensure();
      return runtime.manager.runWhileGatewayAlive(
        (signal) => operation(runtime, signal),
      );
    },
    async restart() {
      if (current) await current.manager.cleanup();
      current = undefined;
      return ensure();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const runtime = current;
      current = undefined;
      if (runtime) await runtime.manager.cleanup();
    },
    current() { return current; },
  };
}
~~~

Export a concrete native event-store alias from \`nativeGuardEventStore.ts\` if the current module only exposes an inferred factory return type.

- [ ] **Step 4: Run controller tests**

~~~powershell
node --import tsx --test backend/src/services/openclawDetectionRuntime.test.ts
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add -- backend/src/services/openclawDetectionRuntime.ts backend/src/services/openclawDetectionRuntime.test.ts backend/src/storage/nativeGuardEventStore.ts
git diff --cached --name-status
git commit -m "feat: manage replaceable OpenClaw detection runtime"
~~~

### Task 3: Finalize each guarded attempt before committing its result

**Files:**
- Modify: \`backend/src/services/e2eRunService.ts\`
- Test: \`backend/src/services/e2eRunService.test.ts\`

- [ ] **Step 1: Write failing commit-boundary tests**

~~~ts
test("guarded session cleanup completes before a detection attempt is accepted", async () => {
  const order: string[] = [];
  const evidence = await finalizeGuardedDetectionSession({
    nativeGuardRuntime: nativeRuntimeEvidence({
      sessionKey: "agent:main:run.one",
      reconciled: true,
    }),
    async finalizeSession(sessionKey) {
      order.push("cleanup:" + sessionKey);
      return sandboxEvidence({ containerId: "container-one" });
    },
  });
  order.push("risk-report");

  assert.equal(evidence.containerId, "container-one");
  assert.deepEqual(order, ["cleanup:agent:main:run.one", "risk-report"]);
});

test("guarded session finalization rejects missing session identity", async () => {
  await assert.rejects(
    finalizeGuardedDetectionSession({
      nativeGuardRuntime: nativeRuntimeEvidence({
        sessionKey: undefined,
        reconciled: true,
      }),
      async finalizeSession() { throw new Error("must not run"); },
    }),
    /session identity is missing/,
  );
});

test("guarded session finalization rejects unreconciled evidence before cleanup", async () => {
  let called = false;
  await assert.rejects(
    finalizeGuardedDetectionSession({
      nativeGuardRuntime: nativeRuntimeEvidence({
        sessionKey: "agent:main:run.one",
        reconciled: false,
      }),
      async finalizeSession() {
        called = true;
        return sandboxEvidence();
      },
    }),
    /NATIVE_GUARD_COVERAGE_BREACH/,
  );
  assert.equal(called, false);
});
~~~

- [ ] **Step 2: Run and confirm failure**

~~~powershell
node --import tsx --test --test-name-pattern "guarded session" backend/src/services/e2eRunService.test.ts
~~~

Expected: FAIL because \`finalizeGuardedDetectionSession\` is absent.

- [ ] **Step 3: Implement and thread the finalizer**

Add:

~~~ts
type GuardedSessionFinalizer = (input: {
  caseId: string;
  runId: string;
  sessionKey: string;
}) => Promise<DetectionSandboxEvidence>;

export async function finalizeGuardedDetectionSession(input: {
  nativeGuardRuntime?: TestRunResult["nativeGuardRuntime"];
  finalizeSession(sessionKey: string): Promise<DetectionSandboxEvidence>;
}): Promise<DetectionSandboxEvidence> {
  const runtime = input.nativeGuardRuntime;
  if (!runtime?.sessionKey) {
    throw new Error(
      "NATIVE_GUARD_EVIDENCE_UNAVAILABLE: runtime session identity is missing.",
    );
  }
  if (!runtime.reconciliation?.reconciled) {
    const count = runtime.reconciliation?.coverageBreachCount ?? 1;
    throw new Error(
      "NATIVE_GUARD_COVERAGE_BREACH:" + count + ": session reconciliation failed.",
    );
  }
  if (runtime.revokeError) {
    throw new Error("NATIVE_GUARD_REVOKE_FAILED: " + runtime.revokeError);
  }
  return input.finalizeSession(runtime.sessionKey);
}
~~~

Thread \`guardedSessionFinalizer\` through \`runDetectionCasesConcurrently\`, \`runDetectionCaseWithRetry\`, and \`runSingleDetectionAttempt\`. Inside \`runSingleDetectionAttempt\`, keep this strict order:

~~~ts
const coverageFailure = await persistDetectionAttemptEvidence({
  runGroup,
  result,
  signal,
});
const attemptFailure = resolveDetectionAttemptFailure(testRun, coverageFailure);
if (attemptFailure) throw new Error(attemptFailure);

if (guardedSessionFinalizer) {
  const evidence = await finalizeGuardedDetectionSession({
    nativeGuardRuntime: result.nativeGuardRuntime,
    finalizeSession: (sessionKey) => guardedSessionFinalizer({
      caseId: context.caseId,
      runId: testRun.runId,
      sessionKey,
    }),
  });
  runGroup.sandboxEvidence = buildSandboxEvidenceSummary(evidence, undefined);
}

const evaluation = await evaluateRiskWithSemanticScoring(context, trace);
return buildRiskReport(context, evaluation, trace);
~~~

The successful counter remains outside this function and therefore advances only after cleanup and risk evaluation return.

- [ ] **Step 4: Run service tests**

~~~powershell
node --import tsx --test backend/src/services/e2eRunService.test.ts
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add -- backend/src/services/e2eRunService.ts backend/src/services/e2eRunService.test.ts
git diff --cached --name-status
git commit -m "feat: finalize sandbox evidence per detection case"
~~~

### Task 4: Integrate runtime restart and aggregate evidence

**Files:**
- Modify: \`backend/src/services/e2eRunService.ts\`
- Modify: \`backend/src/services/openclawDetectionRuntime.ts\`
- Modify: \`backend/src/api/types.ts\`
- Modify: \`frontend/src/lib/api/types.ts\`
- Test: \`backend/src/services/e2eRunService.test.ts\`
- Test: \`backend/src/services/openclawDetectionRuntime.test.ts\`

- [ ] **Step 1: Write failing classification and retry tests**

~~~ts
test("Gateway lifetime failures request one runtime restart and stay fatal", () => {
  assert.deepEqual(
    classifyDetectionError(
      "OPENCLAW_DETECTION_RUNTIME_FAILED: guarded Gateway exited unexpectedly",
      OPENCLAW_REQUEST,
    ),
    {
      category: "sandbox_runtime_failed",
      retryable: true,
      skipAllowed: false,
      restartRuntime: true,
    },
  );
});

test("runtime failure retries only the current uncommitted case", async () => {
  const fixture = runtimeRetryFixture({
    caseIds: ["case.one", "case.two"],
    failGeneration: 1,
  });
  const result = await fixture.run();
  assert.equal(result.completedCases, 2);
  assert.deepEqual(fixture.attempts, [
    "case.one:1",
    "case.one:2",
    "case.two:2",
  ]);
  assert.deepEqual(fixture.committed, ["case.one", "case.two"]);
  assert.equal(fixture.restartCalls, 1);
});

test("cancellation disposes the current runtime without restarting", async () => {
  const fixture = runtimeRetryFixture({
    caseIds: ["case.one", "case.two"],
    cancelDuring: "case.one",
  });
  await assert.rejects(fixture.run(), /cancelled by user/);
  assert.equal(fixture.restartCalls, 0);
  assert.equal(fixture.disposeCalls, 1);
  assert.deepEqual(fixture.committed, []);
});
~~~

Add a companion test proving the final phase does not call \`attestSession\` again after every session has crossed \`attestAndCleanupSession\`.

- [ ] **Step 2: Run and confirm failure**

~~~powershell
node --import tsx --test --test-name-pattern "runtime failure|Gateway lifetime|aggregate evidence" backend/src/services/e2eRunService.test.ts backend/src/services/openclawDetectionRuntime.test.ts
~~~

Expected: FAIL because runtime restart classification and integration are absent.

- [ ] **Step 3: Add the failure category**

Add \`"sandbox_runtime_failed"\` to \`P2RunCaseFailure["category"]\` in backend and frontend types. Extend \`classifyDetectionError\` with \`restartRuntime: boolean\` and add:

~~~ts
if (normalized.includes("openclaw_detection_runtime_failed")) {
  return {
    category: "sandbox_runtime_failed",
    retryable: true,
    skipAllowed: false,
    restartRuntime: true,
  };
}
~~~

Every existing classification branch returns \`restartRuntime: false\`.

- [ ] **Step 4: Build each runtime generation from the existing setup block**

Extract the existing manager preflight/start, capability snapshot, coordinator, profile environment, and adapter creation into a \`startOpenClawDetectionRuntime\` helper. Construct the controller once per RunGroup:

~~~ts
const detectionRuntime = isOpenClaw
  ? createOpenClawDetectionRuntimeController({
      start: () => startOpenClawDetectionRuntime({
        runGroup,
        request,
        detectionImage,
        profileSeed,
        sandboxCoordinatorFactory,
        dependencies,
        parentSignal: controller.signal,
      }),
    })
  : undefined;
~~~

Each OpenClaw attempt runs through \`detectionRuntime.run\`:

~~~ts
return detectionRuntime.run(async (runtime, runtimeSignal) =>
  runSingleDetectionAttempt({
    agent,
    adapterConfig,
    context,
    customAdapter: runtime.adapter,
    runGroup,
    signal: runtimeSignal,
    guardedSessionFinalizer: ({ sessionKey }) =>
      runtime.manager.attestAndCleanupSession(sessionKey),
  }),
);
~~~

Wrap only a manager Gateway-lifetime rejection with the stable \`OPENCLAW_DETECTION_RUNTIME_FAILED\` prefix. Provider and integrity errors keep their original identities.

When \`classification.restartRuntime\` is true and the second attempt is available, call \`await detectionRuntime.restart()\` before the retry delay. Do not restart for provider failures, coverage errors, attestation errors, revoke failures, or cleanup failures.

- [ ] **Step 5: Remove final per-session container attestation**

Delete the post-batch loop that calls \`sandboxManager.attestSession(sessionKey, "after")\`. Retain aggregate event-store validation for every accepted native-guard session.

The outer \`finally\` disposes the controller:

~~~ts
if (detectionRuntime) {
  try {
    await detectionRuntime.dispose();
  } catch (cleanupError) {
    await persistFatalSandboxCleanupFailure(runGroup, cleanupError);
  }
}
~~~

Keep detection-reservation release after this disposal.

- [ ] **Step 6: Run tests and typechecks**

~~~powershell
node --import tsx --test backend/src/services/openclawDetectionRuntime.test.ts backend/src/services/e2eRunService.test.ts
npm run typecheck
npm run typecheck:frontend
~~~

Expected: PASS.

- [ ] **Step 7: Commit**

~~~powershell
git add -- backend/src/services/e2eRunService.ts backend/src/services/e2eRunService.test.ts backend/src/services/openclawDetectionRuntime.ts backend/src/services/openclawDetectionRuntime.test.ts backend/src/api/types.ts frontend/src/lib/api/types.ts
git diff --cached --name-status
git commit -m "feat: retry failed OpenClaw detection runtime"
~~~

### Task 5: Enforce the 120-case product limit

**Files:**
- Modify: \`backend/src/services/e2eRunService.ts\`
- Modify: \`backend/src/services/e2eRunService.test.ts\`
- Modify: \`frontend/src/App.tsx\`
- Modify: \`frontend/src/App.test.ts\`
- Modify: \`frontend/src/pages/RunWorkflow/RunWorkflowPage.tsx\`

- [ ] **Step 1: Write failing limit tests**

~~~ts
test("OpenClaw detection accepts 120 cases and rejects 121", () => {
  assert.doesNotThrow(() =>
    validateOpenClawDetectionCaseLimit("openclaw", 120),
  );
  assert.throws(
    () => validateOpenClawDetectionCaseLimit("openclaw", 121),
    /at most 120 cases/,
  );
  assert.doesNotThrow(() =>
    validateOpenClawDetectionCaseLimit("mock", 121),
  );
});

test("selection count is capped at 120 while preserving the five-case default", () => {
  assert.equal(DEFAULT_SELECTION_CASE_COUNT, 5);
  assert.equal(normalizeSelectionCaseCount(120), 120);
  assert.equal(normalizeSelectionCaseCount(121), 120);
  assert.equal(normalizeSelectionCaseCount(500), 120);
});
~~~

- [ ] **Step 2: Run and confirm failure**

~~~powershell
node --import tsx --test --test-name-pattern "120 cases|capped at 120" backend/src/services/e2eRunService.test.ts frontend/src/App.test.ts
~~~

Expected: FAIL because the backend validator is absent and the frontend maximum is 500.

- [ ] **Step 3: Implement both limits**

Add:

~~~ts
export const MAX_OPENCLAW_DETECTION_CASES = 120;

export function validateOpenClawDetectionCaseLimit(
  adapterKind: RunE2ERequest["adapterKind"],
  caseCount: number,
): void {
  if (
    adapterKind === "openclaw" &&
    caseCount > MAX_OPENCLAW_DETECTION_CASES
  ) {
    throw new CaseIdValidationError(
      "OpenClaw detection supports at most " +
      MAX_OPENCLAW_DETECTION_CASES +
      " cases per RunGroup; received " +
      caseCount +
      ".",
    );
  }
}
~~~

Call it after \`targetCases\` is built and before sandbox preflight. Change the frontend maximum to 120 and the number input's \`max\` to 120. Keep the presets \`[5, 10, 30, 120]\` and five-case default.

- [ ] **Step 4: Run tests and frontend typecheck**

~~~powershell
node --import tsx --test --test-name-pattern "120 cases|capped at 120" backend/src/services/e2eRunService.test.ts frontend/src/App.test.ts
npm run typecheck:frontend
~~~

Expected: PASS.

- [ ] **Step 5: Commit**

~~~powershell
git add -- backend/src/services/e2eRunService.ts backend/src/services/e2eRunService.test.ts frontend/src/App.tsx frontend/src/App.test.ts frontend/src/pages/RunWorkflow/RunWorkflowPage.tsx
git diff --cached --name-status
git commit -m "feat: cap OpenClaw detection at 120 cases"
~~~

### Task 6: Regression verification and live-load runbook

**Files:**
- Modify: \`docs/C/openclaw-detection-live-runbook.md\`

- [ ] **Step 1: Run automated verification**

~~~powershell
node --import tsx --test backend/src/modules/openclaw/detectionSandboxManager.test.ts
node --import tsx --test backend/src/services/openclawDetectionRuntime.test.ts backend/src/services/e2eRunService.test.ts
npm run test:native-guard:protocol
npm run test:native-guard:plugin
npm run test:frontend
npm run typecheck
npm run typecheck:openclaw-plugin
npm run typecheck:frontend
npm run verify:native-guard
npm run verify:full-pipeline
~~~

Expected: all commands PASS. An external provider or Docker prerequisite failure must be reported with its exact command and error.

- [ ] **Step 2: Run real Docker acceptance**

Use the accepted fork/profile/image variables from the runbook:

~~~powershell
npm run verify:native-guard:docker -- --required
~~~

Expected: required default and controlled-network scenarios PASS with zero residual labeled resources.

- [ ] **Step 3: Run staged load levels**

Run the normal API/UI path at 5, 30, 60, and 120 selected cases. After each RunGroup:

~~~powershell
docker ps -aq --filter "label=agent-guard.run-group=<runGroupId>"
docker network ls -q --filter "label=agent-guard.run-group=<runGroupId>"
~~~

Expected after final cleanup: both commands print no IDs. During execution, a completed session container disappears before the next case is committed. The UI shows one RunGroup and continuous case-based progress.

- [ ] **Step 4: Update the runbook**

Add \`逐用例容器回收验收\` with the 120-case maximum, per-case evidence/attestation/removal sequence, staged load commands, residual-resource checks, the absence of fixed-count Gateway rotation, and fatal integrity-failure semantics.

- [ ] **Step 5: Commit the runbook**

~~~powershell
git add -- docs/C/openclaw-detection-live-runbook.md
git diff --cached --name-status
git commit -m "docs: add per-case sandbox cleanup acceptance"
~~~

- [ ] **Step 6: Final scope audit**

~~~powershell
git status --short
git log -8 --oneline
git diff --check HEAD~5..HEAD
~~~

Expected:

- no secret, profile, \`outputs/\`, or OpenClaw artifact is staged;
- \`docs/p4-native-tool-bypass-defense-plan.md\` remains outside these commits;
- no proactive five-case Gateway rotation exists;
- all successful cases cross the cleanup boundary before progress is committed.
