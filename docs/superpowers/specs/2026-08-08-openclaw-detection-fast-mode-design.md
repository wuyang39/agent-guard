# OpenClaw Detection Fast Mode Design

## Goal

Reduce the default competition detection path from multi-minute attempts and oversized reasoning output to a bounded, representative run without weakening Docker isolation or native-guard evidence requirements.

## Design

1. The generated detection-only OpenClaw profile sets `agents.defaults.thinkingDefault` to `"off"` and `agents.defaults.params.maxTokens` to `2048`. User OpenClaw configuration remains untouched.
2. `DetectionSandboxManager` exposes a cloned capability snapshot only after live Gateway validation. `SandboxCoordinatorFactory` wraps the sandbox control client so coordinator capability checks reuse this run-scoped snapshot; HTTP activate, status, revoke, and attestation calls still use the real client.
3. OpenClaw detection defaults use a 90-second attempt timeout, two attempts, and a 3-second exponential retry base. Explicit positive request or environment values continue to override these defaults within existing bounds.
4. The UI and OpenClaw selection service default to five cases. Before execution, cases are stable-sorted so encoded or obfuscated generated cases run after ordinary cases; explicit membership is preserved and only order changes.

## Failure Semantics

- Missing or invalid capability snapshots still fail before any attack case runs.
- Provider timeouts remain retryable, but the second failure ends that case.
- Native-guard evidence, reconciliation, revoke, attestation, and cleanup failures remain fatal.
- Docker isolation and OpenClaw detection concurrency remain unchanged.

## Verification

- Unit tests assert the generated fast model profile.
- Manager/app tests assert cloned, run-scoped capability reuse and no repeated capability CLI calls during activation.
- E2E service tests assert default timing budgets and stable expensive-case ordering.
- Frontend tests assert the 90-second default timeout and five-case default selection.

