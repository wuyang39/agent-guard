import { Badge } from "../../components/ui/Badge";
import {
  DeveloperDiagnostics,
  DiagnosticJson,
  DiagnosticKeyValueGrid,
  DiagnosticSection,
} from "../../components/ui/DeveloperDiagnostics";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
import { RunProgress } from "../../components/ui/RunProgress";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import type { CLineRunGroup, LoadState } from "../../lib/api/types";
import { runPhaseLabel, runPhaseTone } from "../../lib/formatters/run";
import { formatDateTime } from "../../lib/formatters/time";

type TestRunsPageProps = {
  state: LoadState<{ schemaVersion: "mvp-1"; runGroups: CLineRunGroup[] }>;
  onSelectRunGroup: (runGroup: CLineRunGroup) => void;
  onActivateRunPolicy: (runGroup: CLineRunGroup) => void;
  selectedRunGroupId?: string;
  activeRealtimePolicyPackId?: string;
  activatingRealtimePolicyPackId?: string;
  realtimePolicyActivationError?: string;
};

export function TestRunsPage({
  state,
  onSelectRunGroup,
  onActivateRunPolicy,
  selectedRunGroupId,
  activeRealtimePolicyPackId,
  activatingRealtimePolicyPackId,
  realtimePolicyActivationError,
}: TestRunsPageProps) {
  if (state.status === "idle" || state.status === "loading") {
    return <LoadingBlock message="正在加载测试运行索引..." />;
  }

  if (state.status === "error") {
    return <ErrorBlock title="测试运行加载失败" message={state.message} />;
  }

  if (state.status === "empty" || state.data.runGroups.length === 0) {
    return (
      <EmptyBlock
        title="没有测试运行"
        message="生成监督策略包后，这里会显示运行索引。"
      />
    );
  }

  const selectedRunGroup =
    state.data.runGroups.find((runGroup) => runGroup.runGroupId === selectedRunGroupId) ??
    state.data.runGroups[0];

  return (
    <div className="page-stack">
      <section className="panel">
        <div className="section-header">
          <div>
            <p className="eyebrow">证据中心</p>
            <h1>测试运行</h1>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>运行时间</th>
                <th>阶段</th>
                <th>检测进度</th>
                <th>用例</th>
                <th>风险报告</th>
                <th>策略包</th>
                <th>策略使用</th>
              </tr>
            </thead>
            <tbody>
              {state.data.runGroups.map((runGroup) => {
                const selected = selectedRunGroupId === runGroup.runGroupId;
                const isActivePolicy =
                  Boolean(runGroup.policyPackId) &&
                  runGroup.policyPackId === activeRealtimePolicyPackId;
                const isActivating =
                  Boolean(runGroup.policyPackId) &&
                  runGroup.policyPackId === activatingRealtimePolicyPackId;
                const policyActivation = getRunPolicyActivationState(runGroup);
                return (
                  <tr
                    className={`selectable-row${selected ? " selected-row" : ""}`}
                    key={runGroup.runGroupId}
                    onClick={() => onSelectRunGroup(runGroup)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectRunGroup(runGroup);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <td>
                      {formatDateTime(runGroup.updatedAt)}
                    </td>
                    <td>
                      <Badge tone={runPhaseTone(runGroup.phase)}>{runPhaseLabel(runGroup.phase)}</Badge>
                    </td>
                    <td className="progress-cell">
                      <RunProgress runGroup={runGroup} compact />
                    </td>
                    <td>{runGroup.caseIds.length}</td>
                    <td>{runGroup.riskReportIds.length}</td>
                    <td>
                      <Badge tone={runGroup.policyPackId ? "tone-low" : "tone-neutral"}>
                        {runGroup.policyPackId ? "已生成" : "未生成"}
                      </Badge>
                    </td>
                    <td>
                      <button
                        className={`secondary-button compact-button run-policy-action${
                          isActivePolicy ? " active" : ""
                        }`}
                        disabled={!policyActivation.canUse || isActivePolicy || isActivating}
                        title={policyActivation.reason}
                        onClick={(event) => {
                          event.stopPropagation();
                          onSelectRunGroup(runGroup);
                          onActivateRunPolicy(runGroup);
                        }}
                        type="button"
                      >
                        {isActivePolicy
                          ? "当前策略"
                          : isActivating
                            ? "使用中"
                            : policyActivation.label}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {realtimePolicyActivationError ? (
          <p className="run-policy-error">{realtimePolicyActivationError}</p>
        ) : null}
        {selectedRunGroup ? (
          <DeveloperDetails
            items={[
              { label: "运行组", value: selectedRunGroup.runGroupId },
              { label: "智能体", value: selectedRunGroup.agentName ?? selectedRunGroup.agentId },
              { label: "适配器", value: selectedRunGroup.adapterKind },
              { label: "策略来源", value: selectedRunGroup.policyContextSource },
              { label: "选择计划", value: selectedRunGroup.selectionPlanId },
              { label: "检测报告", value: selectedRunGroup.detectionReportId },
              { label: "风险画像", value: selectedRunGroup.riskProfileId },
              { label: "策略包", value: selectedRunGroup.policyPackId },
              { label: "防御报告", value: selectedRunGroup.defenseReportId },
              { label: "Trace 数", value: selectedRunGroup.traceIds.length },
              { label: "Runtime session 数", value: selectedRunGroup.runtimeSessionIds.length },
              { label: "Artifact 数", value: selectedRunGroup.artifactIds.length },
            ]}
            title="选中运行详情"
          />
        ) : null}
        {selectedRunGroup ? <RunGroupDiagnostics runGroup={selectedRunGroup} /> : null}
      </section>
    </div>
  );
}

function RunGroupDiagnostics({ runGroup }: { runGroup: CLineRunGroup }) {
  return (
    <DeveloperDiagnostics
      count={
        runGroup.caseIds.length +
        runGroup.traceIds.length +
        runGroup.riskReportIds.length +
        runGroup.runtimeSessionIds.length +
        runGroup.artifactIds.length
      }
      title="选中运行开发者诊断"
    >
      <DiagnosticSection title="状态与进度">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Run group", value: runGroup.runGroupId },
            { label: "Status", value: runGroup.status },
            { label: "Phase", value: runGroup.phase },
            { label: "Policy context", value: runGroup.policyContextSource },
            { label: "Adapter", value: runGroup.adapterKind },
            { label: "Case count", value: runGroup.caseCount ?? runGroup.caseIds.length },
            { label: "Created", value: formatDateTime(runGroup.createdAt) },
            { label: "Updated", value: formatDateTime(runGroup.updatedAt) },
          ]}
        />
        <DiagnosticJson value={runGroup.progress} emptyLabel="暂无 progress payload" />
      </DiagnosticSection>

      <DiagnosticSection title="证据对象">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Selection plan", value: runGroup.selectionPlanId },
            { label: "Detection report", value: runGroup.detectionReportId },
            { label: "Risk profile", value: runGroup.riskProfileId },
            { label: "Policy pack", value: runGroup.policyPackId },
            { label: "Defense report", value: runGroup.defenseReportId },
          ]}
        />
        <div className="diagnostic-run-id-groups">
          <DiagnosticIdGroup label="Cases" values={runGroup.caseIds} />
          <DiagnosticIdGroup label="Traces" values={runGroup.traceIds} />
          <DiagnosticIdGroup label="Risk reports" values={runGroup.riskReportIds} />
          <DiagnosticIdGroup label="Runtime sessions" values={runGroup.runtimeSessionIds} />
          <DiagnosticIdGroup label="Artifacts" values={runGroup.artifactIds} />
        </div>
      </DiagnosticSection>
    </DeveloperDiagnostics>
  );
}

function DiagnosticIdGroup({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="diagnostic-id-group">
      <strong>{label}</strong>
      <CodeList values={values} />
    </div>
  );
}

function CodeList({ values }: { values: string[] }) {
  if (!values.length) return <span className="muted">-</span>;
  return (
    <span className="diagnostic-id-list">
      {values.map((value, index) => (
        <code key={`${value}.${index}`}>{value}</code>
      ))}
    </span>
  );
}

function getRunPolicyActivationState(runGroup: CLineRunGroup): {
  canUse: boolean;
  label: string;
  reason: string;
} {
  if (!runGroup.policyPackId) {
    return {
      canUse: false,
      label: "无策略包",
      reason: "该运行尚未生成策略包。",
    };
  }
  if (runGroup.adapterKind !== "openclaw") {
    return {
      canUse: false,
      label: "非 OpenClaw",
      reason: "实时监督当前只接受 OpenClaw 检测生成的策略包。",
    };
  }
  if (runGroup.status === "failed" || runGroup.phase === "failed") {
    return {
      canUse: false,
      label: "运行失败",
      reason: "失败运行的策略包不能用于实时监督。",
    };
  }
  if (runGroup.phase === "queued" || runGroup.phase === "detecting") {
    return {
      canUse: false,
      label: "未完成",
      reason: "检测完成并生成策略包后才能用于实时监督。",
    };
  }
  if (runGroup.policyContextSource && runGroup.policyContextSource !== "stored_detection") {
    return {
      canUse: false,
      label: "不可复用",
      reason: "实时监督只复用真实检测上下文生成的策略包。",
    };
  }
  return {
    canUse: true,
    label: "使用策略包",
    reason: "将该运行生成的策略包设为实时监督当前策略。",
  };
}
