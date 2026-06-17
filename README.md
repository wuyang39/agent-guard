# Agent Guard

Agent Guard is an MVP framework for evaluating the behavior safety of an Agent inside a system-provided MCP test environment.

The only tested object is the Agent. MCP Server, Tool, Resource, Prompt, Tool Response templates, risk rules, and test cases are internal test fixtures.

## Module Layout

```txt
backend/        Backend runtime, API boundary, Agent execution, MCP sandbox, monitoring, risk, and report modules
frontend/       Web console workspace for dashboard, traces, risk reports, configs, and system views
packages/       Shared packages; contracts is the single front/back interface source
configs/        Internal tools, resources, prompts, tool responses, rules, test cases, oracles, scenarios, and attack-library indexes
outputs/        Generated runs, traces, reports, and exported artifacts
docs/           Architecture, directory, interface, ownership, and development specifications
scripts/        Engineering scripts for validation, build, and local startup
tests/          Cross-system end-to-end tests
third_party/    Vendored reference sources used by line-specific adapters, such as the A-line PyRIT adapted attack library
```

Line-specific implementation notes are grouped under `docs/A/`, `docs/B/`, and `docs/C/`.

See `docs/architecture.md` for the system boundary, directory baseline, dependency rules, and development workflow.

See `docs/ownership.md` for strict A/B/C workspace ownership, shared controlled files, and cross-workspace change rules.

See `docs/README.md` for the documentation index and source-of-truth rules.

## Contract Boundary

`packages/contracts` is the only shared interface package between backend and frontend. Frontend code must not import `backend/src/**`, and backend runtime modules must not place business logic in the contracts package.

## MVP Pipeline

```txt
AgentUnderTest
-> AgentAdapterConfig
-> TestContext
-> TestRun
-> InteractionTrace
-> RiskEvaluationResult
-> RiskReport
-> ReportArtifact[]
```

## Scripts

```bash
npm run demo
npm run demo:p2
npm run frontend
npm run typecheck
npm run verify:all
npm run verify:e2e
```

`npm run demo` starts the isolated display demo from `frontend/demo`. It is for product-flow demonstration only and is not the formal frontend implementation baseline.

`npm run demo:p2` starts the P2 demo services and the formal Vite frontend. The frontend URL is `http://127.0.0.1:5173` by default.

`npm run verify:all` runs the standard typecheck and module verification suite. `npm run verify:e2e` runs the three-stage end-to-end pipeline: pre-supervision detection, supervised rerun, and defense report export.

A-line P2 PyRIT checks:

```bash
npm run verify:a-pyrit-library
npm run pyrit:bridge-smoke
```
