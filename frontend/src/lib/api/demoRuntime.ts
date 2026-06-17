export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export type AgentConfig = {
  agentId: string;
  name: string;
  adapterKind: "openclaw" | "http_sample" | "mock" | "api";
  adapterType: string;
  endpoint: string;
  workspace: string;
  timeoutMs: number;
};

export type TestCase = {
  caseId: string;
  caseName: string;
  description: string;
  attackEntryType: string;
  enabled: boolean;
  task: {
    instruction: string;
    promptIds?: string[];
    resourceIds?: string[];
  };
  toolIds: string[];
  resourceIds: string[];
  promptIds: string[];
};

export type RedTeamScenario = {
  scenarioId: string;
  name: string;
  attackType: string;
  caseIds: string[];
  expectedWeaknessCategories?: string[];
  recommendedPolicyTemplateIds?: string[];
};

export type RiskRule = {
  ruleId: string;
  name: string;
  riskLevel: RiskLevel;
  category: string;
};

export type BootstrapPayload = {
  testCases: TestCase[];
  riskRules: RiskRule[];
  redTeamScenarios: {
    scenarios: RedTeamScenario[];
  };
  agentTemplates: Array<{
    label: string;
    adapterKind: AgentConfig["adapterKind"];
    mode: "vulnerable" | "guarded";
  }>;
  httpAgentContract: {
    sampleEndpoint: string;
    sampleStartEndpoint: string;
    sampleStatusEndpoint: string;
  };
};

export type DemoRunResult = {
  context: {
    caseId: string;
    caseName: string;
    agent: AgentConfig;
  };
  risk: {
    riskLevel: RiskLevel;
    findingCount: number;
  };
  trace: {
    traceId: string;
    runId: string;
    caseId: string;
    status: string;
    startedAt: string;
    endedAt?: string;
    events: TraceEvent[];
  };
  evaluation: {
    findings: Finding[];
    highestRiskLevel?: RiskLevel;
  };
  report: Record<string, unknown>;
  detectionReport: Record<string, unknown>;
  riskProfile: Record<string, unknown>;
  policyPack: {
    policyPackId?: string;
    policies?: Policy[];
  };
  supervisionRecords: SupervisionRecord[];
  defenseReport: Record<string, unknown>;
  artifacts: Record<string, string>;
};

export type TraceEvent = {
  eventId: string;
  sequence: number;
  timestamp: string;
  eventType: string;
  source: string;
  payload: Record<string, unknown>;
};

export type Finding = {
  findingId: string;
  ruleId: string;
  name: string;
  title?: string;
  category: string;
  riskLevel: RiskLevel;
  evidenceEventIds?: string[];
  evidence?: unknown[];
};

export type Policy = {
  policyId?: string;
  title?: string;
  name?: string;
  action?: string;
  targetType?: string;
  severity?: RiskLevel;
  description?: string;
  sourceWeaknessIds?: string[];
};

export type SupervisionRecord = {
  recordId?: string;
  runtimeSessionId?: string;
  eventId?: string;
  timestamp?: string;
  decision?: {
    action?: string;
    reason?: string;
  };
  matchedPolicyIds?: string[];
  target?: {
    targetType?: string;
    targetId?: string;
  };
};

type RunCaseInput = {
  caseId: string;
  mode: "vulnerable" | "guarded";
  agent: AgentConfig;
  selectedToolIds: string[];
  selectedResourceIds: string[];
  selectedPromptIds: string[];
  selectedRuleIds: string[];
  customInstruction: string;
};

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function getBootstrap(): Promise<BootstrapPayload> {
  return fetchJson<BootstrapPayload>("/api/bootstrap");
}

export async function checkAgent(agent: AgentConfig, bootstrap?: BootstrapPayload) {
  if (agent.adapterKind === "http_sample") {
    const endpoint = bootstrap?.httpAgentContract.sampleStartEndpoint || "/api/sample-agent/start";
    return fetchJson<{ running: boolean; endpoint: string; message?: string }>(endpoint, { method: "POST" });
  }

  return {
    running: true,
    endpoint: agent.endpoint || "local deterministic sandbox",
    message: agent.adapterKind === "openclaw" && !agent.endpoint ? "Using local deterministic adapter path." : "Agent configuration accepted.",
  };
}

export function runDemoCase(input: RunCaseInput): Promise<DemoRunResult> {
  return fetchJson<DemoRunResult>("/api/run-demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      caseId: input.caseId,
      mode: input.mode,
      customInstruction: input.customInstruction,
      agent: input.agent,
      selectedToolIds: input.selectedToolIds,
      selectedResourceIds: input.selectedResourceIds,
      selectedPromptIds: input.selectedPromptIds,
      selectedRuleIds: input.selectedRuleIds,
      supervisionOptions: { enabled: true, applyPolicy: true },
    }),
  });
}
