# OpenClaw Host Capability Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the two-second host capability-probe failure and avoid repeated slow OpenClaw CLI inventory calls without weakening detection sandbox isolation or changing Guard-off behavior.

**Architecture:** Add an in-process control-client decorator that caches only `inspectCapabilities()` results by runtime identity and coalesces concurrent probes. Host coordinators use the decorator; sandbox coordinators keep their existing run-scoped snapshot/control client. Any failed host Gateway control operation invalidates the corresponding capability entry, and route dependency construction schedules a read-only status warmup without awaiting it.

**Tech Stack:** TypeScript, Node.js `node:test`, Fastify, existing OpenClaw control client/coordinator abstractions.

---

### Task 1: Host capability cache contract

**Files:**
- Create: `backend/src/modules/openclaw/openclawHostCapabilityCache.ts`
- Create: `backend/src/modules/openclaw/openclawHostCapabilityCache.test.ts`

- [x] Write failing tests for concurrent singleflight, cloned cached values, identity separation, expiry, and control-operation invalidation.
- [x] Run the focused test and confirm the missing module/API is the failure reason.
- [x] Implement a small process-local cache and `OpenClawControlClient` decorator.
- [x] Re-run the focused test and typecheck.

### Task 2: Host composition and warmup

**Files:**
- Modify: `backend/src/api/v1/openclaw/native-guard-handlers.ts`
- Modify: `backend/src/api/v1/openclaw/native-guard-handlers.test.ts`
- Modify: `backend/src/app.test.ts`

- [x] Write failing tests proving runtime identity includes CLI/Gateway/profile/agent fields, dependency creation does not await warmup, warmup creates no lease, and sandbox activation uses its own snapshot.
- [x] Run the focused tests and confirm the new expectations fail.
- [x] Give the host CLI probe a 60-second budget, decorate each lazy coordinator by its full runtime identity, and schedule best-effort `status()` warmup.
- [x] Re-run handler/app tests and typecheck.

### Task 3: Verification and documentation

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/其他设备使用说明.md` (or the existing Chinese portable setup guide)

- [x] Run all focused native-guard tests.
- [x] Run `npm run verify:native-guard`, `npm run verify:all`, and the required Docker native-guard gate when the configured immutable image is available.
- [x] Restart the local API/front end/Gateway stack and verify host lease activation, native tool decision/outcome evidence, deny with no side effect, revoke, and Guard-off pass-through.
- [x] Document cache scope, invalidation, timeout, sandbox exclusion, and the process-lifetime identity limitation.
- [x] Review `git diff` and stage only files from this plan, leaving `docs/p4-native-tool-bypass-defense-plan.md` deleted and unstaged.
