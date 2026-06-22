import { useEffect, useMemo, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { agentGuardApi } from "../../lib/api/client";
import { formatDateTime } from "../../lib/formatters/time";
import type {
  LoadState,
  RuntimeConfigCheckResult,
  RuntimeConfigSnapshot,
  RuntimeDownstreamMcpConfigInput,
  RuntimeLlmConfigInput,
  RuntimeLlmMode,
} from "../../lib/api/types";

const MCP_URL = "http://127.0.0.1:3100/api/v1/openclaw/realtime/mcp";
const LLM_DRAFT_STORAGE_KEY = "agent-guard.runtime-config.llm-draft";
const MCP_DRAFT_STORAGE_KEY = "agent-guard.runtime-config.mcp-draft";

export function RuntimeConfigPage() {
  const [state, setState] = useState<LoadState<RuntimeConfigSnapshot>>({
    status: "idle",
  });
  const [llmDraft, setLlmDraft] = useState<RuntimeLlmConfigInput>(() =>
    loadStoredLlmDraft() ?? defaultLlmDraft(),
  );
  const [mcpDraft, setMcpDraft] = useState<RuntimeDownstreamMcpConfigInput>(() =>
    loadStoredMcpDraft() ?? defaultMcpDraft(),
  );
  const [llmSaving, setLlmSaving] = useState(false);
  const [mcpSaving, setMcpSaving] = useState(false);
  const [llmCheck, setLlmCheck] = useState<RuntimeConfigCheckResult | undefined>();
  const [mcpCheck, setMcpCheck] = useState<RuntimeConfigCheckResult | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void loadConfig();
  }, []);

  async function loadConfig(options: { preferDraft?: boolean } = { preferDraft: true }) {
    setState({ status: "loading" });
    setError(undefined);
    try {
      const snapshot = await agentGuardApi.runtimeConfig();
      if (options.preferDraft === false) {
        clearStoredLlmDraft();
        clearStoredMcpDraft();
      }
      setState({ status: "ready", data: snapshot, source: "api" });
      setLlmDraft(
        options.preferDraft === false
          ? snapshotToLlmDraft(snapshot)
          : loadStoredLlmDraft() ?? snapshotToLlmDraft(snapshot),
      );
      setMcpDraft(
        options.preferDraft === false
          ? snapshotToMcpDraft(snapshot)
          : loadStoredMcpDraft() ?? snapshotToMcpDraft(snapshot),
      );
    } catch (loadError) {
      setState({
        status: "error",
        message: loadError instanceof Error ? loadError.message : String(loadError),
      });
    }
  }

  async function saveLlm() {
    setLlmSaving(true);
    setError(undefined);
    setLlmCheck(undefined);
    try {
      const snapshot = await agentGuardApi.saveLlmConfig(normalizeLlmDraft(llmDraft));
      clearStoredLlmDraft();
      setState({ status: "ready", data: snapshot, source: "api" });
      setLlmDraft(snapshotToLlmDraft(snapshot));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setLlmSaving(false);
    }
  }

  async function checkLlm() {
    setError(undefined);
    setLlmCheck(undefined);
    try {
      setLlmCheck(await agentGuardApi.checkLlmConfig(normalizeLlmDraft(llmDraft)));
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
    }
  }

  function applyDeepSeekPreset() {
    setLlmCheck(undefined);
    setError(undefined);
    updateLlmDraft((current) => ({
      ...current,
      enabled: true,
      mode: "openai_compatible",
      endpoint: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      timeoutMs: Math.max(current.timeoutMs, 10000),
    }));
  }

  function applyMockPreset() {
    setLlmCheck(undefined);
    setError(undefined);
    updateLlmDraft((current) => ({
      ...current,
      enabled: true,
      mode: "mock",
      endpoint: "",
      model: "mock-tool-profiler",
      timeoutMs: 5000,
    }));
  }

  async function saveMcp() {
    setMcpSaving(true);
    setError(undefined);
    setMcpCheck(undefined);
    try {
      const snapshot = await agentGuardApi.saveDownstreamMcpConfig(normalizeMcpDraft(mcpDraft));
      clearStoredMcpDraft();
      setState({ status: "ready", data: snapshot, source: "api" });
      setMcpDraft(snapshotToMcpDraft(snapshot));
      setMcpCheck({
        available: true,
        toolCount: snapshot.gatewayReload?.toolCount,
        detail: `Gateway 已重新加载，当前工具数 ${snapshot.gatewayReload?.toolCount ?? 0}。`,
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setMcpSaving(false);
    }
  }

  async function checkMcp() {
    setError(undefined);
    setMcpCheck(undefined);
    try {
      setMcpCheck(await agentGuardApi.checkDownstreamMcpConfig(normalizeMcpDraft(mcpDraft)));
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
    }
  }

  function updateLlmDraft(
    updater: (current: RuntimeLlmConfigInput) => RuntimeLlmConfigInput,
  ) {
    setLlmDraft((current) => {
      const next = updater(current);
      saveStoredLlmDraft(next);
      return next;
    });
  }

  function updateMcpDraft(
    updater: (current: RuntimeDownstreamMcpConfigInput) => RuntimeDownstreamMcpConfigInput,
  ) {
    setMcpDraft((current) => {
      const next = updater(current);
      saveStoredMcpDraft(next);
      return next;
    });
  }

  const sourceSummary = useMemo(() => {
    if (state.status !== "ready") return undefined;
    return {
      llm: sourceLabel(state.data.llm.source),
      mcp: sourceLabel(state.data.downstreamMcp.source),
    };
  }, [state]);

  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在读取运行时配置..." />;
  }

  if (state.status === "error" || state.status === "empty") {
    return <ErrorBlock title="运行配置不可用" message={state.message} />;
  }

  return (
    <div className="page-stack fill-page runtime-config-page">
      <section className="page-hero dashboard-hero">
        <div className="hero-copy">
          <p className="eyebrow">运行配置</p>
          <h1>LLM 与外部 MCP 接入</h1>
        </div>
        <div className="hero-actions">
          <Badge tone={llmDraft.enabled ? "tone-medium" : "tone-neutral"}>
            LLM {llmDraft.enabled ? "启用" : "关闭"}
          </Badge>
          <Badge tone={mcpDraft.enabled ? "tone-low" : "tone-neutral"}>
            外部 MCP {mcpDraft.enabled ? "启用" : "关闭"}
          </Badge>
          <button className="secondary-button" onClick={() => void loadConfig()}>
            保留草稿刷新
          </button>
          <button className="secondary-button" onClick={() => void loadConfig({ preferDraft: false })}>
            还原后端配置
          </button>
        </div>
      </section>

      {error ? <ErrorBlock title="配置操作失败" message={error} /> : null}

      <section className="workspace-grid runtime-config-workspace">
        <div className="workspace-main">
          <article className="panel config-panel">
            <div className="section-header compact">
              <div>
                <p className="eyebrow">LLM API</p>
                <h2>LLM 辅助能力</h2>
              </div>
              <div className="button-row">
                <button className="secondary-button compact-button" onClick={applyDeepSeekPreset} type="button">
                  DeepSeek V4 Flash
                </button>
                <button className="secondary-button compact-button" onClick={applyMockPreset} type="button">
                  Mock
                </button>
                <Badge tone={llmDraft.enabled ? "tone-medium" : "tone-neutral"}>
                  {sourceSummary?.llm ?? "runtime"}
                </Badge>
              </div>
            </div>

            <div className="form-grid">
              <label className="field config-toggle-field">
                <span>启用 LLM</span>
                <input
                  checked={llmDraft.enabled}
                  onChange={(event) =>
                    updateLlmDraft((current) => ({
                      ...current,
                      enabled: event.target.checked,
                      mode: event.target.checked ? current.mode === "disabled" ? "mock" : current.mode : "disabled",
                    }))
                  }
                  type="checkbox"
                />
              </label>

              <label className="field">
                <span>模式</span>
                <select
                  value={llmDraft.mode}
                  onChange={(event) =>
                    updateLlmDraft((current) => ({
                      ...current,
                      enabled: event.target.value !== "disabled",
                      mode: event.target.value as RuntimeLlmMode,
                    }))
                  }
                >
                  <option value="disabled">disabled</option>
                  <option value="mock">mock</option>
                  <option value="openai_compatible">openai_compatible</option>
                </select>
              </label>

              <label className="field wide-field">
                <span>Endpoint</span>
                <input
                  placeholder="https://api.deepseek.com 或 https://example.com/v1/chat/completions"
                  value={llmDraft.endpoint ?? ""}
                  onChange={(event) =>
                    updateLlmDraft((current) => ({ ...current, endpoint: event.target.value }))
                  }
                />
              </label>

              <label className="field">
                <span>Model</span>
                <input
                  placeholder="deepseek-v4-flash"
                  value={llmDraft.model ?? ""}
                  onChange={(event) =>
                    updateLlmDraft((current) => ({ ...current, model: event.target.value }))
                  }
                />
              </label>

              <label className="field">
                <span>API Key</span>
                <input
                  placeholder={state.data.llm.hasApiKey ? "已配置，留空表示不覆盖" : "sk-..."}
                  type="password"
                  value={llmDraft.apiKey ?? ""}
                  onChange={(event) =>
                    updateLlmDraft((current) => ({ ...current, apiKey: event.target.value }))
                  }
                />
                {state.data.llm.hasApiKey && !llmDraft.apiKey ? (
                  <small className="field-note">
                    后端已保存 API Key，出于安全不会回显；留空保存不会覆盖。
                  </small>
                ) : null}
              </label>

              <label className="field">
                <span>超时毫秒</span>
                <input
                  min={1000}
                  step={1000}
                  type="number"
                  value={llmDraft.timeoutMs}
                  onChange={(event) =>
                    updateLlmDraft((current) => ({
                      ...current,
                      timeoutMs: Number(event.target.value) || 5000,
                    }))
                  }
                />
              </label>
            </div>

            <div className="button-row config-actions">
              <button className="primary-button" disabled={llmSaving} onClick={() => void saveLlm()}>
                {llmSaving ? "保存中..." : "保存 LLM 配置"}
              </button>
              <button className="secondary-button" onClick={() => void checkLlm()}>
                测试 LLM
              </button>
            </div>
            {llmCheck ? <CheckResultBlock result={llmCheck} /> : null}
          </article>

          <article className="panel config-panel">
            <div className="section-header compact">
              <div>
                <p className="eyebrow">External MCP</p>
                <h2>外部 MCP Provider</h2>
              </div>
              <Badge tone={mcpDraft.enabled ? "tone-low" : "tone-neutral"}>
                {sourceSummary?.mcp ?? "runtime"}
              </Badge>
            </div>

            <div className="form-grid">
              <label className="field config-toggle-field">
                <span>启用外部 MCP</span>
                <input
                  checked={mcpDraft.enabled}
                  onChange={(event) =>
                    updateMcpDraft((current) => ({ ...current, enabled: event.target.checked }))
                  }
                  type="checkbox"
                />
              </label>

              <label className="field">
                <span>Provider ID</span>
                <input
                  value={mcpDraft.providerId}
                  onChange={(event) =>
                    updateMcpDraft((current) => ({ ...current, providerId: event.target.value }))
                  }
                />
              </label>

              <label className="field">
                <span>Provider Name</span>
                <input
                  value={mcpDraft.providerName}
                  onChange={(event) =>
                    updateMcpDraft((current) => ({ ...current, providerName: event.target.value }))
                  }
                />
              </label>

              <label className="field">
                <span>超时毫秒</span>
                <input
                  min={1000}
                  step={1000}
                  type="number"
                  value={mcpDraft.timeoutMs}
                  onChange={(event) =>
                    updateMcpDraft((current) => ({
                      ...current,
                      timeoutMs: Number(event.target.value) || 5000,
                    }))
                  }
                />
              </label>

              <label className="field wide-field">
                <span>外部 MCP URL</span>
                <input
                  placeholder="http://127.0.0.1:9001/mcp"
                  value={mcpDraft.endpointUrl ?? ""}
                  onChange={(event) =>
                    updateMcpDraft((current) => ({ ...current, endpointUrl: event.target.value }))
                  }
                />
              </label>
            </div>

            <div className="button-row config-actions">
              <button className="primary-button" disabled={mcpSaving} onClick={() => void saveMcp()}>
                {mcpSaving ? "接入中..." : "保存并重新加载 Gateway"}
              </button>
              <button className="secondary-button" onClick={() => void checkMcp()}>
                测试 tools/list
              </button>
            </div>
            {mcpCheck ? <CheckResultBlock result={mcpCheck} showTools /> : null}
          </article>
        </div>

        <aside className="surface-rail">
          <div className="rail-section">
            <div className="section-header compact">
              <h2>OpenClaw 连接口径</h2>
              <Badge>固定 MCP URL</Badge>
            </div>
            <div className="rail-list">
              <div>
                <span>OpenClaw MCP URL</span>
                <code>{MCP_URL}</code>
              </div>
              <div>
                <span>外部工具暴露名</span>
                <code>agw__{mcpDraft.providerId || "provider"}__tool_name</code>
              </div>
              <div>
                <span>配置生效范围</span>
                <code>当前后端进程，重启后回到环境变量</code>
              </div>
            </div>
          </div>

          <div className="rail-section">
            <h2>配置状态</h2>
            <div className="decision-grid">
              <div>
                <span>LLM</span>
                <strong>{llmDraft.enabled ? "ON" : "OFF"}</strong>
              </div>
              <div>
                <span>MCP</span>
                <strong>{mcpDraft.enabled ? "ON" : "OFF"}</strong>
              </div>
              <div>
                <span>Key</span>
                <strong>{state.data.llm.hasApiKey || llmDraft.apiKey ? "YES" : "NO"}</strong>
              </div>
              <div>
                <span>Tools</span>
                <strong>{mcpCheck?.toolCount ?? "-"}</strong>
              </div>
            </div>
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>当前生效配置</h2>
              <Badge>后端</Badge>
            </div>
            <p className="muted config-note">
              这里显示后端当前实际使用的配置；表单草稿只有保存后才会进入这里。
            </p>
            <pre>{buildCurrentConfigSnippet(state.data)}</pre>
          </div>

          <div className="rail-section">
            <h2>草稿环境变量等价写法</h2>
            <pre>{buildEnvSnippet(llmDraft, mcpDraft)}</pre>
          </div>
        </aside>
      </section>
    </div>
  );
}

function CheckResultBlock({
  result,
  showTools,
}: {
  result: RuntimeConfigCheckResult;
  showTools?: boolean;
}) {
  return (
    <div className={`config-check-result ${result.available ? "is-ok" : "is-warn"}`}>
      <div className="section-header compact">
        <strong>{result.available ? "检测通过" : "未通过"}</strong>
        <Badge tone={result.available ? "tone-low" : "tone-high"}>
          {result.available ? "available" : "unavailable"}
        </Badge>
      </div>
      <p>{result.detail}</p>
      {showTools && result.providers?.length ? (
        <div className="tool-chip-list">
          {result.providers.map((provider) => (
            <span key={provider.providerId}>
              {provider.providerId}: {provider.toolCount}
            </span>
          ))}
        </div>
      ) : null}
      {showTools && result.tools?.length ? (
        <div className="tool-chip-list">
          {result.tools.map((tool) => (
            <span key={tool.canonicalToolId} title={tool.description || tool.canonicalToolId}>
              {tool.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function defaultLlmDraft(): RuntimeLlmConfigInput {
  return {
    enabled: false,
    mode: "disabled",
    endpoint: "",
    apiKey: "",
    model: "mock-tool-profiler",
    timeoutMs: 5000,
  };
}

function defaultMcpDraft(): RuntimeDownstreamMcpConfigInput {
  return {
    enabled: false,
    providerId: "external_mcp",
    providerName: "External MCP Provider",
    endpointUrl: "",
    timeoutMs: 5000,
  };
}

function loadStoredLlmDraft(): RuntimeLlmConfigInput | undefined {
  try {
    const raw = sessionStorage.getItem(LLM_DRAFT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<RuntimeLlmConfigInput>;
    return {
      ...defaultLlmDraft(),
      ...parsed,
      enabled: Boolean(parsed.enabled),
      mode:
        parsed.mode === "disabled" ||
        parsed.mode === "mock" ||
        parsed.mode === "openai_compatible"
          ? parsed.mode
          : "disabled",
      timeoutMs: Math.max(1000, Number(parsed.timeoutMs) || 5000),
    };
  } catch {
    return undefined;
  }
}

function saveStoredLlmDraft(draft: RuntimeLlmConfigInput): void {
  try {
    sessionStorage.setItem(LLM_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Ignore storage failures; backend config remains the source of truth.
  }
}

function clearStoredLlmDraft(): void {
  try {
    sessionStorage.removeItem(LLM_DRAFT_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function loadStoredMcpDraft(): RuntimeDownstreamMcpConfigInput | undefined {
  try {
    const raw = sessionStorage.getItem(MCP_DRAFT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<RuntimeDownstreamMcpConfigInput>;
    return {
      ...defaultMcpDraft(),
      ...parsed,
      enabled: Boolean(parsed.enabled),
      timeoutMs: Math.max(1000, Number(parsed.timeoutMs) || 5000),
    };
  } catch {
    return undefined;
  }
}

function saveStoredMcpDraft(draft: RuntimeDownstreamMcpConfigInput): void {
  try {
    sessionStorage.setItem(MCP_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Ignore storage failures; backend config remains the source of truth.
  }
}

function clearStoredMcpDraft(): void {
  try {
    sessionStorage.removeItem(MCP_DRAFT_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

function snapshotToLlmDraft(snapshot: RuntimeConfigSnapshot): RuntimeLlmConfigInput {
  return {
    enabled: snapshot.llm.enabled,
    mode: snapshot.llm.mode,
    endpoint: snapshot.llm.endpoint ?? "",
    apiKey: "",
    model: snapshot.llm.model ?? "",
    timeoutMs: snapshot.llm.timeoutMs,
  };
}

function snapshotToMcpDraft(snapshot: RuntimeConfigSnapshot): RuntimeDownstreamMcpConfigInput {
  return {
    enabled: snapshot.downstreamMcp.enabled,
    providerId: snapshot.downstreamMcp.providerId,
    providerName: snapshot.downstreamMcp.providerName,
    endpointUrl: snapshot.downstreamMcp.endpointUrl ?? "",
    timeoutMs: snapshot.downstreamMcp.timeoutMs,
    servers: snapshot.downstreamMcp.servers,
  };
}

function normalizeLlmDraft(draft: RuntimeLlmConfigInput): RuntimeLlmConfigInput {
  const mode = draft.enabled ? draft.mode === "disabled" ? "mock" : draft.mode : "disabled";
  return {
    enabled: draft.enabled && mode !== "disabled",
    mode,
    endpoint: draft.endpoint?.trim() || undefined,
    apiKey: draft.apiKey?.trim() || undefined,
    model: draft.model?.trim() || undefined,
    timeoutMs: Math.max(1000, Number(draft.timeoutMs) || 5000),
  };
}

function normalizeMcpDraft(draft: RuntimeDownstreamMcpConfigInput): RuntimeDownstreamMcpConfigInput {
  const providerId = draft.providerId.trim() || "external_mcp";
  const providerName = draft.providerName.trim() || "External MCP Provider";
  const endpointUrl = draft.endpointUrl?.trim() || undefined;
  const timeoutMs = Math.max(1000, Number(draft.timeoutMs) || 5000);
  const servers = draft.servers?.map((server) => ({
    enabled: server.enabled !== false,
    providerId: server.providerId?.trim() || undefined,
    providerName: server.providerName?.trim() || undefined,
    endpointUrl: server.endpointUrl?.trim() || undefined,
    timeoutMs: server.timeoutMs ? Math.max(1000, Number(server.timeoutMs) || 5000) : undefined,
  }));
  if (servers?.length) {
    servers[0] = {
      ...servers[0],
      providerId,
      providerName,
      endpointUrl,
      timeoutMs,
    };
  }
  return {
    enabled: draft.enabled,
    providerId,
    providerName,
    endpointUrl,
    timeoutMs,
    servers,
  };
}

function sourceLabel(source: RuntimeConfigSnapshot["llm"]["source"]): string {
  const labels: Record<RuntimeConfigSnapshot["llm"]["source"], string> = {
    runtime: "页面配置",
    env: "环境变量",
    default: "默认值",
  };
  return labels[source];
}

function buildEnvSnippet(
  llm: RuntimeLlmConfigInput,
  mcp: RuntimeDownstreamMcpConfigInput,
): string {
  return [
    `$env:AGENT_GUARD_LLM_ENABLED="${llm.enabled ? "1" : "0"}"`,
    `$env:AGENT_GUARD_LLM_MODE="${llm.mode}"`,
    llm.endpoint ? `$env:AGENT_GUARD_LLM_ENDPOINT="${llm.endpoint}"` : undefined,
    llm.model ? `$env:AGENT_GUARD_LLM_MODEL="${llm.model}"` : undefined,
    `$env:AGENT_GUARD_LLM_API_KEY="<your-api-key>"`,
    `$env:AGENT_GUARD_LLM_TIMEOUT_MS="${llm.timeoutMs}"`,
    "# A/B 共用同一套 OpenAI-compatible LLM 配置",
    llm.endpoint ? `$env:OPENAI_CHAT_ENDPOINT=$env:AGENT_GUARD_LLM_ENDPOINT` : undefined,
    llm.model ? `$env:OPENAI_CHAT_MODEL=$env:AGENT_GUARD_LLM_MODEL` : undefined,
    `$env:OPENAI_CHAT_KEY=$env:AGENT_GUARD_LLM_API_KEY`,
    llm.endpoint ? `$env:AGENT_GUARD_PYRIT_OPENAI_CHAT_ENDPOINT=$env:AGENT_GUARD_LLM_ENDPOINT` : undefined,
    llm.model ? `$env:AGENT_GUARD_PYRIT_OPENAI_CHAT_MODEL=$env:AGENT_GUARD_LLM_MODEL` : undefined,
    `$env:AGENT_GUARD_PYRIT_OPENAI_CHAT_KEY=$env:AGENT_GUARD_LLM_API_KEY`,
    `$env:AGENT_GUARD_DOWNSTREAM_MCP_URL="${mcp.endpointUrl ?? ""}"`,
    `$env:AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_ID="${mcp.providerId}"`,
    `$env:AGENT_GUARD_DOWNSTREAM_MCP_PROVIDER_NAME="${mcp.providerName}"`,
    `$env:AGENT_GUARD_DOWNSTREAM_MCP_TIMEOUT_MS="${mcp.timeoutMs}"`,
    mcp.servers?.length
      ? `$env:AGENT_GUARD_DOWNSTREAM_MCP_SERVERS='${JSON.stringify(mcp.servers)}'`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildCurrentConfigSnippet(snapshot: RuntimeConfigSnapshot): string {
  return JSON.stringify(
    {
      updatedAt: snapshot.updatedAt === new Date(0).toISOString()
        ? "未通过页面修改"
        : formatDateTime(snapshot.updatedAt),
      llm: {
        enabled: snapshot.llm.enabled,
        mode: snapshot.llm.mode,
        endpoint: snapshot.llm.endpoint ?? "",
        model: snapshot.llm.model ?? "",
        timeoutMs: snapshot.llm.timeoutMs,
        source: sourceLabel(snapshot.llm.source),
        apiKey: snapshot.llm.hasApiKey ? "已配置，不回显" : "未配置",
      },
      downstreamMcp: {
        enabled: snapshot.downstreamMcp.enabled,
        providerId: snapshot.downstreamMcp.providerId,
        providerName: snapshot.downstreamMcp.providerName,
        endpointUrl: snapshot.downstreamMcp.endpointUrl ?? "",
        timeoutMs: snapshot.downstreamMcp.timeoutMs,
        servers: snapshot.downstreamMcp.servers ?? [],
        source: sourceLabel(snapshot.downstreamMcp.source),
      },
    },
    null,
    2,
  );
}
