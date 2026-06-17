import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, PlayCircle, ServerCrash } from "lucide-react";
import { AgentConfig, checkAgent, getBootstrap, runDemoCase, TestCase } from "../../lib/api/demoRuntime";
import { createRunGroupId, saveRun } from "../../lib/models/runStore";
import { StateBlock } from "../../components/ui/StateBlock";

type RunScope = "quick" | "full";
type RunProgress = {
  phase: "idle" | "checking" | "running" | "saving" | "completed" | "failed";
  label: string;
  current: number;
  total: number;
};

const defaultAgent: AgentConfig = {
  agentId: "agent.openclaw.demo",
  name: "OpenClaw Demo Agent",
  adapterKind: "openclaw",
  adapterType: "openclaw",
  endpoint: "",
  workspace: "",
  timeoutMs: 8000,
};

export function NewTestRun() {
  const navigate = useNavigate();
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: getBootstrap });
  const [agent, setAgent] = useState<AgentConfig>(defaultAgent);
  const [mode, setMode] = useState<"vulnerable" | "guarded">("vulnerable");
  const [scope, setScope] = useState<RunScope>("quick");
  const [selectedScenarioIds, setSelectedScenarioIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<RunProgress>({ phase: "idle", label: "Ready", current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const scenarios = bootstrap.data?.redTeamScenarios.scenarios || [];
  const enabledCases = useMemo(() => (bootstrap.data?.testCases || []).filter((item) => item.enabled), [bootstrap.data?.testCases]);
  const caseById = useMemo(() => new Map(enabledCases.map((item) => [item.caseId, item])), [enabledCases]);

  useEffect(() => {
    if (!selectedScenarioIds.length && scenarios.length) {
      setSelectedScenarioIds(scenarios.slice(0, 2).map((scenario) => scenario.scenarioId));
    }
  }, [scenarios, selectedScenarioIds.length]);

  const selectedCases = useMemo(() => {
    if (scope === "full") return enabledCases;
    const ids = new Set(
      scenarios
        .filter((scenario) => selectedScenarioIds.includes(scenario.scenarioId))
        .map((scenario) => scenario.caseIds[0])
        .filter(Boolean),
    );
    const cases = [...ids].map((caseId) => caseById.get(caseId)).filter((item): item is TestCase => Boolean(item));
    return cases.length ? cases : enabledCases.slice(0, 2);
  }, [caseById, enabledCases, scenarios, scope, selectedScenarioIds]);

  function updateAgent<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) {
    setAgent((current) => ({ ...current, [key]: value, adapterType: key === "adapterKind" ? String(value) : current.adapterType }));
  }

  function applyTemplate(adapterKind: AgentConfig["adapterKind"]) {
    const endpoint = adapterKind === "http_sample" ? bootstrap.data?.httpAgentContract.sampleEndpoint || "" : "";
    setAgent({
      ...defaultAgent,
      adapterKind,
      adapterType: adapterKind,
      name: adapterKind === "http_sample" ? "Local HTTP Sample Agent" : adapterKind === "mock" ? "Mock Guarded Agent" : "OpenClaw Demo Agent",
      agentId: adapterKind === "http_sample" ? "agent.http_sample" : adapterKind === "mock" ? "agent.mock.guarded" : "agent.openclaw.demo",
      endpoint,
    });
    setMode(adapterKind === "mock" ? "guarded" : "vulnerable");
  }

  async function startRun() {
    if (!bootstrap.data || !selectedCases.length) return;
    setError(null);
    setProgress({ phase: "checking", label: "Checking agent", current: 0, total: selectedCases.length });

    try {
      await checkAgent(agent, bootstrap.data);
      const results = [];
      for (let index = 0; index < selectedCases.length; index += 1) {
        const testCase = selectedCases[index];
        setProgress({
          phase: "running",
          label: `${testCase.caseName}`,
          current: index + 1,
          total: selectedCases.length,
        });
        results.push(
          await runDemoCase({
            caseId: testCase.caseId,
            mode,
            agent,
            selectedToolIds: testCase.toolIds,
            selectedResourceIds: testCase.resourceIds,
            selectedPromptIds: testCase.promptIds,
            selectedRuleIds: bootstrap.data.riskRules.map((rule) => rule.ruleId),
            customInstruction: testCase.task.instruction,
          }),
        );
      }

      setProgress({ phase: "saving", label: "Saving run", current: selectedCases.length, total: selectedCases.length });
      const runGroupId = createRunGroupId();
      saveRun({
        runGroupId,
        createdAt: results[0]?.trace.startedAt || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "completed",
        agent,
        mode,
        caseIds: selectedCases.map((testCase) => testCase.caseId),
        results,
      });
      setProgress({ phase: "completed", label: "Completed", current: selectedCases.length, total: selectedCases.length });
      navigate(`/runs/${runGroupId}`);
    } catch (runError) {
      setProgress((current) => ({ ...current, phase: "failed", label: "Failed" }));
      setError(runError instanceof Error ? runError.message : String(runError));
    }
  }

  const progressPercent = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Run Setup</p>
          <h1>New Test Run</h1>
        </div>
        <button className="primary-action" type="button" onClick={startRun} disabled={progress.phase === "running" || progress.phase === "checking"}>
          {progress.phase === "running" || progress.phase === "checking" ? <Loader2 className="spin" size={18} /> : <PlayCircle size={18} />}
          <span>开始检测</span>
        </button>
      </header>

      {bootstrap.isError ? (
        <StateBlock kind="error" title="API runtime unavailable" detail="请先启动 npm run demo，再运行正式前端。" />
      ) : null}

      <div className="form-grid">
        <section className="panel">
          <div className="section-heading">
            <h2>Agent</h2>
          </div>
          <div className="segmented">
            {(["openclaw", "http_sample", "mock"] as const).map((adapterKind) => (
              <button
                key={adapterKind}
                className={agent.adapterKind === adapterKind ? "selected" : ""}
                type="button"
                onClick={() => applyTemplate(adapterKind)}
              >
                {adapterKind}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Name</span>
            <input value={agent.name} onChange={(event) => updateAgent("name", event.target.value)} />
          </label>
          <label className="field">
            <span>Agent ID</span>
            <input value={agent.agentId} onChange={(event) => updateAgent("agentId", event.target.value)} />
          </label>
          <label className="field">
            <span>Endpoint</span>
            <input value={agent.endpoint} onChange={(event) => updateAgent("endpoint", event.target.value)} placeholder="Optional for local adapter" />
          </label>
          <label className="field">
            <span>Timeout</span>
            <input
              type="number"
              min={1000}
              step={500}
              value={agent.timeoutMs}
              onChange={(event) => updateAgent("timeoutMs", Number(event.target.value))}
            />
          </label>
        </section>

        <section className="panel">
          <div className="section-heading">
            <h2>Scope</h2>
          </div>
          <div className="segmented">
            <button className={scope === "quick" ? "selected" : ""} type="button" onClick={() => setScope("quick")}>
              Quick
            </button>
            <button className={scope === "full" ? "selected" : ""} type="button" onClick={() => setScope("full")}>
              Full
            </button>
          </div>
          <label className="field">
            <span>Mode</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as "vulnerable" | "guarded")}>
              <option value="vulnerable">vulnerable</option>
              <option value="guarded">guarded</option>
            </select>
          </label>
          <div className="scenario-list">
            {scenarios.map((scenario) => (
              <label key={scenario.scenarioId} className={`scenario-row ${scope === "full" ? "muted" : ""}`}>
                <input
                  type="checkbox"
                  disabled={scope === "full"}
                  checked={selectedScenarioIds.includes(scenario.scenarioId)}
                  onChange={(event) => {
                    setSelectedScenarioIds((current) =>
                      event.target.checked ? [...current, scenario.scenarioId] : current.filter((id) => id !== scenario.scenarioId),
                    );
                  }}
                />
                <span>
                  <strong>{scenario.name}</strong>
                  <small>{scenario.caseIds.join(" / ")}</small>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="panel run-panel">
          <div className="section-heading">
            <h2>Progress</h2>
          </div>
          <div className="run-counter">
            <strong>{selectedCases.length}</strong>
            <span>cases selected</span>
          </div>
          <div className="progress-track" aria-label="Run progress">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          <p className="progress-label">{progress.label}</p>
          {progress.phase === "completed" ? (
            <p className="success-line">
              <CheckCircle2 size={16} />
              Run completed
            </p>
          ) : null}
          {error ? (
            <p className="error-line">
              <ServerCrash size={16} />
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </section>
  );
}
