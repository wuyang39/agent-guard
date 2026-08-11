# OpenClaw Portable Install And Runbook

This runbook is the supported Windows workflow for a fresh Agent Guard clone. It uses the public Agent Guard OpenClaw fork and the public immutable GHCR sandbox image. OpenClaw source, build output, profile state, credentials, logs, and generated evidence remain under ignored `outputs/` paths.

## Pinned Distribution

The machine-readable source of truth is `configs/openclaw-distribution.json`.

| Artifact | Pinned value |
|---|---|
| OpenClaw repository | `https://github.com/wuyang39/openclaw-agentguard.git` |
| Branch | `agentguard-2026.7.1` |
| Commit | `d895b2dbfe7c8a2d8cb9f9827df315d11d8939fa` |
| Version | `2026.7.1-agentguard.1` |
| Sandbox image | `ghcr.io/wuyang39/openclaw-sandbox@sha256:01630cbb3486af7c0908b326d956d20722fde3ceada2775b53e547370a4e0e38` |

Do not replace the commit or digest with a branch tip, tag, or `latest`.

## Prerequisites

- Windows PowerShell 5.1 or PowerShell 7
- Git
- Docker Desktop with the Linux container daemon running
- Node.js `>=22.22.3 <23`, `>=24.15.0 <25`, or `>=25.9.0`
- A model-provider account and credential supported by OpenClaw

The scripts use `corepack pnpm`; a global `pnpm` installation is not required.

## Bootstrap

From the Agent Guard repository root:

```powershell
npm run openclaw:bootstrap
```

The bootstrap performs these operations idempotently:

1. Runs `npm ci` for Agent Guard.
2. Clones the public OpenClaw fork into `outputs/openclaw-agentguard-active` and verifies the exact commit.
3. Installs fork dependencies and builds `gatewayWatch` when the matching buildstamp is absent.
4. Pulls and verifies the exact GHCR digest.
5. Builds and installs `agent-guard-supervision` into the isolated profile.
6. Creates the user-root profile `%USERPROFILE%\.agent-guard\openclaw-native-guard-profile` and writes the credential-free environment helper `outputs/agent-guard-openclaw-env.ps1`.

Existing fork changes are never overwritten. A dirty or mismatched checkout fails with an explicit error. The profile deliberately lives below the OS user root because the Native Guard marker store rejects repository and drive-root locations.
When rerunning bootstrap after the first setup, stop the four managed services first with `npm run openclaw:stop` so Windows can replace the local Node dependencies.

## Configure A Model

This is the only device-specific interactive step. Credentials are not part of Git, the fork, the Docker image, or the generated environment helper.

```powershell
. .\outputs\agent-guard-openclaw-env.ps1
node $env:OPENCLAW_CLI configure
node $env:OPENCLAW_CLI models status --json --check
```

Continue only after `models status --json --check` exits with code `0`.

## Start And Stop

Start the supervised OpenClaw Gateway, sample agent, backend, and frontend:

```powershell
npm run openclaw:start
```

The launcher opens a one-time browser pairing URL after all four services are ready. If Windows cannot open the browser, startup remains successful and the same URL is printed once in the controlling terminal. The fragment is removed from the address bar before the frontend exchanges it for an HttpOnly control cookie. A fresh pairing URL is generated on every launcher start and is never written to the service logs, PID registry, or runtime plan.

For a terminal-only start, print the pairing URL once instead of opening the browser:

```powershell
npm run openclaw:start -- -NoBrowser
```

Open the printed URL in the browser that will control supervision. A plain `http://127.0.0.1:5173` tab can use an existing unexpired pairing cookie, but a new browser profile or a restarted backend must use the new pairing URL.

URLs:

```txt
Frontend:     http://127.0.0.1:5173
API status:   http://127.0.0.1:3100/api/v1/system/status
Sample agent: http://127.0.0.1:7001/health
OpenClaw:     http://127.0.0.1:18789
```

The permanent Gateway is launched only through `openclaw-guard-launcher.ts` and supports normal OpenClaw conversations plus supervision. Every OpenClaw detection RunGroup still creates a separate isolated Gateway generation, attests it, uses it sequentially, and cleans it up. The conversation Gateway is never reused as a detection trust root.

Stop all four persistent services and their child processes:

```powershell
npm run openclaw:stop
```

Service logs and the PID registry are written below `outputs/runs/portable-services` and `outputs/runtime`.
The local control token is generated once at `outputs/runtime/agent-guard-control-token.txt`. Load it only in a local terminal that needs to call manual Native Guard control APIs:

```powershell
$env:AGENT_GUARD_CONTROL_TOKEN = (Get-Content -Raw .\outputs\runtime\agent-guard-control-token.txt).Trim()
```

The Gateway receives only its Gateway credential and host-attestation path. The sample agent and frontend receive no Gateway, control, bootstrap, or frontend-Origin secrets. The backend alone receives the control token, one-time UI bootstrap token, exact frontend Origin, and Gateway credential.

## Local Acceptance

Run fast contract and integration checks first:

```powershell
npm run test:openclaw:portable
npm run verify:native-guard:real
npm run verify:native-guard:docker -- --required
```

Then run the staged product black-box load test. It creates exactly one RunGroup for 5 cases, requires a clean terminal result, verifies Docker cleanup, and only then starts the 30-case RunGroup:

```powershell
npm run verify:openclaw:load
```

To run a single smaller stage while diagnosing provider configuration:

```powershell
npm run verify:openclaw:load -- --case-counts=5
```

The verifier uses a 180-second per-case OpenClaw timeout, polls until terminal state, writes JSONL evidence to `outputs/runs/portable-load-*.jsonl`, and stops immediately on the first failed stage. It never masks a coverage breach by creating a replacement RunGroup.

## Troubleshooting

| Symptom | Action |
|---|---|
| Bootstrap rejects Node.js | Install a version in the supported engine ranges. |
| Fork buildstamp mismatch | Remove only the generated `outputs/openclaw-agentguard-active` directory after preserving any intentional local changes, then rerun bootstrap. |
| GHCR pull fails | Confirm Docker Desktop is running and anonymous access to `ghcr.io/wuyang39/openclaw-sandbox` is allowed. |
| `models status --check` fails | Rerun `node $env:OPENCLAW_CLI configure` in the generated isolated environment. |
| Start reports a port in use | Stop the earlier Agent Guard instance; do not silently reuse an unknown process. |
| Supervision controls return `401` | Restart with `npm run openclaw:start` and use the newly opened pairing tab; backend restarts invalidate old cookies. |
| Supervision controls return `403` | Use the exact launcher URL on `127.0.0.1` and the configured frontend port; `localhost`, a different port, or a copied API URL is a different Origin. |
| Detection fails before case 1 | Check the immutable image, fork buildstamp, plugin inventory, and model authentication. |
| Detection times out | Inspect the RunGroup trace and provider response. Missing reconciliation remains a fatal coverage failure. |
| Load verification reports residual Docker resources | Preserve the JSONL evidence and inspect resources carrying `agent-guard.run-group=<runGroupId>`. |
