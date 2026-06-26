import type { TestSelectionPlan } from "@agent-guard/contracts";
import { Badge } from "../../components/ui/Badge";
import {
  DeveloperDiagnostics,
  DiagnosticJson,
  DiagnosticKeyValueGrid,
  DiagnosticSection,
  DiagnosticTable,
} from "../../components/ui/DeveloperDiagnostics";
import { DeveloperDetails } from "../../components/ui/DeveloperDetails";
import { RunProgress } from "../../components/ui/RunProgress";
import { LoadingBlock } from "../../components/ui/StateBlock";
import type { CLineDashboardSummary, CLineRunGroup, LoadState } from "../../lib/api/types";
import {
  runPhaseDescription,
  runPhaseLabel,
  runPhaseTone,
} from "../../lib/formatters/run";
import { formatDateTime } from "../../lib/formatters/time";

type RunWorkflowPageProps = {
  summaryState: LoadState<CLineDashboardSummary>;
  selectionPlanState: LoadState<TestSelectionPlan>;
  selectionCaseCount: number;
  running: boolean;
  planning: boolean;
  canceling: boolean;
  onCreateSelectionPlan: () => void;
  onCancelRun: (runGroupId: string) => void;
  onRun: () => void;
  onSelectionCaseCountChange: (caseCount: number) => void;
};

export function RunWorkflowPage({
  summaryState,
  selectionPlanState,
  selectionCaseCount,
  running,
  planning,
  canceling,
  onCreateSelectionPlan,
  onCancelRun,
  onRun,
  onSelectionCaseCountChange,
}: RunWorkflowPageProps) {
  const busy = running || planning;
  const canRunSelectionPlan =
    selectionPlanState.status === "ready" && selectionPlanState.data.status === "ready";
  const summary = summaryState.status === "ready" ? summaryState.data : undefined;
  const latest = selectWorkflowRunGroup(summary, selectionPlanState);
  const canCancelLatestRun = latest?.status === "running";

  if (summaryState.status === "loading" || summaryState.status === "idle") {
    return (
      <LoadingBlock
        message={
          running
            ? "正在运行检测并生成监督策略包..."
            : planning
              ? "正在生成用例计划..."
              : "正在加载检测编排状态..."
        }
      />
    );
  }

  return (
    <div className="page-stack fill-page run-workflow-page">
      <section className="page-hero workflow-hero">
        <div className="hero-copy">
          <p className="eyebrow">检测与策略包</p>
          <h1>检测编排</h1>
        </div>
      </section>

      {summaryState.status === "error" ? (
        <div className="panel evidence-panel-warning">
          <div className="section-header compact">
            <div>
              <h2>运行服务异常</h2>
              <p className="evidence-warning-text">{summaryState.message}</p>
            </div>
            <Badge tone="tone-critical">API 异常</Badge>
          </div>
        </div>
      ) : null}

      <section className="workspace-main run-workflow-workspace">
        <div className="panel workflow-control-panel">
            <div className="section-header compact">
              <div>
                <h2>编排操作</h2>
              </div>
            </div>
            <div className="sample-count-control">
              <label className="field">
                <span>LLM 选样数量</span>
                <input
                  disabled={busy}
                  max={500}
                  min={3}
                  onChange={(event) =>
                    onSelectionCaseCountChange(Number(event.target.value))
                  }
                  step={1}
                  type="number"
                  value={selectionCaseCount}
                />
                <small className="field-note">
                  演示可选 10 或 30；完整检测可选 120 或 300。
                </small>
              </label>
              <div className="button-row sample-count-presets">
                {[10, 30, 120, 300].map((count) => (
                  <button
                    className={
                      selectionCaseCount === count
                        ? "primary-button compact-button"
                        : "secondary-button compact-button"
                    }
                    disabled={busy}
                    key={count}
                    onClick={() => onSelectionCaseCountChange(count)}
                    type="button"
                  >
                    {count}
                  </button>
                ))}
              </div>
            </div>
            <div className="workflow-action-grid">
              <button
                className="secondary-button workflow-action-button"
                disabled={busy}
                onClick={onCreateSelectionPlan}
              >
                <strong>{planning ? "正在选样..." : "生成用例计划"}</strong>
              </button>
              <button
                className="primary-button workflow-action-button"
                disabled={busy || !canRunSelectionPlan}
                onClick={onRun}
              >
                <strong>{running ? "正在运行检测..." : "运行检测生成策略包"}</strong>
              </button>
              {canCancelLatestRun ? (
                <button
                  className="secondary-button workflow-action-button danger-button"
                  disabled={canceling}
                  onClick={() => onCancelRun(latest.runGroupId)}
                  type="button"
                >
                  <strong>{canceling ? "正在停止..." : "停止检测"}</strong>
                </button>
              ) : null}
            </div>
        </div>

        <SelectionPlanPanel state={selectionPlanState} planning={planning} running={running} />

        <div className="panel dashboard-stage-card">
            <div className="section-header compact">
              <div>
                <h2>编排阶段</h2>
                <p className="muted">
                  {latest ? runPhaseDescription(latest.phase) : "还没有运行记录。"}
                </p>
              </div>
              <Badge tone={latest ? runPhaseTone(latest.phase) : "tone-neutral"}>
                {latest ? runPhaseLabel(latest.phase) : "等待运行"}
              </Badge>
            </div>
            {latest ? <RunStageRail runGroup={latest} /> : <EmptyStageRail />}
            {latest ? <RunProgress runGroup={latest} /> : null}
            {latest ? (
              <DeveloperDetails
                items={[
                  { label: "运行组", value: latest.runGroupId },
                  { label: "智能体", value: latest.agentName ?? latest.agentId },
                  { label: "适配器", value: latest.adapterKind },
                  { label: "策略来源", value: latest.policyContextSource },
                  { label: "选择计划", value: latest.selectionPlanId },
                  { label: "策略包", value: latest.policyPackId },
                  { label: "Trace 数", value: latest.traceIds.length },
                  { label: "Runtime session 数", value: latest.runtimeSessionIds.length },
                  { label: "Artifact 数", value: latest.artifactIds.length },
                  { label: "错误", value: latest.error },
                  { label: "创建时间", value: formatDateTime(latest.createdAt) },
                  { label: "更新时间", value: formatDateTime(latest.updatedAt) },
                ]}
                title="运行详情"
              />
            ) : null}
            {latest ? <RunGroupDiagnostics runGroup={latest} /> : null}
        </div>
      </section>
    </div>
  );
}

function SelectionPlanPanel({
  state,
  planning,
  running,
}: {
  state: LoadState<TestSelectionPlan>;
  planning: boolean;
  running: boolean;
}) {
  if (state.status === "idle") {
    return (
      <div className="panel selection-plan-panel">
        <div className="section-header compact">
          <div>
            <h2>用例计划</h2>
            <p className="muted">运行前先选择测试用例，再执行检测。</p>
          </div>
          <Badge>等待选样</Badge>
        </div>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="panel selection-plan-panel">
        <div className="section-header compact">
          <div>
            <h2>用例计划</h2>
            <p className="muted">
              {planning
                ? "正在选择测试用例并校验覆盖率。"
                : running
                  ? "正在使用当前用例计划运行检测。"
                  : "正在加载用例计划。"}
            </p>
          </div>
          <Badge tone="tone-medium">生成中</Badge>
        </div>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="panel selection-plan-panel">
        <div className="section-header compact">
          <div>
            <h2>用例计划</h2>
            <p className="muted">{state.message}</p>
          </div>
          <Badge>无计划</Badge>
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="panel selection-plan-panel evidence-panel-warning">
        <div className="section-header compact">
          <div>
            <h2>用例计划</h2>
            <p className="evidence-warning-text">{state.message}</p>
          </div>
          <Badge tone="tone-critical">失败</Badge>
        </div>
      </div>
    );
  }

  const plan = state.data;
  const llmStatus = selectionPlanLlmStatus(plan);

  return (
    <div className="panel selection-plan-panel">
      <div className="section-header compact">
        <div>
          <h2>用例计划</h2>
        </div>
        <div className="button-row">
          <Badge tone={plan.status === "ready" || plan.status === "completed" ? "tone-low" : "tone-high"}>
            {selectionPlanStatusLabel(plan.status)}
          </Badge>
          <Badge tone={llmStatus.tone}>{llmStatus.label}</Badge>
        </div>
      </div>

      <div className="id-grid selection-plan-grid">
        <div>
          <span>检测样本</span>
          <code>{plan.selectionRunSummary.selectedCaseCount}</code>
        </div>
        <div>
          <span>请求选样</span>
          <code>{plan.requestedCaseCount}</code>
        </div>
        <div>
          <span>候选池</span>
          <code>{plan.selectionRunSummary.candidateCaseCount}</code>
        </div>
        <div>
          <span>攻击类型覆盖</span>
          <code>{plan.coverageSnapshot.attackFamilyCount}</code>
        </div>
      </div>
      <DeveloperDetails
        items={[
          { label: "选择计划", value: plan.selectionPlanId },
          { label: "攻击库", value: plan.corpusManifestId },
          { label: "选择模式", value: plan.mode },
          { label: "目标画像", value: plan.targetProfile },
          { label: "请求样本数", value: plan.requestedCaseCount },
          { label: "候选池规模", value: plan.selectionRunSummary.candidateCaseCount },
          { label: "LLM 重排池", value: plan.llmAudit?.llmCandidatePoolSize },
          { label: "LLM 种子数", value: plan.llmAudit?.llmSeedCaseCount },
          { label: "LLM 提供方", value: plan.llmAudit?.provider },
          { label: "规则兜底", value: plan.selectionRunSummary.fallbackUsed },
          { label: "目标面", value: plan.coverageSnapshot.targetSurfaceCount },
        ]}
        title="计划详情"
      />
      <SelectionPlanDiagnostics plan={plan} />
    </div>
  );
}

function SelectionPlanDiagnostics({ plan }: { plan: TestSelectionPlan }) {
  const selectionIssues = [
    ...plan.coverageSnapshot.blockingIssues,
    ...plan.coverageSnapshot.warnings,
    ...plan.evalStyleResult.failedChecks,
    ...plan.evalStyleResult.warnings,
    ...plan.fallbackReasons,
    ...(plan.llmAudit?.validationWarnings ?? []),
  ];

  return (
    <DeveloperDiagnostics
      count={plan.selectedCasesSummary.length + plan.selectionReasons.length + selectionIssues.length}
      title="用例计划开发者诊断"
    >
      <DiagnosticSection title="覆盖与 LLM 审计">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Selection plan", value: plan.selectionPlanId },
            { label: "Corpus", value: plan.corpusManifestId },
            { label: "Profile", value: plan.targetProfile },
            { label: "Mode", value: plan.mode },
            { label: "Status", value: plan.status },
            { label: "Ready", value: plan.coverageSnapshot.ready },
            { label: "Candidate cases", value: plan.selectionRunSummary.candidateCaseCount },
            { label: "Requested cases", value: plan.requestedCaseCount },
            { label: "Selected cases", value: plan.selectionRunSummary.selectedCaseCount },
            { label: "Rule selected", value: plan.selectionRunSummary.ruleSelectedCount },
            { label: "LLM accepted", value: plan.selectionRunSummary.llmAcceptedCount },
            { label: "LLM rejected", value: plan.selectionRunSummary.llmRejectedCount },
            { label: "LLM candidate pool", value: plan.llmAudit?.llmCandidatePoolSize },
            { label: "LLM seed limit", value: plan.llmAudit?.llmSeedCaseCount },
            { label: "LLM over-limit ignored", value: plan.llmAudit?.ignoredOverLimitCount },
            { label: "Fallback used", value: plan.selectionRunSummary.fallbackUsed },
            { label: "LLM provider", value: plan.llmAudit?.provider },
            { label: "LLM model", value: plan.llmAudit?.model },
            { label: "Input digest", value: plan.llmAudit?.inputDigest },
            { label: "Output digest", value: plan.llmAudit?.outputDigest },
          ]}
        />
        <DiagnosticJson value={selectionIssues.length ? selectionIssues : plan.coverageSnapshot} />
      </DiagnosticSection>

      <DiagnosticSection title="选中样本" count={plan.selectedCasesSummary.length}>
        <DiagnosticTable
          columns={[
            { header: "Case", render: (row) => <code>{row.caseId}</code> },
            { header: "Name", render: (row) => row.caseName },
            { header: "Families", render: (row) => row.attackFamilies.join(", ") || "-" },
            { header: "Surfaces", render: (row) => row.targetSurfaces.join(", ") || "-" },
            { header: "Quality", render: (row) => row.qualityScore },
            { header: "Reason", render: (row) => row.reason },
          ]}
          rowKey={(row) => row.caseId}
          rows={plan.selectedCasesSummary}
        />
      </DiagnosticSection>

      <DiagnosticSection title="选择原因" count={plan.selectionReasons.length}>
        <DiagnosticTable
          columns={[
            { header: "Case", render: (row) => <code>{row.caseId}</code> },
            { header: "Source", render: (row) => row.source },
            { header: "Reason", render: (row) => row.reason },
          ]}
          maxRows={18}
          rowKey={(row, index) => `${row.caseId}.${row.source}.${index}`}
          rows={plan.selectionReasons}
        />
      </DiagnosticSection>

      <DiagnosticSection title="LLM 原始审计">
        <DiagnosticJson value={plan.llmAudit} />
      </DiagnosticSection>
    </DeveloperDiagnostics>
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
      title="运行组开发者诊断"
    >
      <DiagnosticSection title="编排状态">
        <DiagnosticKeyValueGrid
          items={[
            { label: "Run group", value: runGroup.runGroupId },
            { label: "Status", value: runGroup.status },
            { label: "Phase", value: runGroup.phase },
            { label: "Policy context", value: runGroup.policyContextSource },
            { label: "Adapter", value: runGroup.adapterKind },
            { label: "Agent", value: runGroup.agentName ?? runGroup.agentId },
            { label: "Created", value: formatDateTime(runGroup.createdAt) },
            { label: "Updated", value: formatDateTime(runGroup.updatedAt) },
            { label: "Error", value: runGroup.error },
          ]}
        />
        <DiagnosticJson value={runGroup.progress} emptyLabel="暂无 case 级进度明细" />
      </DiagnosticSection>

      <DiagnosticSection
        title="失败与重试样本"
        count={runGroup.progress?.caseFailures?.length ?? 0}
      >
        <DiagnosticTable
          columns={[
            { header: "Case", render: (row) => <code>{row.caseId}</code> },
            { header: "Category", render: (row) => row.category },
            { header: "Attempts", render: (row) => row.attempts },
            { header: "Skipped", render: (row) => (row.skipped ? "yes" : "no") },
            { header: "Retryable", render: (row) => (row.retryable ? "yes" : "no") },
            { header: "Reason", render: (row) => row.reason },
          ]}
          emptyLabel="暂无失败样本"
          rowKey={(row, index) => `${row.caseId}.${index}`}
          rows={runGroup.progress?.caseFailures ?? []}
        />
      </DiagnosticSection>

      <DiagnosticSection title="对象 ID 列表">
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

function selectWorkflowRunGroup(
  summary: CLineDashboardSummary | undefined,
  selectionPlanState: LoadState<TestSelectionPlan>,
): CLineRunGroup | undefined {
  if (!summary) return undefined;
  if (selectionPlanState.status !== "ready") return summary.latestRunGroup;

  const selectionPlanId = selectionPlanState.data.selectionPlanId;
  const matchingRun = summary.recentRunGroups.find(
    (runGroup) => runGroup.selectionPlanId === selectionPlanId,
  );
  return matchingRun;
}

function selectionPlanLlmStatus(plan: TestSelectionPlan): {
  label: string;
  tone: string;
  detail: string;
} {
  const audit = plan.llmAudit;
  if (!audit?.enabled) {
    return {
      label: "规则选样",
      tone: "tone-high",
      detail: "rule_only",
    };
  }

  const failed = isLlmSelectionFailure(audit);
  if (failed) {
    return {
      label: "LLM失败，已改用规则",
      tone: "tone-critical",
      detail: "llm_failed_rule_fallback",
    };
  }

  if (audit.fallbackUsed || plan.selectionRunSummary.fallbackUsed) {
    return {
      label: "LLM选样+规则校验",
      tone: "tone-medium",
      detail: "llm_ranked_validated_by_rules",
    };
  }

  return {
    label: `LLM ${audit.provider}`,
    tone: "tone-medium",
    detail: "llm_selected",
  };
}

function selectionPlanStatusLabel(status: TestSelectionPlan["status"]): string {
  const labels: Record<TestSelectionPlan["status"], string> = {
    draft: "草稿",
    ready: "已完成",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
  };
  return labels[status] ?? status;
}

function isLlmSelectionFailure(audit: NonNullable<TestSelectionPlan["llmAudit"]>): boolean {
  if (audit.acceptedCaseIds.length === 0) return true;
  if (audit.provider === "unknown") return true;
  return audit.validationWarnings.some((warning) =>
    /request failed|returned no valid|disabled|timed out|http/i.test(warning),
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

function EmptyStageRail() {
  const stages = ["检测", "策略包", "实时监督", "防御报告"];
  return (
    <div className="run-stage-rail">
      {stages.map((stage) => (
        <div className="run-stage pending" key={stage}>
          <span />
          <strong>{stage}</strong>
        </div>
      ))}
    </div>
  );
}

function RunStageRail({ runGroup }: { runGroup: CLineRunGroup }) {
  const stages: Array<{
    key: "detecting" | "policy_ready" | "supervision_completed" | "defense_report_ready";
    label: string;
  }> = [
    { key: "detecting", label: "检测" },
    { key: "policy_ready", label: "策略包" },
    { key: "supervision_completed", label: "实时监督" },
    { key: "defense_report_ready", label: "防御报告" },
  ];

  return (
    <div className="run-stage-rail">
      {stages.map((stage) => (
        <div className={`run-stage ${stageState(runGroup.phase, stage.key)}`} key={stage.key}>
          <span />
          <strong>{stage.label}</strong>
        </div>
      ))}
    </div>
  );
}

function stageState(
  phase: CLineRunGroup["phase"],
  stage: "detecting" | "policy_ready" | "supervision_completed" | "defense_report_ready",
): "done" | "active" | "pending" | "failed" {
  if (phase === "failed") return "failed";

  const order: Record<CLineRunGroup["phase"], number> = {
    queued: 0,
    detecting: 1,
    policy_ready: 2,
    supervising: 3,
    supervision_completed: 3,
    defense_report_ready: 4,
    failed: 0,
  };
  const stageOrder = {
    detecting: 1,
    policy_ready: 2,
    supervision_completed: 3,
    defense_report_ready: 4,
  }[stage];
  const phaseOrder = order[phase];

  if (phaseOrder > stageOrder) return "done";
  if (phaseOrder === stageOrder) return "active";
  return "pending";
}
