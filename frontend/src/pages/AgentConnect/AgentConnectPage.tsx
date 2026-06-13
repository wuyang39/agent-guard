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

  const latest = summaryState.status === "ready" ? summaryState.data.latestRunGroup : undefined;
  const openclawReady =
    systemState.status === "ready" ? systemState.data.features?.openclawAdapter : undefined;

  return (
    <div className="page-stack fill-page">
      <section className="page-hero agent-hero">
        <div className="hero-copy">
          <p className="eyebrow">Agent Connection</p>
          <h1>智能体接入</h1>
          <p className="hero-lead">
            先明确要检测和监督的对象，再把这份配置用于总览中的真实 E2E 运行。
          </p>
        </div>
        <div className="hero-actions">
          <Badge tone={draft.adapterKind === "openclaw" ? "tone-medium" : "tone-neutral"}>
            {adapterLabel(draft.adapterKind)}
          </Badge>
          {openclawReady !== undefined ? (
            <Badge tone={openclawReady ? "tone-low" : "tone-high"}>
              OpenClaw {openclawReady ? "available" : "unavailable"}
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
            <Badge>{draft.caseIds.length} cases</Badge>
          </div>

          <div className="form-grid">
            <label className="field">
              <span>智能体类型</span>
              <select
                value={draft.adapterKind}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    adapterKind: event.target.value as AgentAdapterKind,
                  }))
                }
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
              <label className="field wide-field">
                <span>API Token</span>
                <input
                  value={draft.authToken}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, authToken: event.target.value }))
                  }
                  type="password"
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
            <p className="eyebrow">Current Target</p>
            <h2>当前检测对象</h2>
            <div className="rail-list">
              <div>
                <span>名称</span>
                <code>{draft.name || "-"}</code>
              </div>
              <div>
                <span>Adapter</span>
                <code>{draft.adapterKind}</code>
              </div>
              <div>
                <span>Latest run agent</span>
                <code>{latest?.agentName ?? latest?.agentId ?? "-"}</code>
              </div>
              <div>
                <span>Cases</span>
                <code>{draft.caseIds.join(", ") || "-"}</code>
              </div>
            </div>
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>连接检测</h2>
              {checkResult ? (
                <Badge tone={checkResult.available ? "tone-low" : "tone-high"}>
                  {checkResult.available ? "available" : "unavailable"}
                </Badge>
              ) : (
                <Badge>pending</Badge>
              )}
            </div>
            {checkResult ? (
              <div className="rail-list">
                <div>
                  <span>Display name</span>
                  <code>{checkResult.displayName}</code>
                </div>
                <div>
                  <span>Normalized agent</span>
                  <code>{checkResult.normalizedAgent?.agentId ?? "-"}</code>
                </div>
                <div>
                  <span>Detail</span>
                  <code>{checkResult.detail}</code>
                </div>
              </div>
            ) : (
              <p className="muted">保存或检测连接后，这里会显示当前接入对象是否可用于真实运行。</p>
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
    authToken: config.authToken.trim(),
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
