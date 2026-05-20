# Agent Guard

Agent Guard is an MVP framework for evaluating the behavior safety of an Agent inside a system-provided MCP test environment.

The only tested object is the Agent. MCP Server, Tool, Resource, Prompt, Tool Response templates, risk rules, and test cases are internal test fixtures.

## Module Layout

```txt
configs/        Internal tools, resources, prompts, tool responses, rules, test cases, and test oracles
src/agent/      Agent adapter boundary
src/config/     Config loading and TestContext construction
src/sandbox/    System-provided MCP sandbox boundary
src/runner/     Test execution boundary
src/monitor/    Interaction trace recording boundary
src/risk/       Rule evaluation, evidence chain, and attack chain boundary
src/report/     RiskReport and ReportArtifact boundary
src/shared/     Shared contracts and small utilities
outputs/        Generated traces and reports
docs/           Architecture and interface specifications
```

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
npm run typecheck
```
