import { Badge } from "../../components/ui/Badge";
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
          <p className="eyebrow">Project Console</p>
          <h1>System</h1>
        </div>
        <Badge tone="tone-low">{state.data.status}</Badge>
      </div>
      <div className="id-grid">
        <div>
          <span>Service</span>
          <code>{state.data.service}</code>
        </div>
        <div>
          <span>Schema</span>
          <code>{state.data.schemaVersion}</code>
        </div>
        <div>
          <span>Output store</span>
          <code>{state.data.outputDir ?? "outputs"}</code>
        </div>
        <div>
          <span>Updated</span>
          <code>{state.data.generatedAt ? formatDateTime(state.data.generatedAt) : "-"}</code>
        </div>
      </div>
      {state.data.features ? (
        <div className="category-list">
          {Object.entries(state.data.features).map(([key, enabled]) => (
            <div className="category-row" key={key}>
              <span>{key}</span>
              <Badge tone={enabled ? "tone-low" : "tone-high"}>
                {enabled ? "enabled" : "disabled"}
              </Badge>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
