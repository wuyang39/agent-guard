# OpenClaw Detection Fast Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default OpenClaw competition detection path finish quickly with bounded model work, cached run-scoped capability inspection, smaller retry budgets, and five representative cases.

**Architecture:** Detection-only defaults live at the profile and E2E orchestration boundaries. Capability data is copied from the already attested sandbox into a per-run control-client wrapper, while selection order is derived from existing test metadata immediately before execution.

**Tech Stack:** TypeScript, Node test runner, React/Vite, Fastify, OpenClaw CLI, Docker

---

### Task 1: Bound detection model work

**Files:**
- Modify: `backend/src/modules/openclaw/detectionOpenClawConfig.ts`
- Test: `backend/src/modules/openclaw/detectionOpenClawConfig.test.ts`

- [ ] Add assertions that generated detection config contains `thinkingDefault: "off"` and `params: { maxTokens: 2048 }`.
- [ ] Run the focused test and confirm it fails because the fields are absent.
- [ ] Add the two detection-only defaults and update the strict-schema fixture.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Reuse the attested capability snapshot

**Files:**
- Modify: `backend/src/modules/openclaw/detectionSandboxManager.ts`
- Modify: `backend/src/services/e2eRunService.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/src/modules/openclaw/detectionSandboxManager.test.ts`
- Test: `backend/src/app.test.ts`

- [ ] Add a manager test that rejects snapshot access before live validation and returns detached copies after validation.
- [ ] Add an app composition test that activates through the coordinator twice inspecting the supplied snapshot without invoking capability CLI commands.
- [ ] Run both tests and confirm the missing snapshot API/input causes failure.
- [ ] Expose a cloned snapshot, pass it through `SandboxCoordinatorFactory`, and override only `inspectCapabilities` on the run-scoped control client.
- [ ] Re-run both focused tests and confirm they pass.

### Task 3: Reduce timeout and retry budgets

**Files:**
- Modify: `backend/src/services/e2eRunService.ts`
- Modify: `frontend/src/lib/api/agents.ts`
- Modify: `frontend/src/lib/api/runs.ts`
- Test: `backend/src/services/e2eRunService.test.ts`
- Test: `frontend/src/lib/api/agents.test.ts`
- Test: `frontend/src/lib/api/runs.test.ts`

- [ ] Add exported-budget or request-payload assertions for 90,000 ms, two attempts, and a 3,000 ms retry base.
- [ ] Run focused tests and confirm existing 300,000 ms, three-attempt, and 15,000 ms defaults fail them.
- [ ] Change only the OpenClaw defaults while preserving explicit request/environment overrides.
- [ ] Re-run focused tests and confirm they pass.

### Task 4: Select five representative cases and defer encoded work

**Files:**
- Modify: `backend/src/modules/runner/testSelectionService.ts`
- Modify: `backend/src/services/e2eRunService.ts`
- Modify: `frontend/src/App.tsx`
- Test: `backend/src/modules/runner/testSelectionService.test.ts`
- Test: `backend/src/services/e2eRunService.test.ts`
- Test: `frontend/src/App.test.tsx`

- [ ] Add tests for a five-case OpenClaw default and stable ordering that moves metadata-tagged encoding/obfuscation cases to the end.
- [ ] Run focused tests and confirm the current defaults/order fail them.
- [ ] Change OpenClaw selection defaults to five/three, UI default to five, and add a stable execution-order helper.
- [ ] Re-run focused tests and confirm explicit case membership and non-encoded relative order are preserved.

### Task 5: Regression verification

**Files:**
- Verify all modified source and test files.

- [ ] Run backend focused tests for detection config, sandbox manager, app composition, E2E orchestration, and selection.
- [ ] Run frontend API/App tests.
- [ ] Run all three typechecks.
- [ ] Run `verify:native-guard` and report any external-environment test that cannot execute.
- [ ] Review `git diff` and keep `docs/p4-native-tool-bypass-defense-plan.md` deletion outside any future commit.
