# OpenClaw Per-Case Sandbox Cleanup Design

Date: 2026-08-09

## 1. Objective

Allow one OpenClaw detection RunGroup to execute as many as 120 selected cases without retaining every completed session container until the end of the run.

The user continues to see one detection task, one progress indicator, one detection report, one risk profile, and one supervision policy pack. Container lifecycle management remains an internal backend concern.

## 2. Scope

This change applies only to guarded OpenClaw detection runs that use `DetectionSandboxManager`. Mock, HTTP sample, realtime MCP supervision, report generation, and policy activation keep their current behavior.

The first implementation uses one Gateway and one temporary OpenClaw profile for the whole RunGroup. It does not rotate the Gateway after a fixed number of cases. A Gateway is replaced only after an infrastructure failure that is eligible for the single automatic retry.

## 3. Required Behavior

- Accept at most 120 cases in one OpenClaw detection RunGroup.
- Keep OpenClaw detection concurrency at one.
- Start one guarded Gateway and reuse it across cases while it remains healthy.
- Complete native-guard evidence drain, reconciliation, lease revocation, and sandbox attestation for each case before accepting that case result.
- Remove the exact Docker container belonging to the completed session immediately after its attestation succeeds.
- Preserve aggregate progress and final artifacts under the existing RunGroup.
- Record ordinary case failures and continue when the existing failure classification permits skipping.
- Treat coverage breach, reconciliation failure, attestation failure, unconfirmed lease revocation, ambiguous container identity, and failed container cleanup as fatal.
- On a retryable Gateway or sandbox infrastructure failure, dispose the current runtime, create a fresh Gateway/profile, and retry only the current uncommitted case once.
- Never rerun an already committed case.

## 4. Non-Goals

- Fixed five-case or resource-threshold Gateway rotation.
- Parallel OpenClaw detection.
- Parent and child RunGroups.
- User-visible batch or container controls.
- Cross-process resume after the backend process terminates.
- Automatic merging of separate RunGroups.

## 5. Architecture

### 5.1 RunGroup lifecycle

`e2eRunService` retains ownership of the public RunGroup and final report pipeline. It delegates the guarded OpenClaw runtime lifecycle to a run-scoped controller.

```text
RunE2ERequest
  -> validate and order up to 120 cases
  -> acquire the existing global detection reservation
  -> create OpenClawDetectionRuntimeController
  -> execute cases sequentially
       -> ensure Gateway/profile are healthy
       -> execute one OpenClaw session
       -> drain and persist runtime evidence
       -> attest and remove that session container
       -> commit the case risk report and progress
  -> verify aggregate native-guard coverage
  -> dispose the Gateway/profile and sweep residual resources
  -> build one detection report, risk profile, and policy pack
```

### 5.2 OpenClawDetectionRuntimeController

A new run-scoped controller owns the replaceable runtime components:

- `DetectionSandboxManager`
- sandbox credentials
- sandbox coordinator/lease dependencies
- OpenClaw adapter configured for the active Gateway
- one infrastructure-restart budget for the current case

The controller exposes operations equivalent to:

```ts
type OpenClawDetectionRuntimeController = {
  adapter(): Promise<AgentAdapter>;
  attestAndCleanupSession(sessionKey: string): Promise<DetectionSandboxEvidence>;
  restartAfterInfrastructureFailure(): Promise<void>;
  dispose(): Promise<void>;
};
```

Creation remains dependency-injected through the existing `SandboxCoordinatorFactory`; no module-level mutable dependency is introduced.

### 5.3 DetectionSandboxManager session cleanup

`DetectionSandboxManager` adds a serialized, idempotent operation:

```ts
attestAndCleanupSession(sessionKey: string): Promise<DetectionSandboxEvidence>
```

The operation performs these steps in order:

1. Confirm the guarded Gateway is still the active validated generation.
2. Run `openclaw sandbox explain --session <sessionKey> --json` and validate the expected read-only Docker sandbox configuration.
3. Inspect containers carrying the manager's RunGroup label.
4. Resolve exactly one container using the expected workspace mount and session label.
5. Apply the existing container limits, mounts, network, identity, and image attestation checks.
6. Capture the immutable evidence summary and exact container ID.
7. Remove only that container with `docker rm -f <exact-id>`.
8. Verify that exact container ID is absent while the Gateway remains healthy.
9. Store a session cleanup tombstone so repeated calls return the accepted evidence without broad deletion.

The method must never fall back to deleting every container carrying the RunGroup label. The existing full RunGroup cleanup remains the final safety sweep.

## 6. Per-Case Commit Boundary

A case is committed only after all of the following have succeeded:

1. The agent attempt returned a terminal result.
2. Runtime evidence was drained from the OpenClaw session.
3. Reconciliation proves the JSONL tool calls match hook decisions and outcomes.
4. Lease revocation completed without `revokeError`.
5. Attempt trace and native-guard evidence were persisted.
6. The session container passed post-execution attestation.
7. The exact session container was removed and absence was verified.
8. Risk evaluation produced a risk report.

Only then may the service increment `completedCases`, append the risk report ID, and set `lastCompletedCaseId`.

Failed attempts may retain diagnostic traces and test-run IDs, matching current retry behavior, but they do not contribute a risk report or successful-case count.

## 7. Integration With the Runner

`runSingleDetectionAttempt` needs a guarded-session finalizer callback supplied only for OpenClaw Docker detection. The callback receives the drained runtime identity after evidence persistence:

```ts
type GuardedSessionFinalizer = (input: {
  caseId: string;
  runId: string;
  sessionKey: string;
}) => Promise<DetectionSandboxEvidence>;
```

The finalizer runs before risk scoring and before the attempt can be returned as successful. A missing session key in a guarded run remains a fatal evidence error.

Generic `runTestCase`, mock adapters, and HTTP adapters do not acquire Docker lifecycle responsibilities.

## 8. Failure Handling

### 8.1 Ordinary case failure

Provider or agent failures continue through the existing classification rules. Skip-allowed failures are persisted and the next case runs. Non-skip-allowed failures terminate the RunGroup.

### 8.2 Infrastructure failure

Gateway exit, sandbox command transport failure, or equivalent retryable infrastructure failure triggers this sequence:

1. Mark the current case as retrying without incrementing the successful count.
2. Dispose the current manager, including the full labeled-resource sweep.
3. Create a fresh Gateway, profile, coordinator, and adapter.
4. Retry the current case once.
5. If the retry fails, mark the RunGroup failed and stop.

Attestation mismatch, reconciliation failure, coverage breach, ambiguous container identity, lease revoke failure, and cleanup failure are integrity failures rather than transient infrastructure failures. They fail closed and do not use the restart retry.

### 8.3 Cancellation

Cancellation aborts the current case, performs full runtime disposal, persists the existing cancelled RunGroup state, and does not start another case.

## 9. Progress and Persistence

The public progress model remains case-based:

- `totalCases`: selected case count, maximum 120
- `completedCases`: cases past the per-case commit boundary
- `failedCases` and `skippedCases`: existing semantics
- `runningCaseIds`: at most one OpenClaw case
- `lastCompletedCaseId`: latest committed case

No shard or container fields are added to the normal frontend contract. Infrastructure restart messages may be appended to the existing bounded warning list.

`sandboxEvidence.attested` is true only when every successful case crossed the per-case attestation and cleanup boundary. `nativeGuardCoverage.sessions` continues to aggregate session evidence for all attempts accepted by the RunGroup.

## 10. Final Validation

After the final case, the service still performs aggregate evidence checks:

- every committed case has a native-guard session identity;
- every accepted session is reconciled;
- aggregate coverage breach count is zero;
- the event store contains decisions for the sessions that made native tool calls;
- the Gateway remained the validated generation or was replaced through the recorded retry path;
- final manager cleanup leaves no labeled containers or networks.

Final report, risk-profile, and policy-pack builders consume the aggregate successful risk reports exactly once.

## 11. Tests

### DetectionSandboxManager

- Attest and remove exactly one matching session container.
- Preserve containers belonging to other sessions.
- Reject zero or multiple matching containers.
- Reject mismatched image, mounts, limits, network, or workspace identity.
- Return the stored tombstone on an idempotent repeat call.
- Treat ambiguous removal results as failure.
- Final cleanup removes residual resources after partial failure.

### E2E orchestration

- Execute more than five cases with one Gateway and clean each accepted container.
- Keep progress case-based and expose one RunGroup.
- Do not count a case before cleanup succeeds.
- Continue after a skip-allowed ordinary case failure.
- Restart the runtime and retry only the current case after a retryable Gateway failure.
- Do not retry an integrity failure.
- Stop at 120 cases and reject larger OpenClaw requests.
- Aggregate all successful risk reports into one final policy pack.

### Regression and live acceptance

- Existing mock, HTTP, realtime MCP, native-guard protocol, and frontend tests remain unchanged in behavior.
- Run 5, 30, 60, and 120 case live load levels in sequence.
- At each level assert zero residual labeled containers/networks, stable single-task UI progress, no coverage breaches, and a valid final policy pack.
- Record Gateway RSS and duration as diagnostics; they do not trigger proactive rotation in this version.

## 12. Acceptance Criteria

- A user can select up to 120 OpenClaw cases and start one detection task.
- Completed case containers do not accumulate until the end of the RunGroup.
- The UI exposes no batch or child-task concept.
- One final report, risk profile, and policy pack cover all successful cases.
- Infrastructure restart never reruns committed cases.
- Integrity failures remain fatal.
- Guard-off OpenClaw behavior outside detection remains unaffected.
- Five-case behavior and existing verification suites do not regress.

