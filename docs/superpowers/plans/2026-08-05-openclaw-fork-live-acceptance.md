# OpenClaw Fork Live Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and prove a controlled OpenClaw fork whose native-tool guard capabilities are verified without changing the host's global OpenClaw installation.

**Architecture:** Agent Guard defines one strict, host-produced live-attestation contract consumed by the control client, external launcher, and Docker live verifier. A dedicated fd3 bootstrap pipe binds each spawned Gateway process to a fresh Ed25519 public key before any HTTP request; the Gateway's reserved core route signs its instance identity and live registry with the corresponding in-memory private key. The fork implements the seven required host capabilities and this process-bound identity contract. A digest-pinned container image packages the fork and plugin, while the host continues to use the official global OpenClaw unless `OPENCLAW_CLI` explicitly selects the fork.

**Tech Stack:** TypeScript, Node.js, PowerShell, OpenClaw plugin SDK, Docker BuildKit, Node test runner.

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
- [x] Implement isolated CLI selection and a real capability probe.
- [x] Add all tests to `verify:native-guard` and run `npm run verify:all`.
- [x] Commit with `fix: remove mocked OpenClaw Docker capability verification`.

### Task 3: Implement the controlled OpenClaw fork

**Repository:** `E:\Projects\openclaw-agentguard`

- [ ] Clone `https://github.com/openclaw/openclaw.git`, check out the source matching installed `2026.7.1-2`, and create branch `agentguard/2026.7.1`.
- [ ] Add failing upstream tests for each of the seven host capabilities and the exact `native-guard-1` registry output.
- [ ] Implement registrar results, live SDK returns, final hook ownership, trusted policy registration, recovery service registration, post-approval lease recheck, JSON-only parameter provenance, and live registry reporting.
- [ ] In every `startGatewayServer`, generate a new Ed25519 keypair, write exactly one bounded `native-guard-bootstrap-1` JSON line to the declared fd3 bootstrap pipe, close fd3, and retain the private key only in that server instance's memory.
- [ ] Keep the spawned Gateway process alive for the entire guarded detection lifetime. The launcher must expose one stable completion promise for that exact process; resolving or rejecting it before Agent Guard requests shutdown is fatal and a new process must use a new generation, keypair, and instance ID.
- [ ] Reserve `/agent-guard/native-guard/v1/gateway-attestation` in Gateway core so plugins cannot register or shadow it. Authenticate the route, bind it to build `VERSION`, the per-server `gatewayInstanceId`, the active live registry, and the request challenge, then sign the canonical proof with the per-server key.
- [ ] Set version `2026.7.1-agentguard.1`, run the upstream test/build suite, and create an npm package tarball.
- [ ] Commit each capability independently and record the final fork commit.

### Task 4: Build and attest the immutable sandbox image

**Files:**
- Create: `docker/openclaw-sandbox/Dockerfile`
- Create: `docker/openclaw-sandbox/README.md`
- Create: `scripts/build-openclaw-sandbox.ps1`

- [ ] Build the Agent Guard plugin and fork tarball without `npm link`.
- [ ] Build a Node 22 based non-root image containing Python and network probe tools, with no embedded credentials.
- [ ] Push the image, capture its repository digest, generate SBOM/provenance, and verify image labels match both source commits.
- [ ] Verify `openclaw --version` and the exact live registry contract inside the image.
- [ ] Commit with `build: add reproducible OpenClaw guard sandbox image`.

### Task 5: Run live acceptance and archive evidence

- [ ] Set `OPENCLAW_CLI` to the fork wrapper and `OPENCLAW_HOME` to an isolated profile; leave the global OpenClaw unchanged.
- [ ] Run launcher negative/positive/maintenance tests against real registries.
- [ ] Prove a same-port fake server that receives the bearer token and fresh challenge still fails when it cannot sign with the fd3-bound private key.
- [ ] Set `AGENT_GUARD_DETECTION_IMAGE` to the new repository digest and ensure `AGENT_GUARD_ALLOW_DOCKER_TEST_SKIP` is absent.
- [ ] Run `verify:native-guard:docker`, `verify:native-guard:all`, and `verify:all`.
- [ ] Execute the ten manual runbook scenarios and archive logs, JSONL, Hook evidence, Docker inspect output, SBOM, fork commit, plugin commit, and image digest.
- [ ] Request final security review; release only with zero open Critical or High findings.
