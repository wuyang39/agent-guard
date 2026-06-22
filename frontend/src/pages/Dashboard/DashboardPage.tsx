import { Badge } from "../../components/ui/Badge";
import { RunProgress } from "../../components/ui/RunProgress";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "../../components/ui/StateBlock";
import { StatCard } from "../../components/ui/StatCard";
import type { TestSelectionPlan } from "@agent-guard/contracts";
import { categoryLabel, riskLabel, riskTone } from "../../lib/formatters/risk";
import {
  adapterKindLabel,
  policySourceLabel,
  runPhaseDescription,
  runPhaseLabel,
  runPhaseTone,
} from "../../lib/formatters/run";
import { formatDateTime } from "../../lib/formatters/time";
import { buildHistoricalDashboardCards, buildLatestRunCards } from "../../lib/models/dashboard";
import type { CLineDashboardSummary, CLineRunGroup, LoadState } from "../../lib/api/types";

type DashboardPageProps = {
  state: LoadState<CLineDashboardSummary>;
  running: boolean;
  planning: boolean;
  selectionPlanState: LoadState<TestSelectionPlan>;
  onCreateSelectionPlan: () => void;
  onRun: () => void;
  onUseMock: () => void;
  onSelectView: (view: "detection" | "defense" | "trace") => void;
};

export function DashboardPage({
  state,
  running,
  planning,
  selectionPlanState,
  onCreateSelectionPlan,
  onRun,
  onUseMock,
  onSelectView,
}: DashboardPageProps) {
  const busy = running || planning;
  const canRunSelectionPlan =
    selectionPlanState.status === "ready" && selectionPlanState.data.status === "ready";

  if (state.status === "loading" || state.status === "idle") {
    return (
      <LoadingBlock
        message={
          running
            ? "正在按攻击库选择计划运行检测并生成监督策略包..."
            : planning
              ? "正在生成 LLM 攻击库选择计划..."
              : "正在加载总览数据..."
        }
      />
    );
  }

  if (state.status === "empty") {
    return (
      <div className="page-stack fill-page dashboard-page">
        <section className="page-hero dashboard-hero">
          <div className="hero-copy">
            <p className="eyebrow">系统总览</p>
            <h1>总览</h1>
          </div>
          <DashboardRunActions
            busy={busy}
            canRunSelectionPlan={canRunSelectionPlan}
            onCreateSelectionPlan={onCreateSelectionPlan}
            onRun={onRun}
            planning={planning}
            running={running}
          />
        </section>
        <SelectionPlanPanel state={selectionPlanState} planning={planning} running={running} />
        <EmptyBlock title="还没有正式运行记录" message={state.message} />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <ErrorBlock
        title="正式 API 暂不可用"
        message={state.message}
        action={
          <div className="button-row">
            <button className="secondary-button" disabled={busy} onClick={onCreateSelectionPlan}>
              {planning ? "正在选样..." : "重新生成选择计划"}
            </button>
            <button className="primary-button" disabled={busy || !canRunSelectionPlan} onClick={onRun}>
              {running ? "正在运行检测..." : "运行检测生成策略包"}
            </button>
            <button className="secondary-button" onClick={onUseMock}>
              使用示例数据
            </button>
          </div>
        }
      />
    );
  }

  const summary = state.data;
  const latest = summary.latestRunGroup;
  const latestCards = buildLatestRunCards(summary);
  const historicalCards = buildHistoricalDashboardCards(summary);
  const latestRiskLevel = summary.latestRunMetrics?.highestRiskLevel ?? summary.highestRiskLevel;

  return (
    <div className="page-stack fill-page dashboard-page">
      <section className="page-hero dashboard-hero">
        <div className="hero-copy">
          <p className="eyebrow">系统总览</p>
          <h1>总览</h1>
        </div>
        <div className="hero-actions">
          <Badge tone={state.source === "api" ? "tone-low" : "tone-medium"}>
            {state.source === "api" ? "服务已连接" : "示例数据"}
          </Badge>
          {latest ? (
            <Badge tone={runPhaseTone(latest.phase)}>{runPhaseLabel(latest.phase)}</Badge>
          ) : null}
          {selectionPlanState.status === "ready" ? (
            <Badge tone={selectionPlanTone(selectionPlanState.data)}>
              {selectionPlanBadgeText(selectionPlanState.data)}
            </Badge>
          ) : null}
          <DashboardRunActions
            busy={busy}
            canRunSelectionPlan={canRunSelectionPlan}
            onCreateSelectionPlan={onCreateSelectionPlan}
            onRun={onRun}
            planning={planning}
            running={running}
          />
        </div>
      </section>

      <section className="workspace-grid dashboard-workspace">
        <div className="workspace-main">
          <div className="panel dashboard-stage-card">
            <div className="section-header compact">
              <div>
                <h2>当前进度</h2>
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
          </div>

          <SelectionPlanPanel state={selectionPlanState} planning={planning} running={running} />

          <div className="panel dashboard-latest-panel">
            <div className="section-header compact">
              <div>
                <h2>最新运行</h2>
                <p className="muted">主视区只保留最新一次运行的关键结果。</p>
              </div>
              {latest ? (
                <Badge tone={riskTone(latestRiskLevel)}>
                  {riskLabel(latestRiskLevel)}
                </Badge>
              ) : null}
            </div>
            <div className="metric-grid">
              {latestCards.map((card) => (
                <StatCard key={card.label} {...card} />
              ))}
            </div>
          </div>

          <div className="panel dashboard-action-panel">
            <div className="section-header compact">
              <h2>下一步</h2>
            </div>
            {latest ? (
              <div className="dashboard-action-row">
                <button className="secondary-button" onClick={() => onSelectView("detection")}>
                  检测与策略
                </button>
                <button className="secondary-button" onClick={() => onSelectView("defense")}>
                  防御报告
                </button>
                <button className="secondary-button" onClick={() => onSelectView("trace")}>
                  调用轨迹
                </button>
              </div>
            ) : (
              <p className="muted">
                暂无运行组。点击运行按钮后，这里会显示服务返回的最新运行记录。
              </p>
            )}
          </div>
        </div>

        <aside className="surface-rail">
          <div className="rail-section current-run-card">
            <div className="section-header compact">
              <h2>当前运行</h2>
              <Badge tone={latest ? runPhaseTone(latest.phase) : "tone-neutral"}>
                {latest ? adapterKindLabel(latest.adapterKind) : "无记录"}
              </Badge>
            </div>
            {latest ? (
              <div className="rail-list">
                <div>
                  <span>运行组</span>
                  <code>{latest.runGroupId}</code>
                </div>
                <div>
                  <span>智能体</span>
                  <code>{latest.agentName ?? latest.agentId}</code>
                </div>
                <div>
                  <span>选择计划</span>
                  <code>{latest.selectionPlanId ?? "未绑定"}</code>
                </div>
                <div>
                  <span>策略来源</span>
                  <code>{policySourceLabel(latest.policyContextSource)}</code>
                </div>
                <div>
                  <span>更新时间</span>
                  <code>{formatDateTime(latest.updatedAt)}</code>
                </div>
              </div>
            ) : (
              <p className="muted">生成监督策略包后，这里会显示最新运行上下文。</p>
            )}
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>历史累计</h2>
              <Badge>{summary.historicalWindow?.runCount ?? summary.totals.runGroups} 条</Badge>
            </div>
            <MetricList cards={historicalCards} />
          </div>

          <div className="rail-section">
            <div className="section-header compact">
              <h2>风险类别</h2>
              <Badge>历史累计</Badge>
            </div>
            <div className="category-list compact-list">
              {Object.entries(summary.countsByCategory).map(([category, count]) => (
                <div className="category-row" key={category}>
                  <span>{categoryLabel(category as keyof typeof summary.countsByCategory)}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

function DashboardRunActions({
  busy,
  canRunSelectionPlan,
  onCreateSelectionPlan,
  onRun,
  planning,
  running,
}: {
  busy: boolean;
  canRunSelectionPlan: boolean;
  onCreateSelectionPlan: () => void;
  onRun: () => void;
  planning: boolean;
  running: boolean;
}) {
  return (
    <div className="button-row dashboard-run-actions">
      <button className="secondary-button hero-button" disabled={busy} onClick={onCreateSelectionPlan}>
        {planning ? "正在选样..." : "生成攻击库选择计划"}
      </button>
      <button className="primary-button hero-button" disabled={busy || !canRunSelectionPlan} onClick={onRun}>
        {running ? "正在运行检测..." : "运行检测生成策略包"}
      </button>
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
            <h2>LLM 攻击库选择计划</h2>
            <p className="muted">运行前会先让 LLM 辅助选择 A 线攻击库样本，再交给 B 线执行检测。</p>
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
            <h2>LLM 攻击库选择计划</h2>
            <p className="muted">
              {planning
                ? "正在创建 llm_assisted 选择计划并校验覆盖率。"
                : running
                  ? "正在使用当前选择计划运行检测。"
                  : "正在加载选择计划。"}
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
            <h2>LLM 攻击库选择计划</h2>
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
            <h2>LLM 攻击库选择计划</h2>
            <p className="evidence-warning-text">{state.message}</p>
          </div>
          <Badge tone="tone-critical">失败</Badge>
        </div>
      </div>
    );
  }

  const plan = state.data;
  const llmAudit = plan.llmAudit;
  const llmStatus = selectionPlanLlmStatus(plan);
  const auditNotes = [
    ...(plan.fallbackReasons ?? []),
    ...(llmAudit?.validationWarnings ?? []),
  ].slice(0, 3);
  const visibleCases = plan.selectedCasesSummary.slice(0, 5);

  return (
    <div className="panel selection-plan-panel">
      <div className="section-header compact">
        <div>
          <h2>LLM 攻击库选择计划</h2>
          <p className="muted">
            先从 A 线攻击库选出测试样本，再由 B 线执行检测并生成策略包。
          </p>
        </div>
        <div className="button-row">
          <Badge tone={plan.status === "ready" ? "tone-low" : "tone-high"}>{plan.status}</Badge>
          <Badge tone={llmStatus.tone}>{llmStatus.label}</Badge>
        </div>
      </div>

      <div className="id-grid selection-plan-grid">
        <div>
          <span>选择计划</span>
          <code>{plan.selectionPlanId}</code>
        </div>
        <div>
          <span>攻击库</span>
          <code>{plan.corpusManifestId}</code>
        </div>
        <div>
          <span>模式</span>
          <code>{plan.mode}</code>
        </div>
        <div>
          <span>样本数量</span>
          <code>{plan.selectedCaseIds.length}</code>
        </div>
        <div>
          <span>攻击类型覆盖</span>
          <code>{plan.coverageSnapshot.attackFamilyCount}</code>
        </div>
        <div>
          <span>工具面覆盖</span>
          <code>{plan.coverageSnapshot.targetSurfaceCount}</code>
        </div>
      </div>

      <div className="selection-case-list">
        {visibleCases.map((item) => (
          <div className="report-row" key={item.caseId}>
            <code>{item.caseId}</code>
            <span>{item.attackFamilies.join(", ")}</span>
            <span>{item.reason}</span>
          </div>
        ))}
      </div>

      {llmAudit ? (
        <p className="field-note">
          LLM audit: provider={llmAudit.provider}, accepted={llmAudit.acceptedCaseIds.length},
          rejected={llmAudit.rejectedCaseIds.length}, status={llmStatus.detail}
        </p>
      ) : null}
      {auditNotes.length ? (
        <p className="field-note">校验备注: {auditNotes.join("；")}</p>
      ) : null}
    </div>
  );
}

function selectionPlanBadgeText(plan: TestSelectionPlan): string {
  return selectionPlanLlmStatus(plan).label;
}

function selectionPlanTone(plan: TestSelectionPlan): string {
  return selectionPlanLlmStatus(plan).tone;
}

function selectionPlanLlmStatus(plan: TestSelectionPlan): {
  label: string;
  tone: string;
  detail: string;
} {
  const audit = plan.llmAudit;
  if (!audit?.enabled) {
    return {
      label: "规则兜底选样",
      tone: "tone-high",
      detail: "rule_only",
    };
  }

  const failed = isLlmSelectionFailure(audit);
  if (failed) {
    return {
      label: "LLM失败，规则兜底",
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

function isLlmSelectionFailure(audit: NonNullable<TestSelectionPlan["llmAudit"]>): boolean {
  if (audit.acceptedCaseIds.length === 0) return true;
  if (audit.provider === "unknown") return true;
  return audit.validationWarnings.some((warning) =>
    /request failed|returned no valid|disabled|timed out|http/i.test(warning),
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

function MetricList({ cards }: { cards: Array<{ label: string; value: string; hint: string }> }) {
  return (
    <div className="metric-list">
      {cards.map((card) => (
        <div className="metric-list-row" key={card.label}>
          <div>
            <strong>{card.label}</strong>
            <span>{card.hint}</span>
          </div>
          <code>{card.value}</code>
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
