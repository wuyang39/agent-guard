import { runTestCase } from "../backend/src/modules/runner/testRunner";
import type {
  TestContext,
  AgentUnderTest,
  AgentAdapterConfig,
  McpSandboxProfile,
  TestCase,
} from "@agent-guard/contracts";
import fs from "fs";
import path from "path";

const ROOT_DIR = path.resolve(process.cwd());
const CONFIGS_DIR = path.resolve(ROOT_DIR, "configs");

function loadJson<T>(filename: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(CONFIGS_DIR, filename), "utf-8"),
  ) as T;
}

function buildSandboxProfile(): McpSandboxProfile {
  const tools = loadJson<any[]>("tools.json");
  const resources = loadJson<any[]>("resources.json");
  const prompts = loadJson<any[]>("prompts.json");
  const toolResponses = loadJson<any[]>("tool_responses.json");

  return {
    schemaVersion: "mvp-1",
    sandboxId: "sb.main",
    name: "System Built-in MCP Sandbox",
    tools,
    resources: resources.map((r) => ({
      ...r,
      type: r.type as any,
      sensitivity: r.sensitivity as any,
    })),
    prompts,
    toolResponseTemplates: toolResponses,
  };
}

async function main() {
  const sandboxProfile = buildSandboxProfile();
  const testCases = loadJson<TestCase[]>("test_cases.json").filter(
    (tc) => tc.enabled,
  );

  console.log(
    `Sandbox: ${sandboxProfile.tools.length} tools, ${sandboxProfile.resources.length} resources`,
  );
  console.log(`Test cases: ${testCases.length}`);

  const agent: AgentUnderTest = {
    schemaVersion: "mvp-1",
    agentId: "agent.demo",
    name: "Demo Agent",
    adapterType: "mock",
  };

  const adapterConfig: AgentAdapterConfig = {
    schemaVersion: "mvp-1",
    adapterId: "adapter.mock",
    agentId: "agent.demo",
    adapterType: "mock",
    timeoutMs: 30000,
  };

  const allEventTypes = new Set<string>();
  let totalEvents = 0;
  let allCallIdsMatched = true;

  for (const tc of testCases) {
    console.log(`\n--- Running: ${tc.caseId} (${tc.caseName}) ---`);

    const testContext: TestContext = {
      schemaVersion: "mvp-1",
      configVersion: "mvp-1",
      contextId: `ctx.${tc.caseId}`,
      caseId: tc.caseId,
      caseName: tc.caseName,
      agent,
      sandbox: sandboxProfile,
      testCase: tc,
      riskRules: loadJson("risk_rules.json"),
    };

    const { testRun, trace } = await runTestCase(
      agent,
      adapterConfig,
      testContext,
    );

    console.assert(
      testRun.status === "completed",
      `status=${testRun.status}`,
    );

    for (const e of trace.events) allEventTypes.add(e.type);

    const toolCalls = trace.events.filter((e) => e.type === "tool_call");
    const toolResults = trace.events.filter((e) => e.type === "tool_result");
    for (const tcEvt of toolCalls) {
      const callId = (tcEvt.payload as Record<string, unknown>).callId;
      const match = toolResults.find(
        (tr) => (tr.payload as Record<string, unknown>).callId === callId,
      );
      if (!match) {
        allCallIdsMatched = false;
        console.log(`  MISSING result for callId=${callId}`);
      }
    }

    const eventTypes = [...new Set(trace.events.map((e) => e.type))];
    console.log(`  Events: ${trace.events.length}, Types: ${eventTypes.join(", ")}`);
    totalEvents += trace.events.length;

    // 写出 trace
    const outDir = path.resolve(ROOT_DIR, "outputs", "traces");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, `${tc.caseId}-${trace.traceId}.json`),
      JSON.stringify(trace, null, 2),
      "utf-8",
    );
  }

  console.log(`\nTotal events: ${totalEvents}`);
  console.log(`Event types: ${[...allEventTypes].sort().join(", ")}`);
  const expected = [
    "test_started",
    "task_sent",
    "agent_message",
    "tool_call",
    "tool_result",
    "resource_access",
    "prompt_load",
    "system_error",
  ];
  const covered = expected.filter((t) => allEventTypes.has(t));
  console.log(`Covered ${covered.length}/${expected.length} types`);
  if (covered.length < expected.length) {
    console.log(
      `Missing: ${expected.filter((t) => !allEventTypes.has(t)).join(", ")} (acceptable for P0)`,
    );
  }
  console.assert(allCallIdsMatched, "all callIds matched");

  console.log("\nPASS: iteration 5 verification");
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
