import { FileJson } from "lucide-react";
import { useStoredRuns } from "../../lib/hooks/useStoredRuns";
import { StateBlock } from "../../components/ui/StateBlock";

function artifactHref(path: string) {
  if (path.startsWith("outputs/")) return `/${path}`;
  return path;
}

export function Artifacts() {
  const runs = useStoredRuns();
  const artifacts = runs.flatMap((run) =>
    run.results.flatMap((result) =>
      Object.entries(result.artifacts || {}).map(([key, path]) => ({
        runGroupId: run.runGroupId,
        caseId: result.context.caseId,
        key,
        path,
      })),
    ),
  );

  return (
    <section className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Reports</p>
          <h1>Artifacts</h1>
        </div>
      </header>

      {artifacts.length ? (
        <div className="artifact-grid">
          {artifacts.map((artifact) => (
            <a key={`${artifact.runGroupId}-${artifact.caseId}-${artifact.key}`} className="artifact-link" href={artifactHref(artifact.path)} target="_blank" rel="noreferrer">
              <FileJson size={18} />
              <span>
                <strong>{artifact.key}</strong>
                <small>{artifact.caseId}</small>
              </span>
            </a>
          ))}
        </div>
      ) : (
        <StateBlock title="暂无报告产物" detail="完成一次检测后，这里会列出后端生成的 JSON、HTML 和导出文件。" />
      )}
    </section>
  );
}
