import { Badge } from "../../components/ui/Badge";
import {
  DeveloperDiagnostics,
  DiagnosticJson,
  DiagnosticKeyValueGrid,
  DiagnosticSection,
} from "../../components/ui/DeveloperDiagnostics";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
import { ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import type { LoadState, SystemStatus } from "../../lib/api/types";
import { formatDateTime } from "../../lib/formatters/time";

type SystemPageProps = {
  state: LoadState<SystemStatus>;
};

function renderNativeGuardCoverage(nativeGuard?: Record<string, unknown>): string {
  if (!nativeGuard) return "不可用 — 插件未安装或未配置";
  const { coverage, activeLeaseCount, finalizerAssurance, pluginVersion, openclawVersion, reasonCode, conflictingPluginIds } = nativeGuard as Record<string, unknown>;
  const version = [pluginVersion, openclawVersion].filter(Boolean).join(" / ") || "未知";
  const conflicts = Array.isArray(conflictingPluginIds) && conflictingPluginIds.length > 0
    ? `; 冲突: ${(conflictingPluginIds as string[]).join(", ")}`
    : "";
  const reason = reasonCode ? `; 原因: ${String(reasonCode)}` : "";

  switch (String(coverage)) {
    case "active":
      return `✓ 完整监督 — 原生工具受控 | ${String(activeLeaseCount)} 个租约 | v${String(version)} | ${String(finalizerAssurance)}${conflicts}${reason}`;
    case "conditional":
      return `⚠ 有条件 — 仅部分原生工具受控，降级：存在配置冲突或依赖缺失 | v${String(version)}${conflicts}${reason}`;
    case "unsupported":
      return `✗ 不支持 — OpenClaw 版本过低或缺少插件能力 | v${String(version)}${reason}`;
    case "misconfigured":
      return `✗ 配置错误 — 插件、认证、策略或 Docker 配置异常 | v${String(version)}${reason}`;
    case "off":
      return "○ 关闭 — 未启用原生工具监督";
    case "recovery":
      return `⟳ 恢复中 — 从异常恢复，功能受限 | ${String(activeLeaseCount)} 个租约${reason}`;
    case "ready":
      return `○ 就绪 — 等待激活 | v${String(version)}`;
    default:
      return `未知状态: ${String(coverage)}`;
  }
}

export function SystemPage({ state }: SystemPageProps) {
  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在读取系统状态..." />;
  }

  if (state.status === "error" || state.status === "empty") {
    return <ErrorBlock title="系统状态不可用" message={state.message} />;
  }

  return (
    <section className="panel">
      <div className="section-header">
        <div>
          <p className="eyebrow">系统状态</p>
          <h1>系统状态</h1>
        </div>
        <Badge tone="tone-low">{state.data.status === "ok" ? "正常" : state.data.status}</Badge>
      </div>
      <div className="id-grid">
        <div>
          <span>服务</span>
          <code>{state.data.service}</code>
        </div>
        <div>
          <span>更新时间</span>
          <code>{state.data.generatedAt ? formatDateTime(state.data.generatedAt) : "-"}</code>
        </div>
      </div>
      <DeveloperDetails
        items={[
          { label: "Schema", value: state.data.schemaVersion },
          { label: "API 版本", value: state.data.apiVersion },
          { label: "输出目录", value: state.data.outputDir ?? "outputs" },
          { label: "默认适配器", value: state.data.defaultAdapterKind },
          { label: "OpenClaw CLI", value: state.data.health?.openclawCli },
          { label: "Realtime MCP", value: state.data.health?.realtimeMcp },
          { label: "已配置智能体", value: state.data.health?.configuredAgents },
          { label: "原生工具监护", value: renderNativeGuardCoverage(state.data.health?.nativeGuard) },
          { label: "功能开关", value: state.data.features ? Object.keys(state.data.features).length : undefined },
        ]}
        title="系统详情"
      />
      <DeveloperDiagnostics title="系统开发者诊断">
        <DiagnosticSection title="Active agent">
          <DiagnosticKeyValueGrid
            items={[
              { label: "Agent", value: state.data.activeAgent?.agentId },
              { label: "Name", value: state.data.activeAgent?.name },
              { label: "Adapter", value: state.data.activeAgent?.adapterKind },
              { label: "Gateway", value: state.data.activeAgent?.gatewayUrl },
              { label: "Endpoint", value: state.data.activeAgent?.endpointUrl },
              { label: "OpenClaw CLI", value: state.data.activeAgent?.openclawCliPath },
              { label: "Timeout", value: state.data.activeAgent?.timeoutMs },
            ]}
          />
        </DiagnosticSection>
        <DiagnosticSection title="Health">
          <DiagnosticJson value={state.data.health} />
        </DiagnosticSection>
        <DiagnosticSection title="Features">
          <DiagnosticJson value={state.data.features} />
        </DiagnosticSection>
      </DeveloperDiagnostics>
    </section>
  );
}
