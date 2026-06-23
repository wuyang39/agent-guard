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
