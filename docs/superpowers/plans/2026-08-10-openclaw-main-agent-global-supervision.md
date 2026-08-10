# OpenClaw Main Agent Global Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frontend supervision switch activate one native-guard lease that covers every current and future canonical OpenClaw session owned by the `main` agent, while leaving all other agents and Guard-OFF operation unchanged.

**Architecture:** Extend the native-guard wire contract with a backward-compatible structured scope and resolve leases in the order exact session, canonical agent, OFF. A backend-owned `MainAgentSupervisionService` manages the host Gateway lease and renew timer, while the shared durable event store projects sanitized native decision/outcome events into the existing realtime SSE stream. Detection keeps its session lease and Docker lifecycle, and coordinator conflicts are isolated by Gateway identity plus scope.

**Tech Stack:** TypeScript, Node.js, Fastify, React, OpenClaw plugin hooks, Node test runner, SSE.

---

### Task 0: Preserve and Commit the Existing Runtime Fixes

**Files:**
- Modify: `backend/src/app.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/modules/openclaw/detectionOpenClawConfig.ts`
- Modify: `backend/src/modules/openclaw/detectionSandboxManager.test.ts`
- Modify: `backend/src/modules/openclaw/detectionSandboxManager.ts`
- Exclude: `docs/p4-native-tool-bypass-defense-plan.md`

- [ ] **Step 1: Verify the focused runtime changes**

Run:

```powershell
node --import tsx --test backend/src/app.test.ts backend/src/modules/openclaw/detectionSandboxManager.test.ts
npm run typecheck
```

Expected: all selected tests pass and TypeScript exits with code 0.

- [ ] **Step 2: Stage only the five runtime files**

```powershell
git add backend/src/app.test.ts backend/src/app.ts backend/src/modules/openclaw/detectionOpenClawConfig.ts backend/src/modules/openclaw/detectionSandboxManager.test.ts backend/src/modules/openclaw/detectionSandboxManager.ts
git diff --cached --name-only
```

Expected: the deleted P4 document is absent from the staged list.

- [ ] **Step 3: Commit the runtime fixes**

```powershell
git commit -m "fix: support plugin model catalogs in detection sandbox"
```

### Task 1: Add the Backward-Compatible Scope Contract and Canonical Session Parser

**Files:**
- Modify: `packages/contracts/src/types/nativeGuard.ts`
- Modify: `packages/native-guard-protocol/src/index.ts`
- Test: `packages/native-guard-protocol/src/index.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Add tests proving that `normalizeNativeGuardLeaseScope(undefined, root)` and legacy `"session_tree"` produce a session scope, an explicit session scope must equal `rootSessionKey`, agent scope only accepts `{ kind: "agent", agentId: "main" }` with anchor `agent:main:main`, and `parseCanonicalOpenClawSessionKey` accepts `agent:main:dashboard:x`, `agent:main:cli:x`, `agent:main:subagent:x` while rejecting empty/control-character/non-agent keys.

```ts
assert.deepEqual(normalizeNativeGuardLeaseScope(undefined, "agent:main:run.1"), {
  kind: "session",
  sessionKey: "agent:main:run.1",
});
assert.deepEqual(parseCanonicalOpenClawSessionKey("agent:main:dashboard:abc"), {
  agentId: "main",
  sessionKey: "agent:main:dashboard:abc",
});
assert.throws(() => normalizeNativeGuardLeaseScope(
  { kind: "agent", agentId: "main" },
  "agent:main:wrong",
));
```

- [ ] **Step 2: Run the protocol test and confirm RED**

```powershell
npm run test:native-guard:protocol
```

Expected: FAIL because the scope helpers and types do not exist.

- [ ] **Step 3: Implement types and normalization**

Add the contract:

```ts
export type NativeGuardLeaseScope =
  | "session_tree"
  | { kind: "session"; sessionKey: string }
  | { kind: "agent"; agentId: "main" };

export type NativeGuardLeaseSummary = {
  leaseId: string;
  leaseEpoch: number;
  rootSessionKey: string;
  scope: NativeGuardLeaseScope;
  mode: NativeGuardMode;
  policyPackId: string;
  policyPackDigest: string;
  expiresAt: string;
};
```

Make `NativeGuardLeaseActivation.scope` optional only at parser boundaries, but always emit a normalized scope in newly created activation payloads. Add `NativeGuardStatus.activeLeases?: NativeGuardLeaseSummary[]` and retain `activeLease` for one-lease compatibility.

Implement and export:

```ts
export function parseCanonicalOpenClawSessionKey(sessionKey: string): {
  agentId: string;
  sessionKey: string;
} | undefined;

export function normalizeNativeGuardLeaseScope(
  scope: NativeGuardLeaseScope | undefined,
  rootSessionKey: string,
): Exclude<NativeGuardLeaseScope, "session_tree">;

export function nativeGuardScopesEqual(left: NativeGuardLeaseScope, right: NativeGuardLeaseScope): boolean;
```

- [ ] **Step 4: Run protocol tests and typecheck**

```powershell
npm run test:native-guard:protocol
npm run typecheck
npm run typecheck:openclaw-plugin
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/contracts/src/types/nativeGuard.ts packages/native-guard-protocol/src/index.ts packages/native-guard-protocol/src/index.test.ts
git commit -m "feat: add native guard agent lease scope"
```

### Task 2: Resolve Agent Leases in the Backend Lease Service

**Files:**
- Modify: `backend/src/modules/openclaw/nativeGuardLeaseService.ts`
- Test: `backend/src/modules/openclaw/nativeGuardLeaseService.test.ts`

- [ ] **Step 1: Write failing lease-service tests**

Cover these independent behaviors:

```ts
const main = service.create({
  rootSessionKey: "agent:main:main",
  scope: { kind: "agent", agentId: "main" },
  mode: "supervision",
  policyPack,
  policyPackDigest,
  backendUrl,
});
assert.equal(service.resolveBySession("agent:main:dashboard:one")?.leaseId, main.activation.leaseId);
assert.equal(service.resolveBySession("agent:worker:dashboard:one"), undefined);
service.endSession("agent:main:dashboard:one");
assert.equal(service.resolveBySession("agent:main:dashboard:two")?.leaseId, main.activation.leaseId);
```

Also create an exact session lease for `agent:main:run.1` and assert that it wins over the main agent lease. Assert `authorizeEvidence` rejects a main-agent event carrying the exact session lease ID after that lease is revoked instead of falling through to the agent lease.

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
node --import tsx --test backend/src/modules/openclaw/nativeGuardLeaseService.test.ts
```

Expected: agent-scoped create/lookup assertions fail.

- [ ] **Step 3: Implement the agent index and lifecycle rules**

Extend `CreateLeaseInput` and `StoredLease` with `scope`. Maintain `agents: Map<string, string>` alongside `sessions`. Normalize legacy scope at create time; index session scopes in `sessions` and agent scopes in `agents`. Implement `resolveBySession` as exact session first, then parsed agent fallback. Keep `authenticate`, `authorizeEvidence`, `bindChildWithEvidence`, and epoch checks tied to the caller-provided lease ID. For agent leases, `endSession` must not set the root lease to `root_ended`.

- [ ] **Step 4: Run focused tests and typecheck**

```powershell
node --import tsx --test backend/src/modules/openclaw/nativeGuardLeaseService.test.ts backend/src/modules/openclaw/nativeToolDecisionService.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/src/modules/openclaw/nativeGuardLeaseService.ts backend/src/modules/openclaw/nativeGuardLeaseService.test.ts
git commit -m "feat: resolve main agent native guard leases"
```

### Task 3: Add Agent Fallback and Durable Scope to the OpenClaw Plugin

**Files:**
- Modify: `plugins/agent-guard-supervision/src/leaseRegistry.ts`
- Modify: `plugins/agent-guard-supervision/src/eventSpool.ts`
- Modify: `plugins/agent-guard-supervision/src/controlRoutes.ts`
- Modify: `plugins/agent-guard-supervision/src/runtime.ts`
- Test: `plugins/agent-guard-supervision/src/leaseRegistry.test.ts`
- Test: `plugins/agent-guard-supervision/src/eventSpool.test.ts`
- Test: `plugins/agent-guard-supervision/src/controlRoutes.test.ts`
- Test: `plugins/agent-guard-supervision/src/runtime.test.ts`

- [ ] **Step 1: Write failing registry and runtime tests**

Add tests that activate `{ kind: "agent", agentId: "main" }`, then look up an existing dashboard session and a newly created CLI session without `bindChild`. Verify a worker agent returns OFF, an exact session lease wins, malformed `agent:main` identity is denied while a main lease exists, and `runtime.endSession(mainChild)` leaves the agent lease active.

Add marker/recovery tests asserting `scope` survives serialization and reload, and status exposes the scope in both `activeLease` and `activeLeases`.

- [ ] **Step 2: Run plugin tests and confirm RED**

```powershell
npm run test:native-guard:plugin
```

Expected: FAIL on agent activation validation/lookup/status.

- [ ] **Step 3: Implement registry indexing and persistence**

Normalize activation scopes before storage, add an agent-scope index, and use exact-session then canonical-agent lookup. Preserve scope in marker canonical JSON, recovery records, renew equality checks, status summaries, and control-route projection. `prepareSessionEnd` must return no root-ending intent for an agent lease. Keep `subagent_spawned` lineage recording, but do not require it for authorization.

- [ ] **Step 4: Run plugin verification**

```powershell
npm run test:native-guard:plugin
npm run typecheck:openclaw-plugin
npm run build:openclaw-plugin
```

Expected: PASS and plugin bundle builds.

- [ ] **Step 5: Commit**

```powershell
git add plugins/agent-guard-supervision/src
git commit -m "feat: enforce main agent scope in OpenClaw hook"
```

### Task 4: Make Coordinator Conflicts Gateway-and-Scope Aware

**Files:**
- Modify: `backend/src/modules/openclaw/nativeGuardCoordinator.ts`
- Modify: `backend/src/modules/openclaw/openclawControlClient.ts`
- Test: `backend/src/modules/openclaw/nativeGuardCoordinator.test.ts`
- Test: `backend/src/modules/openclaw/openclawControlClient.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

Test that a host `{ kind: "agent", agentId: "main" }` lease can coexist with a session lease on another sandbox Gateway, while a second overlapping main scope on the same `gatewayInstanceId` fails with `NATIVE_GUARD_SCOPE_CONFLICT`. Verify renew/revoke use the `ManagedLease` Gateway client and URL, and status parses multiple summaries without selecting array position as identity.

- [ ] **Step 2: Run tests and confirm RED**

```powershell
node --import tsx --test backend/src/modules/openclaw/nativeGuardCoordinator.test.ts backend/src/modules/openclaw/openclawControlClient.test.ts
```

Expected: coexistence or multi-status parsing fails.

- [ ] **Step 3: Implement scoped activation reservations**

Add `scope?: NativeGuardLeaseScope` to `ActivateNativeGuardInput`, store normalized scope and `gatewayInstanceId` on `ManagedLease`, and replace the boolean reservation with a set keyed by canonical `gatewayInstanceId + scope`. Conflict only when scopes overlap on the same Gateway. Pass scope to `leaseService.create`, require plugin acknowledgement to match scope, and project `activeLeases` from all managed active leases.

- [ ] **Step 4: Run coordinator, handler, and type tests**

```powershell
node --import tsx --test backend/src/modules/openclaw/nativeGuardCoordinator.test.ts backend/src/modules/openclaw/openclawControlClient.test.ts backend/src/api/v1/openclaw/native-guard-handlers.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/src/modules/openclaw/nativeGuardCoordinator.ts backend/src/modules/openclaw/nativeGuardCoordinator.test.ts backend/src/modules/openclaw/openclawControlClient.ts backend/src/modules/openclaw/openclawControlClient.test.ts
git commit -m "feat: isolate native guard leases by gateway and scope"
```

### Task 5: Add the Backend-Owned Main Supervision Lifecycle and API

**Files:**
- Create: `backend/src/modules/openclaw/mainAgentSupervisionService.ts`
- Create: `backend/src/modules/openclaw/mainAgentSupervisionService.test.ts`
- Create: `backend/src/api/v1/openclaw/native-supervision-handlers.ts`
- Create: `backend/src/api/v1/openclaw/native-supervision-handlers.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/app.test.ts`

- [ ] **Step 1: Write failing service tests**

Define the API:

```ts
type MainAgentSupervisionStatus = {
  coverage: NativeGuardCoverageStatus;
  scope: { kind: "agent"; agentId: "main" };
  policyPackId?: string;
  leaseId?: string;
  leaseEpoch?: number;
  expiresAt?: string;
  gatewayInstanceId?: string;
  activeLeaseCount: number;
  reasonCode?: string;
  detail?: string;
};

type MainAgentSupervisionService = {
  start(policyPackId: string): Promise<MainAgentSupervisionStatus>;
  stop(): Promise<MainAgentSupervisionStatus>;
  status(): Promise<MainAgentSupervisionStatus>;
  close(): Promise<void>;
};
```

Test start with anchor `agent:main:main`, fixed main scope and `mode: "supervision"`; same-policy idempotency; different-policy stop-then-start replacement; renew at one-third TTL; renew failure becomes recovery; stop clears the timer before revoke; close attempts revoke.

- [ ] **Step 2: Run service tests and confirm RED**

```powershell
node --import tsx --test backend/src/modules/openclaw/mainAgentSupervisionService.test.ts
```

Expected: FAIL because the service module is missing.

- [ ] **Step 3: Implement the service**

Use the app coordinator only. Accept injected `setTimeout`, `clearTimeout`, and `now` for deterministic tests. Validate activation by locating the returned main agent scope, checking `coverage === "active"`, and confirming `coordinator.isLeaseUsable(leaseId)`. Never expose control or lease credentials.

- [ ] **Step 4: Write failing route tests**

Test:

```text
GET  /api/v1/openclaw/native-supervision
POST /api/v1/openclaw/native-supervision/start { policyPackId }
POST /api/v1/openclaw/native-supervision/stop
```

Assert `agentId` is not accepted, invalid/missing policy IDs return 400, service errors retain stable codes, and responses contain only the public status.

- [ ] **Step 5: Implement and wire routes**

Register the new routes in `buildApp`, construct one service per app instance from `nativeGuardDependencies.coordinator`, and register an `onClose` hook that awaits `service.close()`.

- [ ] **Step 6: Run backend tests**

```powershell
node --import tsx --test backend/src/modules/openclaw/mainAgentSupervisionService.test.ts backend/src/api/v1/openclaw/native-supervision-handlers.test.ts backend/src/app.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add backend/src/modules/openclaw/mainAgentSupervisionService.ts backend/src/modules/openclaw/mainAgentSupervisionService.test.ts backend/src/api/v1/openclaw/native-supervision-handlers.ts backend/src/api/v1/openclaw/native-supervision-handlers.test.ts backend/src/app.ts backend/src/app.test.ts
git commit -m "feat: manage main OpenClaw supervision lease"
```

### Task 6: Bridge Durable Native Events to Realtime SSE

**Files:**
- Create: `backend/src/modules/openclaw/nativeGuardRealtimeBridge.ts`
- Create: `backend/src/modules/openclaw/nativeGuardRealtimeBridge.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/modules/openclaw/realtimeMcpServer.ts`

- [ ] **Step 1: Write failing bridge tests**

Subscribe a test bridge to `NativeGuardEventStore`, append decision and outcome events, and assert one `native_tool_hook` projection per durable append with the same sessionKey/callId. Assert credential-looking fields, raw params, stderr, and unrelated detail keys are absent. Assert duplicate append and listener failure do not duplicate or reject persistence.

- [ ] **Step 2: Run the bridge test and confirm RED**

```powershell
node --import tsx --test backend/src/modules/openclaw/nativeGuardRealtimeBridge.test.ts
```

Expected: FAIL because no bridge is installed.

- [ ] **Step 3: Implement a narrow sanitized projector**

Export:

```ts
export function createNativeGuardRealtimeBridge(options: {
  eventStore: Pick<NativeGuardEventStore, "subscribe">;
  emit: typeof emitNativeToolHookEvent;
}): { close(): void };
```

Only project `decision`, `approval_requested`, `approval_resolved`, and `tool_outcome`. Build detail from an allowlist: `leaseId`, `leaseEpoch`, `phase`, `decisionId`, `reasonCode`, `outcome`, and `source: "native_guard"`. Use the event `sessionKey` as `runtimeSessionId` and never forward the raw `detail` object.

- [ ] **Step 4: Wire bridge lifecycle and verify**

Create it from `nativeGuardDependencies.runtimeEventStore` during `buildApp`; close its subscription in Fastify `onClose`.

```powershell
node --import tsx --test backend/src/modules/openclaw/nativeGuardRealtimeBridge.test.ts backend/src/app.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add backend/src/modules/openclaw/nativeGuardRealtimeBridge.ts backend/src/modules/openclaw/nativeGuardRealtimeBridge.test.ts backend/src/modules/openclaw/realtimeMcpServer.ts backend/src/app.ts backend/src/app.test.ts
git commit -m "feat: stream durable native guard events"
```

### Task 7: Expose Main Supervision Controls and Main-Session Events in the Frontend

**Files:**
- Modify: `frontend/src/lib/api/types.ts`
- Modify: `frontend/src/lib/api/realtime.ts`
- Modify: `frontend/src/lib/api/realtime.test.ts`
- Modify: `frontend/src/lib/models/realtime.ts`
- Modify: `frontend/src/lib/models/realtime.test.ts`
- Modify: `frontend/src/pages/Supervision/LiveSupervisionPage.tsx`
- Modify: `frontend/src/App.test.ts`

- [ ] **Step 1: Write failing API and model tests**

Add `MainAgentSupervisionStatus` to frontend types and test `nativeSupervisionStatus`, `startNativeSupervision(policyPackId)`, and `stopNativeSupervision`. Add model tests showing `native_tool_hook` for any canonical `agent:main:*` session remains visible even when the realtime MCP `runtimeSessionId` differs, while normal realtime events keep current filtering.

- [ ] **Step 2: Run frontend tests and confirm RED**

```powershell
npm run test:frontend
```

Expected: FAIL because the client methods and filter behavior are missing.

- [ ] **Step 3: Implement API and filtering**

Add `"native_tool_hook"` to `REALTIME_EVENT_TYPES`. Update `shouldDisplayRealtimeEvent` so native events are included when `parse`-equivalent frontend validation sees `agent:main:`; add a page-level session filter with `all` plus observed session keys without using the synthetic `session.*` ID.

- [ ] **Step 4: Implement start/stop UI**

On mount fetch native supervision status. “开始监督” calls start with `activePolicy.resolvedPolicyPackId` and opens SSE only after active is confirmed. “停止监督” calls stop without forcing SSE closed. Display coverage, fixed scope label, policy pack, main lease count, system lease count, Gateway identity, expiry, and recovery errors. Disable commands while an operation is in flight.

- [ ] **Step 5: Run frontend verification**

```powershell
npm run test:frontend
npm run typecheck:frontend
npm run build:frontend
```

Expected: PASS and production build completes.

- [ ] **Step 6: Commit**

```powershell
git add frontend/src/lib/api frontend/src/lib/models/realtime.ts frontend/src/lib/models/realtime.test.ts frontend/src/pages/Supervision/LiveSupervisionPage.tsx frontend/src/App.test.ts
git commit -m "feat: control main native supervision from frontend"
```

### Task 8: Prove Detection Coexistence and Run the Full Acceptance Flow

**Files:**
- Modify: `backend/src/app.test.ts`
- Modify: `scripts/verify-openclaw-native-guard.ts`
- Create: `docs/C/openclaw-main-global-supervision-blackbox.md`

- [ ] **Step 1: Write failing integration tests**

Build one app instance with a fake host control client and sandbox control client. Start main supervision, run a sandbox activation, assert two independent leases are usable, revoke the sandbox lease, and assert main remains active. Stop main and assert host status returns ready/off with no main lease.

- [ ] **Step 2: Run integration tests and confirm RED**

```powershell
node --import tsx --test backend/src/app.test.ts
```

Expected: FAIL until all dependency and coexistence wiring is complete.

- [ ] **Step 3: Extend the verifier and black-box runbook**

Add deterministic checks for legacy session scope, main agent scope, worker exclusion, exact-session precedence, session-end behavior, SSE projection, and revoke restoration. Document the frontend-only plus OpenClaw conversation flow: OFF allow, start, existing main deny, new main deny, two session events, detection coexistence, stop, allow.

- [ ] **Step 4: Run the complete local verification chain**

```powershell
npm run typecheck
npm run typecheck:openclaw-plugin
npm run typecheck:frontend
npm run test:native-guard:protocol
npm run test:native-guard:plugin
npm run test:frontend
npm run build:openclaw-plugin
npm run verify:native-guard
npm run verify:full-pipeline
npm run verify:a-config-sandbox
```

Expected: all commands pass; full pipeline reports 92/92.

- [ ] **Step 5: Run real local black-box acceptance**

```powershell
npm run openclaw:start
npm run api:start
npm run frontend
```

Use the runbook against `http://127.0.0.1:5173` and the host OpenClaw UI. Confirm deny prevents the probe side effect, both old and new `main` sessions emit distinct `native_tool_hook` events, a Docker detection case completes while host main supervision remains active, and stop restores Guard-OFF execution.

- [ ] **Step 6: Commit**

```powershell
git add backend/src/app.test.ts scripts/verify-openclaw-native-guard.ts docs/C/openclaw-main-global-supervision-blackbox.md
git commit -m "test: verify main agent global native supervision"
```

### Task 9: Final Review and Release Readiness

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/C/openclaw-detection-live-runbook.md`

- [ ] **Step 1: Update architecture and operator documentation**

Document exact-session precedence, main agent scope, host/sandbox Gateway isolation, automatic renewal, stop/recovery behavior, SSE evidence source, and the fact that non-`main` agents remain Guard OFF.

- [ ] **Step 2: Run repository checks and inspect scope**

```powershell
npm run verify:all
git status --short
git diff --check
```

Expected: verification passes; only the intentionally retained deletion of `docs/p4-native-tool-bypass-defense-plan.md` remains unstaged if the user has not requested committing it.

- [ ] **Step 3: Commit documentation**

```powershell
git add docs/architecture.md docs/C/openclaw-detection-live-runbook.md
git commit -m "docs: describe main agent native supervision"
```

- [ ] **Step 4: Request code and security review**

Review for: fail-open regressions when Guard is disabled, cross-agent matching, stale lease fallback, Gateway credential mix-ups, timer leaks, event secret exposure, SSE filtering, and detection coexistence. Resolve findings with a failing regression test before each fix.
