# Native Supervision Browser Capability Implementation Plan

> **For agentic workers:** Execute task by task with Subagent-Driven Development. Every behavior change uses RED -> GREEN -> focused verification -> commit -> spec review -> quality/security review.

**Goal:** Protect main-agent supervision control APIs and Native Guard realtime replay with launcher-bootstrapped browser capabilities, without exposing reusable control secrets to OpenClaw or the frontend bundle.

**Architecture:** A backend-owned in-memory access service exchanges one launcher token for an HttpOnly control cookie, then mints a separate short-lived read-only SSE cookie. Sensitive routes require an exact allowed Origin plus the appropriate cookie. The launcher injects secrets only into the backend process and opens the frontend with a one-time URL fragment. The frontend removes the fragment before exchange, sends credentialed requests, and mints SSE access before creating EventSource.

**Tech Stack:** TypeScript, Node.js crypto, Fastify, React, EventSource, PowerShell, Node test runner.

**Preserve:** Keep `docs/p4-native-tool-bypass-defense-plan.md` deleted and unstaged. Do not restore, stage, or commit it.

---

### Task 1: Add the In-Memory Browser Capability Service

**Files:**
- Create: `backend/src/modules/openclaw/nativeSupervisionAccessService.ts`
- Create: `backend/src/modules/openclaw/nativeSupervisionAccessService.test.ts`

- [ ] **Step 1: Write failing token lifecycle tests**

Cover bootstrap exchange, one-time use, wrong token, malformed length, expiry, control-session validation, independent SSE token validation, SSE expiry, and backend-generation isolation. Inject `now` and random token creation.

```ts
const service = createNativeSupervisionAccessService({
  bootstrapToken: "b".repeat(43),
  now: () => nowMs,
  createToken: sequenceTokenFactory(),
});
const control = service.exchangeBootstrap("b".repeat(43));
assert.equal(service.authenticateControl(control.token), true);
const events = service.issueEventCapability(control.token);
assert.equal(service.authenticateEvents(events.token), true);
assert.equal(service.authenticateControl(events.token), false);
```

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
node --import tsx --test backend/src/modules/openclaw/nativeSupervisionAccessService.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement bounded capability storage**

Use 32-byte base64url tokens. Store only SHA-256 digests and expiry timestamps for issued cookies. Compare the configured bootstrap secret in constant time. Consume it after one successful exchange. Purge expired entries during issue/authenticate operations and cap live control/event entries to a documented bound. Expose no raw token through status or errors.

- [ ] **Step 4: Verify and commit**

```powershell
node --import tsx --test backend/src/modules/openclaw/nativeSupervisionAccessService.test.ts
npm run typecheck
git add backend/src/modules/openclaw/nativeSupervisionAccessService.ts backend/src/modules/openclaw/nativeSupervisionAccessService.test.ts
git commit -m "feat: add native supervision browser capabilities"
```

### Task 2: Authenticate Native Supervision Control Routes

**Files:**
- Modify: `backend/src/api/v1/openclaw/native-supervision-handlers.ts`
- Modify: `backend/src/api/v1/openclaw/native-supervision-handlers.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/app.test.ts`
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Write failing route tests**

Add tests for `POST /access/bootstrap`, `POST /access/events`, and all existing status/start/stop routes. Assert missing, `null`, malformed, and malicious Origin fail before service calls. Assert missing/wrong cookies return 401 with zero supervision service calls. Assert bootstrap body is exact and the response cookie has `HttpOnly`, `SameSite=Strict`, the narrow Path, and bounded `Max-Age`.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
node --import tsx --test backend/src/api/v1/openclaw/native-supervision-handlers.test.ts backend/src/app.test.ts
```

Expected: unauthenticated existing requests still succeed.

- [ ] **Step 3: Implement cookie and Origin gates**

Inject `NativeSupervisionAccessService` and exact allowed origins into the route plugin. Parse only the named cookie with a bounded parser. Authenticate in `onRequest` before schema/service work. Add stable 400/401/403 errors. Set `Secure` only for HTTPS. Set control cookie Path to `/api/v1/openclaw/native-supervision` and event cookie Path to `/api/v1/openclaw/realtime/events/stream`.

- [ ] **Step 4: Wire app/server lifecycle and logging**

Add access-service injection to `buildApp`. Redact request cookies, response `set-cookie`, and bootstrap body token. Enable credentialed CORS responses while retaining exact route-specific Origin checks. `server.ts` creates a one-time token when the launcher has not supplied one and prints the pairing fragment once to the controlling terminal, outside Pino request logs.

- [ ] **Step 5: Verify and commit**

```powershell
node --import tsx --test backend/src/api/v1/openclaw/native-supervision-handlers.test.ts backend/src/app.test.ts
npm run typecheck
git add backend/src/api/v1/openclaw/native-supervision-handlers.ts backend/src/api/v1/openclaw/native-supervision-handlers.test.ts backend/src/app.ts backend/src/app.test.ts backend/src/server.ts
git commit -m "feat: authenticate native supervision controls"
```

### Task 3: Protect Native Guard Realtime SSE

**Files:**
- Modify: `backend/src/api/v1/openclaw/realtime-mcp-handlers.ts`
- Modify: `backend/src/api/v1/openclaw/realtime-mcp-handlers.test.ts` if present, otherwise add route coverage to `backend/src/app.test.ts`
- Modify: `backend/src/app.ts`
- Modify: `backend/src/modules/openclaw/realtimeMcpServer.test.ts` only if subscriber instrumentation is needed

- [ ] **Step 1: Write failing malicious-client tests**

Prove an unauthenticated request, missing Origin, `null` Origin, and malicious Origin return before `reply.hijack`, replay, or subscription. Prove the control cookie alone cannot read SSE and the event cookie cannot call `stop`. Prove authorized replay still emits sanitized `native_tool_hook`.

- [ ] **Step 2: Run focused tests and confirm RED**

```powershell
node --import tsx --test backend/src/app.test.ts backend/src/modules/openclaw/realtimeMcpServer.test.ts
```

Expected: current wildcard SSE accepts the unauthorized request.

- [ ] **Step 3: Gate before hijack**

Pass the access service and allowed origins into realtime routes. Validate exact Origin plus event cookie before writing SSE headers. Remove wildcard CORS, echo only the validated Origin, add `Vary: Origin` and `Access-Control-Allow-Credentials: true`, and keep replay behavior unchanged for authorized clients.

- [ ] **Step 4: Verify and commit**

```powershell
node --import tsx --test backend/src/app.test.ts backend/src/modules/openclaw/realtimeMcpServer.test.ts backend/src/modules/openclaw/nativeGuardRealtimeBridge.test.ts
npm run typecheck
git add backend/src/api/v1/openclaw/realtime-mcp-handlers.ts backend/src/app.ts backend/src/app.test.ts backend/src/modules/openclaw/realtimeMcpServer.test.ts
git commit -m "fix: protect native guard realtime events"
```

### Task 4: Bootstrap and Use Capabilities in the Frontend

**Files:**
- Modify: `frontend/src/lib/api/core.ts`
- Modify: `frontend/src/lib/api/realtime.ts`
- Modify: `frontend/src/lib/api/realtime.test.ts`
- Modify: `frontend/src/lib/models/realtime.ts`
- Modify: `frontend/src/lib/models/realtime.test.ts`
- Modify: `frontend/src/pages/Supervision/LiveSupervisionPage.tsx`
- Modify: `frontend/src/App.test.ts`

- [ ] **Step 1: Write failing frontend tests**

Test fragment extraction/removal before network exchange, singleflight bootstrap, `credentials: "include"`, event-capability minting before stream open, and `{ withCredentials: true }` for the main EventSource. Test bootstrap/mint failures do not report streaming and do not call stop.

- [ ] **Step 2: Run frontend tests and confirm RED**

```powershell
npm run test:frontend
```

Expected: missing bootstrap/access client behavior fails.

- [ ] **Step 3: Implement access bootstrap**

Add a small API module or focused helpers in `realtime.ts`. Read only `agent-guard-bootstrap` from `window.location.hash`, remove it with `history.replaceState`, and exchange from a local variable. Share concurrent exchange with one promise. Never write the token to localStorage, sessionStorage, component state, error text, or logs.

- [ ] **Step 4: Mint before opening streams**

Make manual listening and start-supervision paths await event capability issuance. Preserve latest-wins behavior. Construct the main EventSource with credentials; leave ask EventSource behavior unchanged. A stream error remains non-fatal to an active lease.

- [ ] **Step 5: Verify and commit**

```powershell
npm run test:frontend
npm run typecheck:frontend
npm run build:frontend
git add frontend/src/lib/api/core.ts frontend/src/lib/api/realtime.ts frontend/src/lib/api/realtime.test.ts frontend/src/lib/models/realtime.ts frontend/src/lib/models/realtime.test.ts frontend/src/pages/Supervision/LiveSupervisionPage.tsx frontend/src/App.test.ts
git commit -m "feat: pair frontend native supervision access"
```

### Task 5: Isolate Launcher Child Environments

**Files:**
- Modify: `scripts/start-agent-guard-openclaw.ps1`
- Modify: `scripts/openclaw-portable-workflow.test.ts`
- Modify: `docs/C/openclaw-local-install-and-demo-runbook.md`

- [ ] **Step 1: Write failing launcher contract tests**

Extend portable workflow tests to inspect the script contract. Assert Gateway, sample, and frontend launch without `AGENT_GUARD_CONTROL_TOKEN` and `AGENT_GUARD_UI_BOOTSTRAP_TOKEN`; backend receives both plus the actual frontend origin. Assert the opened/printed URL uses a fragment, and plan/PID/log metadata omit all token values.

- [ ] **Step 2: Run tests and confirm RED**

```powershell
npm run test:openclaw:portable
```

Expected: current script exposes parent process secrets to every child and opens a URL without bootstrap fragment.

- [ ] **Step 3: Implement per-process environment snapshots**

Wrap `Start-Process` with temporary process-environment overrides/removals and restore the parent environment in `finally`. Keep Windows PowerShell compatibility. Generate the bootstrap token in memory, pass it only to backend, set the actual allowed frontend origin, and remove control/bootstrap secrets before launching Gateway/sample/frontend.

- [ ] **Step 4: Open or print the pairing URL**

Use `http://127.0.0.1:<FrontendPort>/#agent-guard-bootstrap=<token>`. Default mode opens it after readiness. `-NoBrowser` prints it once. Do not add it to `$plan`, PID JSON, or service logs.

- [ ] **Step 5: Verify and commit**

```powershell
npm run test:openclaw:portable
git diff --check
git add scripts/start-agent-guard-openclaw.ps1 scripts/openclaw-portable-workflow.test.ts docs/C/openclaw-local-install-and-demo-runbook.md
git commit -m "feat: isolate native supervision launcher secrets"
```

### Task 6: Update Architecture and Run Release Verification

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/C/openclaw-main-global-supervision-blackbox.md`
- Modify: `docs/C/openclaw-detection-live-runbook.md` only if command/auth assumptions changed
- Modify: `scripts/verify-openclaw-native-guard.ts` if the new service test is not auto-discovered

- [ ] **Step 1: Update operator and architecture docs**

Document pairing, cookie paths/TTL, strict Origin, SSE read capability, launcher secret isolation, manual `api:start` pairing output, and 401/403 troubleshooting. Replace direct unauthenticated PowerShell calls to native-supervision with the supported launcher/frontend flow or an explicit cookie-jar bootstrap example that never prints token values.

- [ ] **Step 2: Run focused security regression**

```powershell
npm run verify:native-guard
npm run test:frontend
npm run test:openclaw:portable
npm run typecheck
npm run typecheck:openclaw-plugin
npm run typecheck:frontend
```

Expected: all pass.

- [ ] **Step 3: Run repository verification**

```powershell
npm run verify:all
git diff --check
git status --short
```

Expected: `verify:all` passes. Working tree contains only the intentional unstaged deletion of `docs/p4-native-tool-bypass-defense-plan.md`.

- [ ] **Step 4: Commit documentation/verifier changes**

```powershell
git add docs/architecture.md docs/C/openclaw-main-global-supervision-blackbox.md docs/C/openclaw-detection-live-runbook.md scripts/verify-openclaw-native-guard.ts
git commit -m "docs: describe native supervision browser access"
```

- [ ] **Step 5: Final reviews**

Run whole-branch spec, code-quality, and security reviews. Reviewers must check capability separation, cookie scope, Origin handling, launcher environment inheritance, token logging, unauthorized replay, Guard-OFF behavior, detection coexistence, and frontend reconnect behavior. Every finding requires a failing regression test before the fix.
