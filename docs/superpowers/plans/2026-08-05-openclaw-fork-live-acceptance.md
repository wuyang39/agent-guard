# OpenClaw Fork Live Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove a controlled OpenClaw fork whose native-tool guard capabilities are verified without changing the host's global OpenClaw installation.

**Architecture:** Agent Guard defines one strict, host-produced live-attestation contract consumed by the control client, external launcher, and Docker live verifier. A dedicated fd3 bootstrap pipe binds each spawned Gateway process to a fresh Ed25519 public key before any HTTP request; the Gateway's reserved core route signs its instance identity and live registry with the corresponding in-memory private key. The fork and plugin run in a host-isolated profile selected by explicit CLI paths. A digest-pinned Docker image contains only the agent's native-tool sandbox dependencies; it does not package OpenClaw or the plugin.

**Tech Stack:** TypeScript, Node.js, PowerShell, OpenClaw plugin SDK, Docker BuildKit, Node test runner.

**Runtime prerequisite:** Use Node.js `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`, exactly matching the controlled fork's `package.json` engines.

---

### Task 1: Close Agent Guard acceptance gaps

**Files:**
- Create: `backend/src/modules/openclaw/nativeGuardLiveCapability.ts`
- Create: `backend/src/modules/openclaw/nativeGuardLiveCapability.test.ts`
- Modify: `backend/src/modules/openclaw/openclawControlClient.ts`
- Modify: `backend/src/modules/openclaw/openclawControlClient.test.ts`
- Modify: `backend/src/modules/openclaw/detectionSandboxManager.ts`
- Modify: `backend/src/modules/openclaw/detectionSandboxManager.test.ts`
- Modify: `scripts/openclaw-guard-launcher.ts`
- Create: `scripts/openclaw-guard-launcher.test.ts`

- [x] Define an exact `native-guard-1` registry attestation schema covering live registrar status, final hook ownership, trusted policy, recovery service, post-approval lease recheck, and JSON-only parameter provenance.
- [x] Define the exact `native-guard-bootstrap-1` fd3 record, require a fresh per-Gateway Ed25519 public key, and reject missing, duplicate, malformed, oversized, stalled, or non-Ed25519 bootstrap data before HTTP readiness probing.
- [x] Require the reserved core `POST /agent-guard/native-guard/v1/gateway-attestation` response to carry an exact `native-guard-gateway-1` proof signed by the fd3-bound key; cover unsigned, wrong-key, altered, and port-hijack responses.
- [x] Bind the full detection operation to the exact authenticated child generation. An unexpected `close`, `exit`, or process-lifetime rejection after attestation must revoke credentials, abort the active sample, prevent later samples, and fail the run; only cleanup-initiated shutdown is expected.
- [x] Bound readiness status JSON to 64 KiB, reject every `Content-Encoding`, require JSON content type, and make the 500 ms attempt abort cover stalled body reads and cancellation.
- [x] Bound fd3 bootstrap with a 60-second absolute deadline and the subsequent readiness phase with an independent 120-second absolute deadline; cover the readiness default with TDD regression.
- [x] Write failing parser, control-client, sandbox, and launcher tests for missing, malformed, spoofed, and complete attestations.
- [x] Implement the shared parser and require its result in every guarded capability decision.
- [x] Make marker inventory errors fail closed and make Windows `.cmd` CLI invocation explicit and bounded.
- [x] Run focused tests and `npm run typecheck`.
- [x] Commit with `fix: require real OpenClaw live capability attestation`.

### Task 2: Make isolated installation and Docker verification real

**Files:**
- Modify: `scripts/install-openclaw-native-guard.ps1`
- Create: `scripts/install-openclaw-native-guard.test.ts`
- Modify: `scripts/verify-openclaw-detection-sandbox.ts`
- Create: `scripts/verify-openclaw-detection-sandbox.test.ts`
- Modify: `scripts/verify-openclaw-native-guard.ts`

- [x] Write failing tests proving the installer resolves `OPENCLAW_CLI`, accepts only the exact `2026.7.1-agentguard.1` controlled fork at base `2026.7.1` or an official stable version `>=2026.7.2`, requires live attestation on both routes, and never falls back to the global binary.
- [x] Write failing tests proving the live Docker verifier has no injected capability result and rejects the official host binary or a fork without live attestation.
- [x] Implement isolated CLI selection and a real capability probe. The installer accepts root `openclaw.mjs` and executes `.js`/`.mjs`/`.cjs` entries through Node without a wrapper.
- [x] Require an explicitly created isolated `OPENCLAW_HOME` and `OPENCLAW_CONFIG_PATH`; never fall back to the user's default profile.
- [x] Add all tests to `verify:native-guard` and run the implementation-stage `npm run verify:all`; this historical evidence does not close the final worktree rerun in Task 5.
- [x] Commit with `fix: remove mocked OpenClaw Docker capability verification`.

### Task 3: Implement the controlled OpenClaw fork

**Accepted artifact:** `<agent-guard-root>/outputs/openclaw-agentguard-active`

- [x] Pin the accepted artifact HEAD and `dist/.buildstamp` to exact fork commit `2d55b950f357a8186eff433ca666a690d484a8e0`; fail fast on either mismatch.
- [x] Stop rebuilding acceptance from the moving `E:\Projects\openclaw-agentguard` branch. Consume the imported exact artifact instead.
- [x] Add upstream tests for the seven host capabilities and exact `native-guard-1` registry output.
- [x] Implement registrar results, live SDK returns, final hook ownership, trusted policy registration, recovery service registration, post-approval lease recheck, JSON-only parameter provenance, and live registry reporting.
- [x] Generate a per-Gateway Ed25519 keypair, emit one bounded `native-guard-bootstrap-1` fd3 record, and keep the private key in the server instance only.
- [x] Keep the exact Gateway child observable for the guarded detection lifetime and fail the run on unexpected exit.
- [x] Reserve and authenticate `/agent-guard/native-guard/v1/gateway-attestation`, bind it to build identity, instance identity, live registry and challenge, then sign the canonical proof.
- [x] Build the source artifact with `node scripts/build-all.mjs gatewayWatch` and bind `dist/.buildstamp` to the pinned fork commit. Acceptance consumes this fixed artifact and does not repeat the build from a moving branch.
- [x] Use root `openclaw.mjs` as the runtime entrypoint and `dist/cli/native-guard-inspector.js` as the production capability inspector.
- [ ] Publish/export the exact fork artifact for other machines. Until then it is not obtainable from OpenClaw upstream or a public package registry and must be imported out of band before acceptance.

### Task 4: Build and attest the immutable sandbox image

**Files:**
- Create: `docker/openclaw-sandbox/Dockerfile`
- Create: `docker/openclaw-sandbox/README.md`
- Create: `scripts/build-openclaw-sandbox.ps1`

- [x] Add `docker/openclaw-sandbox/Dockerfile`, its README and `scripts/build-openclaw-sandbox.ps1` as the reproducible local build entrypoint.
- [x] Build a non-root, read-only-friendly tool sandbox containing `python3`, `sh`, `timeout` and required probes, with no embedded credentials, OpenClaw, or Agent Guard plugin.
- [x] Build and locally register `openclaw-sandbox@sha256:01630cbb3486af7c0908b326d956d20722fde3ceada2775b53e547370a4e0e38`; treat the build script's final digest output as authoritative for local acceptance.
- [x] Keep Gateway and plugin execution on the host isolated profile; use the image only for agent native tools and the controlled sink.
- [x] Re-run the required default/controlled Docker gate against the new `01630c...` digest. Both cases PASS in 122.2 seconds and both cleanup rounds leave zero labeled containers/networks.
- [ ] Push a release image and archive SBOM/provenance. The current digest exists only in the validated machine's local Docker store, so a new machine cannot assume `docker pull` availability.

### Task 5: Run live acceptance and archive evidence

- [x] Set `OPENCLAW_CLI` to the artifact root `openclaw.mjs`, `TEST_OPENCLAW_AGENTGUARD_CLI` to production `dist/cli/native-guard-inspector.js`, and create explicit isolated home/config/state/workspace paths; leave global OpenClaw unchanged.
- [x] Run launcher negative, positive and maintenance tests against real registries, including a mandatory real spawned child.
- [x] Prove a same-port fake server that receives the bearer token and fresh challenge still fails when it cannot sign with the fd3-bound private key.
- [x] Run a fresh real registry gate with the exact fork artifact and production inspector.
- [x] Set `AGENT_GUARD_DETECTION_IMAGE` to the new local `01630c...` digest and run required default/controlled Docker cases without skip. Controlled sink reachability, blocked Internet/canary/socket access and zero labeled residuals all pass in a fresh 122.2-second run.
- [ ] Run and archive the final `npm run verify:native-guard:all`, complete non-live regression suite and `npm run verify:all`; the fresh focused real-registry result does not close this item.
- [ ] Execute the ten manual runbook scenarios and archive logs, JSONL, Hook evidence, Docker inspect output, SBOM, fork commit, plugin commit, and image digest.
- [ ] Run final `git diff --check`, scope review and secret scan; inspect every match rather than shrinking the scan boundary.
- [ ] Request final release security review; this remains competition-external release hardening.
