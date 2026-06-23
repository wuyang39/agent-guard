import { useEffect, useState } from "react";
import { ErrorBlock } from "../../components/ui/StateBlock";
import { agentGuardApi } from "../../lib/api/client";
import type {
  AgentAdapterKind,
  AgentCheckResult,
  AgentConnectionConfig,
} from "../../lib/api/types";

type AgentConnectPageProps = {
  config: AgentConnectionConfig;
  onSave: (config: AgentConnectionConfig) => void;
};

const ADAPTER_OPTIONS: Array<{ value: AgentAdapterKind; label: string }> = [
  { value: "openclaw", label: "OpenClaw CLI" },
  { value: "http_sample", label: "HTTP API Agent" },
];

type AgentOption = {
  adapterKind: AgentAdapterKind;
  name: string;
  agentId: string;
  description: string;
};

const AGENT_OPTIONS: AgentOption[] = [
  {
    adapterKind: "openclaw",
    name: "OpenClaw CLI Agent",
    agentId: "agent.openclaw.demo",
    description: "用于检测并生成监督策略包的本地 OpenClaw 智能体。",
  },
  {
    adapterKind: "http_sample",
    name: "HTTP Sample Agent",
    agentId: "agent.http_sample.demo",
    description: "用于联调和备用验证的 HTTP 智能体。",
  },
];

export function AgentConnectPage({
  config,
  onSave,
}: AgentConnectPageProps) {
  const [draft, setDraft] = useState<AgentConnectionConfig>(config);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<AgentCheckResult | undefined>();
  const [checkError, setCheckError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(config);
  }, [config]);

  async function checkAgent() {
    setChecking(true);
    setCheckError(undefined);
    setCheckResult(undefined);
    try {
      setCheckResult(await agentGuardApi.checkAgent(draft));
    } catch (error) {
      setCheckError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }

  function saveDraft() {
    const next = normalizeConfig(draft);
    setDraft(next);
    onSave(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  function selectAgent(option: AgentOption) {
    setCheckResult(undefined);
    setCheckError(undefined);
    setSaved(false);
    setDraft((current) =>
      normalizeConfig({
        ...current,
        adapterKind: option.adapterKind,
        agentId: option.agentId,
        name: option.name,
        description: option.description,
      }),
    );
  }

  return (
    <div className="page-stack fill-page">
      <section className="page-hero agent-hero">
        <div className="hero-copy">
          <h1>智能体接入</h1>
        </div>
        <div className="hero-actions">
          <button className="secondary-button" disabled={checking} onClick={() => void checkAgent()}>
            {checking ? "检测中..." : "检测连接"}
          </button>
          <button className="primary-button" onClick={saveDraft}>
            {saved ? "已保存" : "保存配置"}
          </button>
        </div>
      </section>

      <section className="workspace-main agent-workspace">
        <div className="workspace-main panel grow-panel">
          <div className="section-header compact">
            <h2>接入配置</h2>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>智能体类型</span>
              <select
                value={draft.adapterKind}
                onChange={(event) => {
                  const selected = AGENT_OPTIONS.find(
                    (option) => option.adapterKind === event.target.value,
                  );
                  if (selected) selectAgent(selected);
                }}
              >
                {ADAPTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>智能体名称</span>
              <input
                value={draft.name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
              />
            </label>

            <label className="field">
              <span>智能体 ID</span>
              <input
                value={draft.agentId}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, agentId: event.target.value }))
                }
              />
            </label>

            <label className="field">
              <span>超时毫秒</span>
              <input
                min={5000}
                step={1000}
                type="number"
                value={draft.timeoutMs}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    timeoutMs: Number(event.target.value) || 120000,
                  }))
                }
              />
            </label>
          </div>

          {draft.adapterKind === "openclaw" ? (
            <div className="form-grid">
              <label className="field wide-field">
                <span>OpenClaw CLI 路径</span>
                <input
                  value={draft.openclawCliPath}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      openclawCliPath: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="field wide-field">
                <span>网关地址</span>
                <input
                  value={draft.gatewayUrl}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, gatewayUrl: event.target.value }))
                  }
                />
              </label>
            </div>
          ) : null}

          {draft.adapterKind === "http_sample" ? (
            <div className="form-grid">
              <label className="field wide-field">
                <span>HTTP 接口地址</span>
                <input
                  value={draft.endpointUrl}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, endpointUrl: event.target.value }))
                  }
                />
              </label>
            </div>
          ) : null}

          <div className="form-grid">
            <label className="field wide-field">
              <span>测试用例</span>
              <textarea
                rows={4}
                value={draft.caseIds.join(", ")}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    caseIds: parseCaseIds(event.target.value),
                  }))
                }
              />
            </label>
            <label className="field wide-field">
              <span>说明</span>
              <textarea
                rows={4}
                value={draft.description}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
          </div>

          {checkResult ? (
            <div className={`config-check-result ${checkResult.available ? "is-ok" : "is-warn"}`}>
              <strong>{checkResult.available ? "连接可用" : "连接不可用"}</strong>
              <p>{checkResult.detail}</p>
            </div>
          ) : null}
        </div>

      </section>

      {checkError ? <ErrorBlock title="连接检测失败" message={checkError} /> : null}
    </div>
  );
}

function adapterLabel(kind: AgentAdapterKind): string {
  return ADAPTER_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

function normalizeConfig(config: AgentConnectionConfig): AgentConnectionConfig {
  return {
    ...config,
    agentId: config.agentId.trim(),
    name: config.name.trim() || adapterLabel(config.adapterKind),
    description: config.description.trim(),
    openclawCliPath: config.openclawCliPath.trim(),
    gatewayUrl: config.gatewayUrl.trim(),
    endpointUrl: config.endpointUrl.trim(),
    timeoutMs: Math.max(5000, Number(config.timeoutMs) || 120000),
    caseIds: config.caseIds.length ? config.caseIds : ["case.resource_injection"],
  };
}

function parseCaseIds(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
