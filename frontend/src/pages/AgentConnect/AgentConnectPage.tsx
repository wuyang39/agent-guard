import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { ErrorBlock } from "../../components/ui/StateBlock";
import { agentGuardApi } from "../../lib/api/client";
import type {
  AgentAdapterKind,
  AgentCheckResult,
  AgentConnectionConfig,
  CLineDashboardSummary,
  LoadState,
  SystemStatus,
} from "../../lib/api/types";

type AgentConnectPageProps = {
  config: AgentConnectionConfig;
  onSave: (config: AgentConnectionConfig) => void;
  summaryState: LoadState<CLineDashboardSummary>;
  systemState: LoadState<SystemStatus>;
};

const ADAPTER_OPTIONS: Array<{ value: AgentAdapterKind; label: string }> = [
  { value: "openclaw", label: "OpenClaw CLI" },
  { value: "http_sample", label: "HTTP API Agent" },
  { value: "mock", label: "Mock Agent" },
];

type AgentOption = {
  adapterKind: AgentAdapterKind;
  name: string;
  agentId: string;
  description: string;
  endpointLabel: string;
};

const AGENT_OPTIONS: AgentOption[] = [
  {
    adapterKind: "openclaw",
    name: "OpenClaw CLI Agent",
    agentId: "agent.openclaw.demo",
    description: "用于检测并生成监督策略包的本地 OpenClaw 智能体。",
    endpointLabel: "CLI + Realtime MCP",
  },
  {
    adapterKind: "http_sample",
    name: "HTTP Sample Agent",
    agentId: "agent.http_sample.demo",
    description: "用于联调和备用验证的 HTTP 智能体。",
    endpointLabel: "HTTP 接口",
  },
  {
    adapterKind: "mock",
    name: "Mock Agent",
    agentId: "agent.mock.demo",
    description: "用于离线验证页面和报告展示的内置示例智能体。",
    endpointLabel: "内置示例",
  },
];

export function AgentConnectPage({
  config,
  onSave,
  summaryState,
  systemState,
}: AgentConnectPageProps) {
  const [draft, setDraft] = useState<AgentConnectionConfig>(config);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<AgentCheckResult | undefined>();
  const [checkError, setCheckError] = useState<string | undefined>();
  const [saved, setSaved] = useState(false);
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>(() => AGENT_OPTIONS);

  useEffect(() => {
    setDraft(config);
    setAgentOptions((current) => upsertAgentOption(current, config));
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
    setAgentOptions((current) => upsertAgentOption(current, next));
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

  const latest = summaryState.status === "ready" ? summaryState.data.latestRunGroup : undefined;
  const openclawReady =
    systemState.status === "ready" ? systemState.data.features?.openclawAdapter : undefined;
  const showOpenClawHealth = draft.adapterKind === "openclaw" && openclawReady !== undefined;

  return (
    <div className="page-stack fill-page">
      <section className="page-hero agent-hero">
        <div className="hero-copy">
          <h1>智能体接入</h1>
        </div>
        <div className="hero-actions">
          <Badge tone={draft.adapterKind === "openclaw" ? "tone-medium" : "tone-neutral"}>
            {adapterLabel(draft.adapterKind)}
          </Badge>
          {showOpenClawHealth ? (
            <Badge tone={openclawReady ? "tone-low" : "tone-high"}>
              OpenClaw {openclawReady ? "可用" : "不可用"}
            </Badge>
          ) : null}
          <button className="secondary-button" disabled={checking} onClick={() => void checkAgent()}>
            {checking ? "检测中..." : "检测连接"}
          </button>
          <button className="primary-button" onClick={saveDraft}>
            {saved ? "已保存" : "保存配置"}
          </button>
        </div>
      </section>

      <section className="workspace-grid agent-workspace">
        <div className="workspace-main panel grow-panel">
          <div className="section-header compact">
            <h2>接入配置</h2>
            <Badge>{draft.caseIds.length} 个用例</Badge>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>智能体类型</span>
              <select
                value={draft.adapterKind}
                onChange={(event) => {
                  const selected = agentOptions.find(
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
              <span>Agent ID</span>
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
                <span>Gateway URL</span>
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
                <span>HTTP Agent Endpoint</span>
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
        </div>

        <aside className="surface-rail">
          <div className="rail-section">
            <div className="section-header compact">
              <div>
                <p className="eyebrow">接入对象</p>
                <h2>接入对象</h2>
              </div>
              <Badge>{agentOptions.length} 个对象</Badge>
            </div>
            <div className="agent-option-list">
              {agentOptions.map((option) => {
                const selected = draft.adapterKind === option.adapterKind;
                return (
                  <button
                    className={`agent-option ${selected ? "selected" : ""}`}
                    key={option.adapterKind}
                    onClick={() => selectAgent(option)}
                    type="button"
                  >
                    <span className="agent-option-main">
                      <strong>{option.name}</strong>
                      <span>{option.endpointLabel}</span>
                    </span>
                    <Badge tone={selected ? "tone-medium" : "tone-neutral"}>
                      {selected ? "已选择" : adapterLabel(option.adapterKind)}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rail-section">
            <p className="eyebrow">当前检测对象</p>
            <h2>当前检测对象</h2>
            <div className="rail-list">
              <div>
                <span>名称</span>
                <code>{draft.name || "-"}</code>
              </div>
              <div>
                <span>适配器</span>
                <code>{draft.adapterKind}</code>
              </div>
              <div>
                <span>最新运行智能体</span>
                <code>{latest?.agentName ?? latest?.agentId ?? "-"}</code>
              </div>
              <div>
                <span>用例</span>
                <code>{draft.caseIds.join(", ") || "-"}</code>
              </div>
            </div>
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>连接检测</h2>
              {checkResult ? (
                <Badge tone={checkResult.available ? "tone-low" : "tone-high"}>
                  {checkResult.available ? "可用" : "不可用"}
                </Badge>
              ) : (
                <Badge>待检测</Badge>
              )}
            </div>
            {checkResult ? (
              <div className="rail-list">
                <div>
                  <span>显示名称</span>
                  <code>{checkResult.displayName}</code>
                </div>
                <div>
                  <span>标准化智能体</span>
                  <code>{checkResult.normalizedAgent?.agentId ?? "-"}</code>
                </div>
                <div>
                  <span>详情</span>
                  <code>{checkResult.detail}</code>
                </div>
              </div>
            ) : (
              <p className="muted">当前接入对象状态。</p>
            )}
          </div>
        </aside>
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

function upsertAgentOption(options: AgentOption[], config: AgentConnectionConfig): AgentOption[] {
  const nextOption: AgentOption = {
    adapterKind: config.adapterKind,
    name: config.name || adapterLabel(config.adapterKind),
    agentId: config.agentId,
    description: config.description,
    endpointLabel: endpointLabel(config),
  };
  const index = options.findIndex((option) => option.adapterKind === config.adapterKind);
  if (index < 0) return [...options, nextOption];
  return options.map((option, currentIndex) => (currentIndex === index ? nextOption : option));
}

function endpointLabel(config: AgentConnectionConfig): string {
  if (config.adapterKind === "openclaw") return "CLI + Realtime MCP";
  if (config.adapterKind === "http_sample") return config.endpointUrl || "HTTP endpoint";
  return "Built-in mock";
}
