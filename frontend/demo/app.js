let bootstrap = null;
let currentStep = 0;
let currentModule = "overview";
let selectedScenarioIds = [];
let runPayloads = [];
let validationPayloads = [];
let holdoutPayloads = [];
let policyBuilt = false;
let validationDone = false;
let holdoutDone = false;
let reportBuilt = false;
let runTimerId = null;
let runStartedAtMs = null;

const stepMeta = [
  ["0. Agent 接入", "选择 OpenClaw 作为核心演示 Agent，HTTP 示例和 Mock 作为兜底。", "等待接入 Agent"],
  ["1. 攻击场景", "选择 3 类以上红队攻击场景，包含对抗样本、越狱测试用例和攻击脚本。", "等待选择测试集"],
  ["2. 监督前风险画像", "系统不做阻断，只观察 Agent 行为并生成 RiskReport、DetectionReport 和 AgentRiskProfile。", "等待运行监督前检测"],
  ["3. 监督策略包", "根据风险画像生成 SupervisionPolicyPack，并按策略组展示防御逻辑。", "等待生成策略包"],
  ["4. 监督验证", "选择阻断、观察或询问模式，验证策略包能否拦截或发现风险行为。", "等待运行监督验证"],
  ["5. 未知风险复测", "使用未参与策略生成的外部留出样本，验证策略包对未知风险的发现能力。", "等待运行未知风险复测"],
  ["6. 防御报告", "汇总监督前风险、策略命中、阻断、告警、未知复测命中率和残余风险。", "等待生成防御报告"],
];

const riskRank = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

const policyGroups = [
  {
    groupId: "io_filter",
    title: "输入输出过滤策略",
    action: "sanitize / redact",
    target: "tool_result / api_call / email_send",
    detail: "清理工具返回中的指令化内容，脱敏外发载荷中的 secret marker。",
  },
  {
    groupId: "context_isolation",
    title: "上下文隔离策略",
    action: "warn / isolate",
    target: "prompt_or_tool_output",
    detail: "把检索内容和工具输出当作数据处理，降低间接提示注入的优先级。",
  },
  {
    groupId: "dangerous_tool_block",
    title: "高危工具阻断策略",
    action: "deny / ask",
    target: "tool_call",
    detail: "对读 secret、写文件、代码执行、SSRF 等高危工具动作执行阻断或确认。",
  },
  {
    groupId: "sensitive_resource_guard",
    title: "敏感资源访问策略",
    action: "deny",
    target: "resource_access",
    detail: "阻止 Agent 访问未授权 secret、内部配置或越权数据库资源。",
  },
  {
    groupId: "outbound_api_audit",
    title: "外部 API 出站审计策略",
    action: "deny / warn",
    target: "api_call / send_request",
    detail: "审计出站 API、邮件和 webhook 调用，发现外泄 endpoint 时告警或阻断。",
  },
];

const attackTypeLabels = {
  indirect_prompt_injection: "提示注入",
  data_exfiltration: "数据泄露",
  tool_abuse: "工具调用劫持",
  authorization_bypass: "越权访问",
  tool_poisoning_rug_pull: "工具投毒",
};

const attackScripts = {
  indirect_prompt_injection: "scripts/attacks/indirect_prompt_payload.ts",
  data_exfiltration: "scripts/attacks/exfiltration_email_flow.ts",
  tool_abuse: "scripts/attacks/tool_abuse_path_ssrf.ts",
  authorization_bypass: "scripts/attacks/admin_claim_bypass.ts",
  tool_poisoning_rug_pull: "scripts/attacks/tool_poisoning_rug_pull.ts",
};

const $ = (selector) => document.querySelector(selector);

const els = {
  landingPage: $("#landingPage"),
  consoleApp: $("#consoleApp"),
  enterConsoleButtons: document.querySelectorAll("[data-enter-console]"),
  moduleViews: document.querySelectorAll(".module-view"),
  moduleTriggers: document.querySelectorAll("[data-module-target]"),
  overviewStatus: $("#overviewStatus"),
  overviewStatusDetail: $("#overviewStatusDetail"),
  overviewLastRun: $("#overviewLastRun"),
  kpiCases: $("#kpiCases"),
  kpiTools: $("#kpiTools"),
  kpiResources: $("#kpiResources"),
  kpiRules: $("#kpiRules"),
  configBoard: $("#configBoard"),
  detectionDashboard: $("#detectionDashboard"),
  supervisionDashboard: $("#supervisionDashboard"),
  reportDashboard: $("#reportDashboard"),
  externalDashboard: $("#externalDashboard"),
  stepList: $("#stepList"),
  stepTitle: $("#stepTitle"),
  stepIntro: $("#stepIntro"),
  flowStatus: $("#flowStatus"),
  agentName: $("#agentName"),
  agentId: $("#agentId"),
  adapterType: $("#adapterType"),
  openClawWorkspace: $("#openClawWorkspace"),
  agentEndpoint: $("#agentEndpoint"),
  timeoutMs: $("#timeoutMs"),
  agentPreview: $("#agentPreview"),
  useSampleApiButton: $("#useSampleApiButton"),
  finishAgentButton: $("#finishAgentButton"),
  modeSelect: $("#modeSelect"),
  scenarioBoard: $("#scenarioBoard"),
  contextPreview: $("#contextPreview"),
  fileStrip: $("#fileStrip"),
  finishEnvButton: $("#finishEnvButton"),
  runInput: $("#runInput"),
  runButton: $("#runButton"),
  runEvents: $("#runEvents"),
  runToolCalls: $("#runToolCalls"),
  runErrors: $("#runErrors"),
  runSummary: $("#runSummary"),
  runStartedAt: $("#runStartedAt"),
  runDuration: $("#runDuration"),
  runCompletedAt: $("#runCompletedAt"),
  riskBadge: $("#riskBadge"),
  riskScore: $("#riskScore"),
  findingCount: $("#findingCount"),
  weaknessCount: $("#weaknessCount"),
  policyCount: $("#policyCount"),
  findingList: $("#findingList"),
  toPolicyButton: $("#toPolicyButton"),
  riskInput: $("#riskInput"),
  policyGroupGrid: $("#policyGroupGrid"),
  buildRiskButton: $("#buildRiskButton"),
  policyList: $("#policyList"),
  verificationMode: $("#verificationMode"),
  validationInput: $("#validationInput"),
  runValidationButton: $("#runValidationButton"),
  validationHitCount: $("#validationHitCount"),
  validationBlockedCount: $("#validationBlockedCount"),
  validationAlertCount: $("#validationAlertCount"),
  supervisionList: $("#supervisionList"),
  toHoldoutButton: $("#toHoldoutButton"),
  externalPreview: $("#externalPreview"),
  runHoldoutButton: $("#runHoldoutButton"),
  holdoutCaseCount: $("#holdoutCaseCount"),
  holdoutHitRate: $("#holdoutHitRate"),
  holdoutResidualCount: $("#holdoutResidualCount"),
  holdoutList: $("#holdoutList"),
  buildReportButton: $("#buildReportButton"),
  artifactText: $("#artifactText"),
  defenseHtmlButton: $("#defenseHtmlButton"),
  preRiskCount: $("#preRiskCount"),
  policyHitCount: $("#policyHitCount"),
  chainCount: $("#chainCount"),
  evidenceCount: $("#evidenceCount"),
  finalHoldoutRate: $("#finalHoldoutRate"),
  reportRisk: $("#reportRisk"),
  evidenceList: $("#evidenceList"),
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function riskText(risk) {
  return { none: "无风险", low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" }[risk] || risk || "未判定";
}

function formatClock(value) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function setRuntimeDisplay({ startedAt, completedAt, durationMs }) {
  els.runStartedAt.textContent = formatClock(startedAt);
  els.runCompletedAt.textContent = formatClock(completedAt);
  els.runDuration.textContent = formatDuration(durationMs);
}

function startRunTimer() {
  runStartedAtMs = Date.now();
  setRuntimeDisplay({ startedAt: runStartedAtMs, completedAt: null, durationMs: 0 });
  window.clearInterval(runTimerId);
  runTimerId = window.setInterval(() => {
    setRuntimeDisplay({ startedAt: runStartedAtMs, completedAt: null, durationMs: Date.now() - runStartedAtMs });
  }, 200);
}

function stopRunTimer() {
  const completedAt = Date.now();
  window.clearInterval(runTimerId);
  runTimerId = null;
  setRuntimeDisplay({
    startedAt: runStartedAtMs,
    completedAt,
    durationMs: runStartedAtMs ? completedAt - runStartedAtMs : 0,
  });
}

function adapterText(kind) {
  return {
    openclaw: "OpenClaw Adapter",
    http_sample: "HTTP Sample Agent",
    api: "HTTP Agent Endpoint",
    mock: "Mock Agent",
  }[kind] || kind || "未选择";
}

function artifactLink(pathValue, label = pathValue) {
  if (!pathValue) return "";
  return `<a href="/${esc(pathValue)}" target="_blank" rel="noreferrer">${esc(label)}</a>`;
}

function enabledScenarios() {
  return bootstrap?.redTeamScenarios?.scenarios || [];
}

function enabledCases() {
  return bootstrap?.testCases?.filter((item) => item.enabled) || [];
}

function scenarioById(scenarioId) {
  return enabledScenarios().find((scenario) => scenario.scenarioId === scenarioId);
}

function caseById(caseId) {
  return bootstrap?.testCases.find((item) => item.caseId === caseId);
}

function selectedScenarios() {
  return selectedScenarioIds.map(scenarioById).filter(Boolean);
}

function selectedCaseIds() {
  return [
    ...new Set(
      selectedScenarios()
        .flatMap((scenario) => scenario.caseIds || [])
        .filter((caseId) => caseById(caseId)?.enabled),
    ),
  ];
}

function holdoutCaseIds() {
  const selected = new Set(selectedCaseIds());
  const remaining = enabledCases().map((item) => item.caseId).filter((caseId) => !selected.has(caseId));
  return remaining.length ? remaining : enabledCases().slice(-2).map((item) => item.caseId);
}

function highestRisk(payloads) {
  return payloads
    .map((payload) => payload.risk?.riskLevel || payload.report?.riskLevel || "none")
    .sort((a, b) => riskRank[b] - riskRank[a])[0] || "none";
}

function aggregatePayloads(payloads) {
  const findings = payloads.flatMap((payload) => payload.report?.findings || []);
  const policies = payloads.flatMap((payload) => payload.policyPack?.policies || []);
  const records = payloads.flatMap((payload) => payload.supervisionRecords || []);
  const blocked = records.filter((record) => record.decision === "blocked");
  const alerts = records.filter((record) => record.decision !== "blocked");
  const residual = payloads.reduce((total, payload) => total + (payload.defenseReport?.summary?.residualRiskCount || 0), 0);
  return {
    caseCount: payloads.length,
    eventCount: payloads.reduce((total, payload) => total + (payload.monitor?.totalEvents || 0), 0),
    toolCallCount: payloads.reduce((total, payload) => total + (payload.monitor?.counts?.tool_call || 0), 0),
    errorCount: payloads.reduce(
      (total, payload) => total + (payload.trace?.events || []).filter((event) => event.eventType === "system_error").length,
      0,
    ),
    findingCount: findings.length,
    riskScore: Math.min(100, payloads.reduce((total, payload) => total + (payload.risk?.riskScore || 0), 0)),
    highestRisk: highestRisk(payloads),
    weaknessCount: new Set(payloads.flatMap((payload) => payload.riskProfile?.weaknesses?.map((item) => item.category) || [])).size,
    policyCount: new Set(policies.map((policy) => policy.name || policy.policyId)).size || policyGroups.length,
    recordCount: records.length,
    blockedCount: blocked.length,
    alertCount: alerts.length,
    residualCount: residual,
    findings,
    policies,
    records,
  };
}

function verificationModeText() {
  return {
    block_high_risk: "阻断模式",
    observe_only: "观察模式",
    ask_confirm: "询问模式",
  }[els.verificationMode.value] || "阻断模式";
}

function showModule(module) {
  currentModule = module;
  els.moduleViews.forEach((view) => view.classList.toggle("active", view.id === `module-${module}`));
  els.moduleTriggers.forEach((trigger) => {
    trigger.classList.toggle("active", trigger.dataset.moduleTarget === module);
  });

  if (module === "workbench") showStep(currentStep);
  if (module === "detection") renderDetectionDashboard();
  if (module === "supervision") renderSupervisionDashboard();
  if (module === "reports") renderReportDashboard();
  if (module === "external") renderExternalDashboard();
}

function enterConsole(module = "overview") {
  els.landingPage.classList.add("hidden");
  els.consoleApp.classList.remove("hidden");
  showModule(module);
  window.scrollTo({ top: 0, behavior: "auto" });
}

function isDone(step) {
  if (step === 0) return Boolean(els.agentName.value && els.agentId.value);
  if (step === 1) return selectedScenarioIds.length >= 3;
  if (step === 2) return runPayloads.length > 0;
  if (step === 3) return policyBuilt;
  if (step === 4) return validationDone;
  if (step === 5) return holdoutDone;
  if (step === 6) return reportBuilt;
  return false;
}

function showStep(step) {
  currentStep = step;
  document.querySelectorAll(".step-panel").forEach((panel, index) => panel.classList.toggle("active", index === step));
  [...els.stepList.children].forEach((item, index) => {
    item.classList.toggle("active", index === step);
    item.classList.toggle("done", isDone(index));
  });
  els.stepTitle.textContent = stepMeta[step][0];
  els.stepIntro.textContent = stepMeta[step][1];
  els.stepIntro.hidden = !stepMeta[step][1];
  els.flowStatus.textContent = stepMeta[step][2];
}

function currentAgent() {
  const adapterKind = els.adapterType.value;
  return {
    agentId: els.agentId.value.trim() || "agent.openclaw.demo",
    name: els.agentName.value.trim() || "OpenClaw Demo Agent",
    adapterKind,
    adapterType: adapterKind,
    workspace: els.openClawWorkspace.value.trim(),
    endpoint: els.agentEndpoint.value.trim(),
    timeoutMs: Number(els.timeoutMs.value || 8000),
  };
}

function requestBodyForCase(caseId, supervisionOptions) {
  const testCase = caseById(caseId);
  return {
    caseId,
    mode: els.modeSelect.value,
    customInstruction: testCase?.task?.instruction || "",
    agent: currentAgent(),
    selectedToolIds: testCase?.toolIds || [],
    selectedResourceIds: testCase?.resourceIds || [],
    selectedRuleIds: bootstrap.riskRules.map((rule) => rule.ruleId),
    supervisionOptions,
  };
}

async function runCase(caseId, supervisionOptions) {
  const response = await fetch("/api/run-demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBodyForCase(caseId, supervisionOptions)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function runCaseSet(caseIds, supervisionOptions) {
  const results = [];
  for (const caseId of caseIds) {
    results.push(await runCase(caseId, supervisionOptions));
  }
  return results;
}

async function startSampleAgentFromWorkbench() {
  els.useSampleApiButton.disabled = true;
  els.useSampleApiButton.textContent = "正在启动 HTTP 兜底 Agent...";
  try {
    const response = await fetch(bootstrap.httpAgentContract.sampleStartEndpoint || "/api/sample-agent/start", {
      method: "POST",
    });
    const status = await response.json();
    if (!response.ok || !status.running) {
      throw new Error(status.message || "HTTP 兜底 Agent 启动失败");
    }
    els.adapterType.value = "http_sample";
    els.agentEndpoint.value = status.endpoint || bootstrap.httpAgentContract.sampleEndpoint;
    els.agentName.value = "Local HTTP Sample Agent";
    els.agentId.value = "agent.sample_http";
    renderAgentPreview();
    els.flowStatus.textContent = status.startedByWorkbench ? "HTTP 兜底 Agent 已启动" : "HTTP 兜底 Agent 已连接";
  } catch (error) {
    els.agentPreview.innerHTML = `<p><b>启动失败：</b>${esc(error.message)}</p><p>可以手动运行 npm run demo:sample-agent 后再点击按钮。</p>`;
  } finally {
    els.useSampleApiButton.disabled = false;
    els.useSampleApiButton.textContent = "启动 HTTP 兜底 Agent";
  }
}

function renderAgentPreview() {
  const agent = currentAgent();
  const dryRunNote =
    agent.adapterKind === "openclaw" && !agent.endpoint
      ? "未配置实时 endpoint，将使用 OpenClaw adapter dry-run + 本地沙箱演示。"
      : "将通过配置的 adapter endpoint 发送 TestContext。";
  els.agentPreview.innerHTML = `
    <p><b>agentId：</b>${esc(agent.agentId)}</p>
    <p><b>name：</b>${esc(agent.name)}</p>
    <p><b>adapterKind：</b>${esc(adapterText(agent.adapterKind))}</p>
    <p><b>workspace：</b>${esc(agent.workspace || "未填写")}</p>
    <p><b>endpoint：</b>${esc(agent.endpoint || "未填写")}</p>
    <p><b>timeoutMs：</b>${esc(agent.timeoutMs)}</p>
    <p><b>demo path：</b>${esc(dryRunNote)}</p>
  `;
}

function renderScenarioBoard() {
  const scenarios = enabledScenarios();
  if (!selectedScenarioIds.length) {
    selectedScenarioIds = scenarios.slice(0, 3).map((scenario) => scenario.scenarioId);
  }

  els.scenarioBoard.innerHTML = scenarios
    .map((scenario) => {
      const checked = selectedScenarioIds.includes(scenario.scenarioId) ? "checked" : "";
      const attackType = attackTypeLabels[scenario.attackType] || scenario.attackType;
      return `
        <label class="scenario-card">
          <input type="checkbox" value="${esc(scenario.scenarioId)}" ${checked} />
          <span>
            <strong>${esc(attackType)} · ${esc(scenario.name)}</strong>
            <small>对抗样本：${esc((scenario.sampleIds || []).join("、"))}</small>
            <small>越狱测试用例：${esc((scenario.caseIds || []).join("、"))}</small>
            <small>攻击脚本：${esc(attackScripts[scenario.attackType] || "scripts/attacks/custom_red_team.ts")}</small>
            <small>预期风险：${esc((scenario.expectedWeaknessCategories || []).join("、"))}</small>
          </span>
        </label>
      `;
    })
    .join("");
  renderContextPreview();
}

function syncSelectedScenarios() {
  selectedScenarioIds = [...els.scenarioBoard.querySelectorAll("input:checked")].map((input) => input.value);
  renderContextPreview();
}

function renderContextPreview() {
  const scenarios = selectedScenarios();
  const caseIds = selectedCaseIds();
  const attackTypes = new Set(scenarios.map((scenario) => scenario.attackType));
  els.contextPreview.innerHTML = `
    <p><b>攻击类别：</b>${attackTypes.size} 类</p>
    <p><b>红队场景：</b>${scenarios.length} 个</p>
    <p><b>测试用例：</b>${caseIds.length} 个</p>
    <p><b>样本要求：</b>对抗样本 / 越狱测试用例 / 攻击脚本</p>
    <p><b>状态：</b>${scenarios.length >= 3 ? "满足 3 类以上演示要求" : "至少选择 3 个攻击场景"}</p>
  `;
  els.finishEnvButton.disabled = scenarios.length < 3;
  els.runInput.innerHTML = `
    <p><b>Agent：</b>${esc(currentAgent().name)} (${esc(adapterText(currentAgent().adapterKind))})</p>
    <p><b>攻击场景：</b>${esc(scenarios.map((scenario) => attackTypeLabels[scenario.attackType] || scenario.attackType).join("、"))}</p>
    <p><b>运行模式：</b>监督前仅观察，不做阻断</p>
  `;
}

function renderFileStrip() {
  const files = [
    ["red_team_scenarios.json", "红队场景集", enabledScenarios().length],
    ["test_cases.json", "测试用例集合", bootstrap.testCases.length],
    ["tools.json", "工具定义与风险标签", bootstrap.tools.length],
    ["resources.json", "资源与敏感标签", bootstrap.resources.length],
    ["risk_rules.json", "风险判定规则", bootstrap.riskRules.length],
    ["test_oracles.json", "离线验收 oracle", bootstrap.testOracles.length],
  ];
  els.fileStrip.innerHTML = files
    .map(([file, desc, count]) => `<div class="file-chip"><strong>${file}</strong><span>${desc} · ${count} 条</span></div>`)
    .join("");
}

function renderOverview() {
  if (!bootstrap) return;
  els.kpiCases.textContent = String(bootstrap.testCases.length);
  els.kpiTools.textContent = String(bootstrap.tools.length);
  els.kpiResources.textContent = String(bootstrap.resources.length);
  els.kpiRules.textContent = String(bootstrap.riskRules.length);
  els.overviewStatus.textContent = "P2 Demo 已就绪";
  els.overviewStatusDetail.textContent = "红队场景、OpenClaw 主入口、策略监督和防御报告演示已加载。";
}

function renderConfigBoard() {
  if (!bootstrap) return;
  const groups = [
    ["Red Team Scenarios", enabledScenarios(), "scenarioId", (item) => `${attackTypeLabels[item.attackType] || item.attackType} · cases=${item.caseIds.length}`],
    ["Tools", bootstrap.tools, "toolId", (item) => `${item.name} · ${item.riskLevel} · ${item.sideEffect}`],
    ["Resources", bootstrap.resources, "resourceId", (item) => `${item.path || item.resourceId} · ${item.sensitivity} · injection=${item.containsInjection}`],
    ["Risk Rules", bootstrap.riskRules, "ruleId", (item) => `${item.category} · ${item.riskLevel}`],
    ["Test Cases", bootstrap.testCases, "caseId", (item) => `${item.attackEntryType} · ${item.enabled ? "enabled" : "disabled"}`],
  ];

  els.configBoard.innerHTML = groups
    .map(
      ([title, items, idKey, detailFn]) => `
        <article class="config-section">
          <div class="config-section-header">
            <h3>${esc(title)}</h3>
            <span>${items.length}</span>
          </div>
          <div class="config-list">
            ${items
              .map(
                (item) => `
                  <div class="config-row">
                    <strong>${esc(item[idKey])}</strong>
                    <small>${esc(detailFn(item))}</small>
                  </div>
                `,
              )
              .join("")}
          </div>
        </article>
      `,
    )
    .join("");
}

function renderFindings(findings) {
  if (!findings.length) {
    els.findingList.innerHTML = `<div class="empty-state">监督前检测未发现高风险行为。</div>`;
    return;
  }
  els.findingList.innerHTML = findings
    .slice(0, 8)
    .map(
      (finding) => `
        <article class="finding-card">
          <strong>${esc(finding.name || finding.title)} · ${esc(riskText(finding.riskLevel))}</strong>
          <p>${esc(finding.description)}</p>
          <p>分类：${esc(finding.category)}；规则：${esc(finding.ruleId || "n/a")}</p>
        </article>
      `,
    )
    .join("");
}

function renderRiskProfile() {
  const summary = aggregatePayloads(runPayloads);
  els.runEvents.textContent = String(summary.eventCount);
  els.runToolCalls.textContent = String(summary.toolCallCount);
  els.runErrors.textContent = String(summary.errorCount);
  els.riskBadge.textContent = riskText(summary.highestRisk);
  els.riskBadge.dataset.risk = summary.highestRisk;
  els.riskScore.textContent = String(summary.riskScore);
  els.findingCount.textContent = String(summary.findingCount);
  els.weaknessCount.textContent = String(summary.weaknessCount);
  els.policyCount.textContent = "0";
  els.runSummary.innerHTML = `
    <p><b>RiskReport：</b>${runPayloads.length} 份</p>
    <p><b>DetectionReport：</b>${runPayloads.map((payload) => payload.detectionReport.reportId).join("、")}</p>
    <p><b>AgentRiskProfile：</b>${summary.weaknessCount} 类弱点</p>
  `;
  renderFindings(summary.findings);
  els.toPolicyButton.disabled = false;
  els.overviewLastRun.innerHTML = `
    <p><b>监督前风险：</b>${summary.findingCount}</p>
    <p><b>攻击场景：</b>${selectedScenarios().length}；<b>测试用例：</b>${runPayloads.length}</p>
    <p><b>当前状态：</b>已生成风险画像，等待策略包生成。</p>
  `;
}

function renderPolicyGroups() {
  const summary = aggregatePayloads(runPayloads);
  els.policyCount.textContent = String(policyGroups.length);
  els.riskInput.innerHTML = `
    <p><b>策略来源：</b>${runPayloads.length} 份 RiskReport 与 ${summary.weaknessCount} 类弱点画像</p>
    <p><b>SupervisionPolicyPack：</b>按输入输出过滤、上下文隔离、工具阻断、敏感资源和出站审计聚合展示</p>
  `;
  els.policyGroupGrid.innerHTML = policyGroups
    .map(
      (group) => `
        <article class="policy-group-card">
          <strong>${esc(group.title)}</strong>
          <p>${esc(group.detail)}</p>
          <small>${esc(group.action)} · ${esc(group.target)}</small>
        </article>
      `,
    )
    .join("");
  els.policyList.innerHTML = policyGroups
    .map(
      (group) => `
        <article class="finding-card policy-card">
          <strong>${esc(group.title)}</strong>
          <p>${esc(group.detail)}</p>
          <p>作用对象：${esc(group.target)}；动作：${esc(group.action)}</p>
        </article>
      `,
    )
    .join("");
  els.validationInput.innerHTML = `
    <p><b>策略组：</b>${policyGroups.length} 组</p>
    <p><b>待验证场景：</b>${selectedCaseIds().length} 个测试用例</p>
    <p><b>当前模式：</b>${esc(verificationModeText())}</p>
  `;
  els.buildRiskButton.disabled = false;
  els.runValidationButton.disabled = false;
}

function renderSupervisionRecords(records = []) {
  if (!records.length) {
    els.supervisionList.innerHTML = `<div class="empty-state">还没有监督验证记录。</div>`;
    return;
  }
  els.supervisionList.innerHTML = records
    .slice(0, 8)
    .map(
      (record) => `
        <article class="finding-card supervision-card">
          <strong>${esc(record.action)} · ${esc(record.decision)} · ${esc(record.targetType)}</strong>
          <p>${esc(record.reason)}</p>
          <p>policyId：${esc(record.policyId || "n/a")}</p>
        </article>
      `,
    )
    .join("");
}

function renderValidationResults() {
  const summary = aggregatePayloads(validationPayloads);
  els.validationHitCount.textContent = String(summary.recordCount);
  els.validationBlockedCount.textContent = String(summary.blockedCount);
  els.validationAlertCount.textContent = String(summary.alertCount);
  renderSupervisionRecords(summary.records);
  els.toHoldoutButton.disabled = false;
  els.runHoldoutButton.disabled = false;
  renderSupervisionDashboard();
}

function renderHoldoutResults() {
  const summary = aggregatePayloads(holdoutPayloads);
  const hitCases = holdoutPayloads.filter((payload) => (payload.supervisionRecords || []).length > 0).length;
  const rate = holdoutPayloads.length ? Math.round((hitCases / holdoutPayloads.length) * 100) : 0;
  els.holdoutCaseCount.textContent = String(holdoutPayloads.length);
  els.holdoutHitRate.textContent = `${rate}%`;
  els.holdoutResidualCount.textContent = String(summary.residualCount);
  els.externalPreview.innerHTML = `
    <p><b>留出样本：</b>${holdoutCaseIds().join("、")}</p>
    <p><b>验证问题：</b>策略包能不能发现未参与策略生成的新风险？</p>
    <p><b>命中率：</b>${rate}%</p>
  `;
  els.holdoutList.innerHTML = holdoutPayloads
    .map((payload) => {
      const recordCount = (payload.supervisionRecords || []).length;
      return `
        <article class="finding-card">
          <strong>${esc(payload.context.caseName)} · ${recordCount ? "命中" : "未命中"}</strong>
          <p>监督记录：${recordCount}；风险发现：${payload.risk.findingCount}</p>
        </article>
      `;
    })
    .join("");
  els.buildReportButton.disabled = false;
  renderExternalDashboard();
}

function latestArtifact() {
  return validationPayloads[0]?.artifacts || runPayloads[0]?.artifacts || {};
}

function renderDefenseReport() {
  const pre = aggregatePayloads(runPayloads);
  const validation = aggregatePayloads(validationPayloads);
  const holdout = aggregatePayloads(holdoutPayloads);
  const hitCases = holdoutPayloads.filter((payload) => (payload.supervisionRecords || []).length > 0).length;
  const holdoutRate = holdoutPayloads.length ? Math.round((hitCases / holdoutPayloads.length) * 100) : 0;
  const artifacts = latestArtifact();

  els.preRiskCount.textContent = String(pre.findingCount);
  els.policyHitCount.textContent = String(validation.recordCount);
  els.chainCount.textContent = String(validation.blockedCount);
  els.evidenceCount.textContent = String(validation.alertCount);
  els.finalHoldoutRate.textContent = `${holdoutRate}%`;
  els.reportRisk.textContent = String(holdout.residualCount || validation.residualCount);
  els.artifactText.innerHTML = `
    <p><b>RiskReport JSON：</b>${artifactLink(artifacts.reportPath)}</p>
    <p><b>DetectionReport JSON：</b>${artifactLink(artifacts.detectionPath)}</p>
    <p><b>RiskProfile JSON：</b>${artifactLink(artifacts.riskProfilePath)}</p>
    <p><b>PolicyPack JSON：</b>${artifactLink(artifacts.policyPackPath)}</p>
    <p><b>SupervisionRecords JSON：</b>${artifactLink(artifacts.supervisionPath)}</p>
    <p><b>DefenseReport HTML：</b>${artifactLink(artifacts.defenseHtmlPath)}</p>
  `;
  els.evidenceList.innerHTML = `
    <article class="finding-card">
      <strong>证据链摘要</strong>
      <p>监督前风险 ${pre.findingCount} 个，策略命中 ${validation.recordCount} 次，阻断 ${validation.blockedCount} 次，告警 ${validation.alertCount} 次。</p>
      <p>未知风险复测命中率 ${holdoutRate}%，残余风险 ${holdout.residualCount || validation.residualCount} 个。</p>
    </article>
  `;
  if (artifacts.defenseHtmlPath) {
    els.defenseHtmlButton.href = `/${artifacts.defenseHtmlPath}`;
    els.defenseHtmlButton.setAttribute("aria-disabled", "false");
    els.defenseHtmlButton.classList.remove("disabled");
  }
  els.overviewLastRun.innerHTML = `
    <p><b>防御报告：</b>已生成</p>
    <p><b>监督前风险：</b>${pre.findingCount}；<b>策略命中：</b>${validation.recordCount}</p>
    <p><b>未知复测命中率：</b>${holdoutRate}%</p>
  `;
  renderReportDashboard();
}

function renderDetectionDashboard() {
  if (!runPayloads.length) {
    els.detectionDashboard.innerHTML = `<div class="empty-state">暂无检测结果。运行监督前检测后会显示风险画像。</div>`;
    return;
  }
  const summary = aggregatePayloads(runPayloads);
  els.detectionDashboard.innerHTML = `
    <div class="report-grid">
      <article class="kpi-tile"><span>${esc(riskText(summary.highestRisk))}</span><p>最高风险</p></article>
      <article class="kpi-tile"><span>${summary.findingCount}</span><p>风险发现</p></article>
      <article class="kpi-tile"><span>${summary.weaknessCount}</span><p>弱点画像</p></article>
      <article class="kpi-tile"><span>${runPayloads.length}</span><p>测试用例</p></article>
    </div>
  `;
}

function renderSupervisionDashboard() {
  if (!validationDone) {
    els.supervisionDashboard.innerHTML = `<div class="empty-state">暂无监督验证结果。</div>`;
    return;
  }
  const summary = aggregatePayloads(validationPayloads);
  els.supervisionDashboard.innerHTML = `
    <div class="report-grid">
      <article class="kpi-tile"><span>${summary.recordCount}</span><p>策略命中</p></article>
      <article class="kpi-tile"><span>${summary.blockedCount}</span><p>阻断</p></article>
      <article class="kpi-tile"><span>${summary.alertCount}</span><p>告警/询问</p></article>
    </div>
  `;
}

function renderExternalDashboard() {
  if (!holdoutDone) {
    els.externalDashboard.innerHTML = `<div class="empty-state">暂无未知风险复测结果。</div>`;
    return;
  }
  const hitCases = holdoutPayloads.filter((payload) => (payload.supervisionRecords || []).length > 0).length;
  const rate = holdoutPayloads.length ? Math.round((hitCases / holdoutPayloads.length) * 100) : 0;
  els.externalDashboard.innerHTML = `
    <div class="report-grid">
      <article class="kpi-tile"><span>${holdoutPayloads.length}</span><p>留出样本</p></article>
      <article class="kpi-tile"><span>${rate}%</span><p>命中率</p></article>
      <article class="kpi-tile"><span>${hitCases}</span><p>命中样本</p></article>
    </div>
  `;
}

function renderReportDashboard() {
  if (!reportBuilt) {
    els.reportDashboard.innerHTML = `<div class="empty-state">暂无防御报告。</div>`;
    return;
  }
  const pre = aggregatePayloads(runPayloads);
  const validation = aggregatePayloads(validationPayloads);
  els.reportDashboard.innerHTML = `
    <div class="report-grid">
      <article class="kpi-tile"><span>${pre.findingCount}</span><p>监督前风险</p></article>
      <article class="kpi-tile"><span>${validation.recordCount}</span><p>策略命中</p></article>
      <article class="kpi-tile"><span>${validation.blockedCount}</span><p>阻断</p></article>
    </div>
  `;
}

function resetDownstream(fromStep) {
  if (fromStep <= 2) {
    policyBuilt = false;
    validationDone = false;
    holdoutDone = false;
    reportBuilt = false;
    validationPayloads = [];
    holdoutPayloads = [];
    els.policyList.innerHTML = "";
    els.supervisionList.innerHTML = "";
    els.holdoutList.innerHTML = "";
    els.evidenceList.innerHTML = "";
    els.buildRiskButton.disabled = true;
    els.runValidationButton.disabled = true;
    els.toHoldoutButton.disabled = true;
    els.runHoldoutButton.disabled = true;
    els.buildReportButton.disabled = true;
  }
}

async function runPreDetection() {
  const caseIds = selectedCaseIds();
  if (!caseIds.length) return;
  els.finishEnvButton.disabled = true;
  els.runButton.disabled = true;
  els.flowStatus.textContent = "监督前检测运行中";
  showStep(2);
  startRunTimer();
  try {
    runPayloads = await runCaseSet(caseIds, {
      runtimeSupervisionEnabled: false,
      unknownRiskHoldoutEnabled: false,
      enforcementMode: "observe_only",
    });
    stopRunTimer();
    resetDownstream(2);
    renderRiskProfile();
    renderDetectionDashboard();
    showStep(2);
  } catch (error) {
    stopRunTimer();
    els.runSummary.innerHTML = `<p>运行失败：${esc(error.message)}</p>`;
  } finally {
    els.finishEnvButton.disabled = false;
    els.runButton.disabled = false;
    els.flowStatus.textContent = "风险画像已生成";
  }
}

function buildPolicyPackStage() {
  if (!runPayloads.length) return;
  policyBuilt = true;
  renderPolicyGroups();
  showStep(3);
}

function enterValidationStage() {
  if (!policyBuilt) return;
  els.validationInput.innerHTML = `
    <p><b>验证模式：</b>${esc(verificationModeText())}</p>
    <p><b>验证用例：</b>${selectedCaseIds().length} 个</p>
    <p><b>策略组：</b>${policyGroups.length} 组</p>
  `;
  els.runValidationButton.disabled = false;
  showStep(4);
}

async function runValidation() {
  if (!policyBuilt) return;
  els.runValidationButton.disabled = true;
  els.flowStatus.textContent = "监督验证运行中";
  try {
    validationPayloads = await runCaseSet(selectedCaseIds(), {
      runtimeSupervisionEnabled: true,
      unknownRiskHoldoutEnabled: false,
      enforcementMode: els.verificationMode.value,
    });
    validationDone = true;
    renderValidationResults();
    els.flowStatus.textContent = "监督验证完成";
    showStep(4);
  } catch (error) {
    els.validationInput.innerHTML = `<p>监督验证失败：${esc(error.message)}</p>`;
  } finally {
    els.runValidationButton.disabled = false;
  }
}

function enterHoldoutStage() {
  if (!validationDone) return;
  els.externalPreview.innerHTML = `
    <p><b>留出样本：</b>${holdoutCaseIds().join("、")}</p>
    <p><b>目标：</b>验证策略包能否发现没有参与策略生成的新风险。</p>
  `;
  els.runHoldoutButton.disabled = false;
  showStep(5);
}

async function runHoldout() {
  if (!validationDone) return;
  els.runHoldoutButton.disabled = true;
  els.flowStatus.textContent = "未知风险复测运行中";
  try {
    holdoutPayloads = await runCaseSet(holdoutCaseIds(), {
      runtimeSupervisionEnabled: true,
      unknownRiskHoldoutEnabled: true,
      enforcementMode: els.verificationMode.value,
    });
    holdoutDone = true;
    renderHoldoutResults();
    els.flowStatus.textContent = "未知风险复测完成";
    showStep(5);
  } catch (error) {
    els.externalPreview.innerHTML = `<p>未知风险复测失败：${esc(error.message)}</p>`;
  } finally {
    els.runHoldoutButton.disabled = false;
  }
}

function buildFinalReport() {
  if (!holdoutDone) return;
  reportBuilt = true;
  renderDefenseReport();
  showStep(6);
}

function bindEvents() {
  els.enterConsoleButtons.forEach((button) => {
    button.addEventListener("click", () => enterConsole(button.dataset.enterConsole || "overview"));
  });
  els.moduleTriggers.forEach((trigger) => {
    trigger.addEventListener("click", () => showModule(trigger.dataset.moduleTarget));
  });
  els.useSampleApiButton.addEventListener("click", startSampleAgentFromWorkbench);
  els.finishAgentButton.addEventListener("click", () => {
    renderAgentPreview();
    showStep(1);
  });
  els.scenarioBoard.addEventListener("change", syncSelectedScenarios);
  els.modeSelect.addEventListener("change", renderContextPreview);
  els.finishEnvButton.addEventListener("click", runPreDetection);
  els.runButton.addEventListener("click", runPreDetection);
  els.toPolicyButton.addEventListener("click", buildPolicyPackStage);
  els.buildRiskButton.addEventListener("click", enterValidationStage);
  els.verificationMode.addEventListener("change", () => {
    els.validationInput.innerHTML = `
      <p><b>验证模式：</b>${esc(verificationModeText())}</p>
      <p><b>阻断模式：</b>真实阻断高危行为；观察模式只告警；询问模式需要确认。</p>
    `;
  });
  els.runValidationButton.addEventListener("click", runValidation);
  els.toHoldoutButton.addEventListener("click", enterHoldoutStage);
  els.runHoldoutButton.addEventListener("click", runHoldout);
  els.buildReportButton.addEventListener("click", buildFinalReport);
  [...els.stepList.children].forEach((item) => {
    item.addEventListener("click", () => {
      const step = Number(item.dataset.step);
      if (step === 0 || isDone(step - 1)) showStep(step);
    });
  });
  ["input", "change"].forEach((eventName) => {
    [els.agentName, els.agentId, els.adapterType, els.openClawWorkspace, els.agentEndpoint, els.timeoutMs].forEach((el) => {
      el.addEventListener(eventName, renderAgentPreview);
    });
  });
}

async function init() {
  try {
    const response = await fetch("/api/bootstrap");
    bootstrap = await response.json();
    renderAgentPreview();
    renderOverview();
    renderConfigBoard();
    renderScenarioBoard();
    renderFileStrip();
    renderDetectionDashboard();
    renderSupervisionDashboard();
    renderReportDashboard();
    renderExternalDashboard();
    bindEvents();
    showStep(0);
    showModule("overview");
    els.consoleApp.classList.add("hidden");
    els.landingPage.classList.remove("hidden");
  } catch (error) {
    els.overviewStatus.textContent = "配置加载失败";
    els.overviewStatusDetail.textContent = error instanceof Error ? error.message : String(error);
  }
}

init();
