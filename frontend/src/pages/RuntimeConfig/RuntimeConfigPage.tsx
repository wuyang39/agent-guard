import { useEffect, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import {
  DiagnosticKeyValueGrid,
  DiagnosticTable,
} from "../../components/ui/DeveloperDiagnostics";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
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

const LLM_DRAFT_STORAGE_KEY = "agent-guard.runtime-config.llm-draft";
const MCP_DRAFT_STORAGE_KEY = "agent-guard.runtime-config.mcp-draft";
const DEFAULT_LLM_TIMEOUT_MS = 120000;

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

  async function loadConfig() {
    setState({ status: "loading" });
    setError(undefined);
    try {
      const snapshot = await agentGuardApi.runtimeConfig();
      setState({ status: "ready", data: snapshot, source: "api" });
      setLlmDraft(loadStoredLlmDraft() ?? snapshotToLlmDraft(snapshot));
      setMcpDraft(loadStoredMcpDraft() ?? snapshotToMcpDraft(snapshot));
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
      timeoutMs: Math.max(current.timeoutMs, DEFAULT_LLM_TIMEOUT_MS),
    }));
  }

  function applyDeepWikiPreset() {
    setMcpCheck(undefined);
    setError(undefined);
    updateMcpDraft((current) => ({
      ...current,
      enabled: true,
      providerId: "deepwiki_public",
      providerName: "DeepWiki Public MCP",
      endpointUrl: "https://mcp.deepwiki.com/mcp",
      timeoutMs: Math.max(current.timeoutMs, 15000),
      servers: undefined,
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
      </section>

      {error ? <ErrorBlock title="配置操作失败" message={error} /> : null}

      <section className="workspace-main runtime-config-workspace">
        <article className="panel config-panel">
            <div className="section-header compact">
              <div>
                <p className="eyebrow">LLM</p>
                <h2>LLM 配置</h2>
              </div>
              <div className="button-row">
                <button className="secondary-button compact-button" onClick={applyDeepSeekPreset} type="button">
                  DeepSeek V4 Flash
                </button>
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
                      mode: event.target.checked
                        ? current.mode === "disabled" || current.mode === "mock"
                          ? "openai_compatible"
                          : current.mode
                        : "disabled",
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
                  <option value="disabled">关闭</option>
                  <option value="openai_compatible">OpenAI-compatible</option>
                </select>
              </label>

              <label className="field wide-field">
                <span>接口地址</span>
                <input
                  placeholder="https://api.deepseek.com 或 https://example.com/v1/chat/completions"
                  value={llmDraft.endpoint ?? ""}
                  onChange={(event) =>
                    updateLlmDraft((current) => ({ ...current, endpoint: event.target.value }))
                  }
                />
              </label>

              <label className="field">
                <span>模型</span>
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
                      timeoutMs: Number(event.target.value) || DEFAULT_LLM_TIMEOUT_MS,
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
                <p className="eyebrow">外部 MCP</p>
                <h2>外部 MCP 配置</h2>
              </div>
              <div className="button-row">
                <button className="secondary-button compact-button" onClick={applyDeepWikiPreset} type="button">
                  DeepWiki Public
                </button>
              </div>
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
                <span>接入 ID</span>
                <input
                  value={mcpDraft.providerId}
                  onChange={(event) =>
                    updateMcpDraft((current) => ({ ...current, providerId: event.target.value }))
                  }
                />
              </label>

              <label className="field">
                <span>显示名称</span>
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
                <span>MCP 地址</span>
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
                {mcpSaving ? "保存中..." : "保存 MCP 配置"}
              </button>
              <button className="secondary-button" onClick={() => void checkMcp()}>
                测试 MCP
              </button>
            </div>
            {mcpCheck ? <CheckResultBlock result={mcpCheck} /> : null}
        </article>

        <DeveloperDetails
          defaultOpen
          items={[
            { label: "更新时间", value: formatDateTime(state.data.updatedAt) },
            { label: "LLM 来源", value: configSourceLabel(state.data.llm.source) },
            { label: "LLM 模式", value: state.data.llm.mode },
            { label: "LLM 接口", value: state.data.llm.endpoint },
            { label: "LLM 模型", value: state.data.llm.model },
            { label: "LLM 超时", value: state.data.llm.timeoutMs },
            { label: "API Key", value: state.data.llm.hasApiKey ? "已配置" : "未配置" },
            { label: "MCP 来源", value: configSourceLabel(state.data.downstreamMcp.source) },
            { label: "MCP 接入 ID", value: state.data.downstreamMcp.providerId },
            { label: "MCP 地址", value: state.data.downstreamMcp.endpointUrl },
            { label: "MCP 超时", value: state.data.downstreamMcp.timeoutMs },
          ]}
          title="当前生效配置"
        />
      </section>
    </div>
  );
}

function CheckResultBlock({
  result,
}: {
  result: RuntimeConfigCheckResult;
}) {
  return (
    <div className={`config-check-result ${result.available ? "is-ok" : "is-warn"}`}>
      <div className="section-header compact">
        <strong>{result.available ? "检测通过" : "未通过"}</strong>
        <Badge tone={result.available ? "tone-low" : "tone-high"}>
          {result.available ? "可用" : "不可用"}
        </Badge>
      </div>
      <p>{result.detail}</p>
      <DiagnosticKeyValueGrid
        items={[
          { label: "Provider", value: result.provider },
          { label: "Model", value: result.model },
          { label: "Provider ID", value: result.providerId },
          { label: "Provider name", value: result.providerName },
          { label: "Tool count", value: result.toolCount },
        ]}
      />
      {result.providers?.length ? (
        <DiagnosticTable
          columns={[
            { header: "Provider ID", render: (provider) => <code>{provider.providerId}</code> },
            { header: "Provider name", render: (provider) => provider.providerName },
            { header: "Tools", render: (provider) => provider.toolCount },
          ]}
          rowKey={(provider) => provider.providerId}
          rows={result.providers}
        />
      ) : null}
      {result.tools?.length ? (
        <DiagnosticTable
          columns={[
            { header: "Provider", render: (tool) => tool.providerId ? <code>{tool.providerId}</code> : "-" },
            { header: "Name", render: (tool) => tool.name },
            { header: "Canonical ID", render: (tool) => <code>{tool.canonicalToolId}</code> },
            { header: "Description", render: (tool) => tool.description },
          ]}
          maxRows={36}
          rowKey={(tool, index) => `${tool.canonicalToolId}.${index}`}
          rows={result.tools}
        />
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
    model: "deepseek-v4-flash",
    timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
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
        parsed.mode === "openai_compatible"
          ? "openai_compatible"
          : parsed.mode === "mock"
            ? "openai_compatible"
            : "disabled",
      timeoutMs: Math.max(1000, Number(parsed.timeoutMs) || DEFAULT_LLM_TIMEOUT_MS),
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
    enabled: snapshot.llm.enabled && snapshot.llm.mode !== "mock",
    mode: snapshot.llm.mode === "mock" ? "openai_compatible" : snapshot.llm.mode,
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
  const mode = draft.enabled
    ? draft.mode === "disabled" || draft.mode === "mock"
      ? "openai_compatible"
      : draft.mode
    : "disabled";
  return {
    enabled: draft.enabled && mode !== "disabled",
    mode,
    endpoint: draft.endpoint?.trim() || undefined,
    apiKey: draft.apiKey?.trim() || undefined,
    model: draft.model?.trim() || undefined,
    timeoutMs: Math.max(1000, Number(draft.timeoutMs) || DEFAULT_LLM_TIMEOUT_MS),
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

function configSourceLabel(source: RuntimeConfigSnapshot["llm"]["source"]): string {
  const labels: Record<RuntimeConfigSnapshot["llm"]["source"], string> = {
    runtime: "页面配置",
    env: "环境变量",
    default: "默认值",
  };
  return labels[source];
}
