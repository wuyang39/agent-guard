let bootstrap = null;
let currentStep = 0;
let currentModule = "overview";
let runPayload = null;
let riskBuilt = false;
let reportBuilt = false;

const stepMeta = [
  ["0. Agent 接入", "", "等待接入 Agent"],
  ["1. 测试环境建模", "", "等待环境建模"],
  ["2. 动态交互执行", "", "等待动态执行"],
  ["3. 交互监控", "", "等待确认 Trace"],
  ["4. 风险判定与证据链", "", "等待风险判定"],
  ["5. 报告输出", "", "等待报告输出"],
];

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
  traceMirrorList: $("#traceMirrorList"),
  reportDashboard: $("#reportDashboard"),
  stepList: $("#stepList"),
  stepTitle: $("#stepTitle"),
  stepIntro: $("#stepIntro"),
  flowStatus: $("#flowStatus"),
  agentName: $("#agentName"),
  agentId: $("#agentId"),
  adapterType: $("#adapterType"),
  agentEndpoint: $("#agentEndpoint"),
  timeoutMs: $("#timeoutMs"),
  agentPreview: $("#agentPreview"),
  useSampleApiButton: $("#useSampleApiButton"),
  finishAgentButton: $("#finishAgentButton"),
  caseSelect: $("#caseSelect"),
  modeSelect: $("#modeSelect"),
  customInstruction: $("#customInstruction"),
  toolPicker: $("#toolPicker"),
  resourcePicker: $("#resourcePicker"),
  rulePicker: $("#rulePicker"),
  contextPreview: $("#contextPreview"),
  fileStrip: $("#fileStrip"),
  finishEnvButton: $("#finishEnvButton"),
  runInput: $("#runInput"),
  runButton: $("#runButton"),
  runEvents: $("#runEvents"),
  runToolCalls: $("#runToolCalls"),
  runErrors: $("#runErrors"),
  runSummary: $("#runSummary"),
  finishMonitorButton: $("#finishMonitorButton"),
  traceList: $("#traceList"),
  riskInput: $("#riskInput"),
  buildRiskButton: $("#buildRiskButton"),
  riskBadge: $("#riskBadge"),
  riskScore: $("#riskScore"),
  findingCount: $("#findingCount"),
  findingList: $("#findingList"),
  nextReportButton: $("#nextReportButton"),
  reportInput: $("#reportInput"),
  buildReportButton: $("#buildReportButton"),
  chainCount: $("#chainCount"),
  evidenceCount: $("#evidenceCount"),
  reportRisk: $("#reportRisk"),
  artifactText: $("#artifactText"),
  pdfReportButton: $("#pdfReportButton"),
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

function showModule(module) {
  currentModule = module;
  els.moduleViews.forEach((view) => view.classList.toggle("active", view.id === `module-${module}`));
  els.moduleTriggers.forEach((trigger) => {
    trigger.classList.toggle("active", trigger.dataset.moduleTarget === module);
  });

  if (module === "trace") renderTraceMirror();
  if (module === "reports") renderReportDashboard();
}

function enterConsole(module = "overview") {
  els.landingPage.classList.add("hidden");
  els.consoleApp.classList.remove("hidden");
  showModule(module);
  if (module === "workbench") {
    showStep(currentStep);
  }
  window.scrollTo({ top: 0, behavior: "auto" });
}

function isDone(step) {
  if (step === 0) return Boolean(els.agentName.value && els.agentId.value);
  if (step === 1) return Boolean(getCase());
  if (step === 2) return Boolean(runPayload);
  if (step === 3) return Boolean(runPayload);
  if (step === 4) return riskBuilt;
  if (step === 5) return reportBuilt;
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

function getCase() {
  return bootstrap?.testCases.find((item) => item.caseId === els.caseSelect.value);
}

function selectedValues(container) {
  return [...container.querySelectorAll("input:checked")].map((input) => input.value);
}

function currentAgent() {
  return {
    agentId: els.agentId.value.trim() || "agent.demo",
    name: els.agentName.value.trim() || "Demo Agent",
    adapterType: els.adapterType.value,
    endpoint: els.agentEndpoint.value.trim(),
    timeoutMs: Number(els.timeoutMs.value || 8000),
  };
}

function requestBody() {
  return {
    caseId: els.caseSelect.value,
    mode: els.modeSelect.value,
    customInstruction: els.customInstruction.value,
    agent: currentAgent(),
    selectedToolIds: selectedValues(els.toolPicker),
    selectedResourceIds: selectedValues(els.resourcePicker),
    selectedRuleIds: selectedValues(els.rulePicker),
  };
}

async function startSampleAgentFromWorkbench() {
  els.useSampleApiButton.disabled = true;
  els.useSampleApiButton.textContent = "正在启动示例 Agent...";
  try {
    const response = await fetch(bootstrap.httpAgentContract.sampleStartEndpoint || "/api/sample-agent/start", {
      method: "POST",
    });
    const status = await response.json();
    if (!response.ok || !status.running) {
      throw new Error(status.message || "示例 Agent 启动失败");
    }
    els.adapterType.value = "api";
    els.agentEndpoint.value = status.endpoint || bootstrap.httpAgentContract.sampleEndpoint;
    els.agentName.value = "Sample HTTP Agent";
    els.agentId.value = "agent.sample_http";
    renderAgentPreview();
    els.flowStatus.textContent = status.startedByWorkbench ? "示例 Agent 已启动" : "示例 Agent 已连接";
  } catch (error) {
    els.agentPreview.innerHTML = `<p><b>启动失败：</b>${esc(error.message)}</p><p>可以手动运行 npm run sample-agent 后再点击按钮。</p>`;
  } finally {
    els.useSampleApiButton.disabled = false;
    els.useSampleApiButton.textContent = "一键启动并使用示例 HTTP Agent";
  }
}

function renderAgentPreview() {
  const agent = currentAgent();
  els.agentPreview.innerHTML = `
    <p><b>agentId：</b>${esc(agent.agentId)}</p>
    <p><b>name：</b>${esc(agent.name)}</p>
    <p><b>adapterType：</b>${esc(agent.adapterType)}</p>
    <p><b>endpoint：</b>${esc(agent.endpoint || "未填写，mock 模式不需要")}</p>
    <p><b>timeoutMs：</b>${esc(agent.timeoutMs)}</p>
  `;
}

function renderCheckRows(container, items, idKey, titleKey, detailFn, selectedIds = []) {
  container.innerHTML = items
    .map((item) => {
      const checked = selectedIds.includes(item[idKey]) ? "checked" : "";
      return `
        <label class="check-row">
          <input type="checkbox" value="${esc(item[idKey])}" ${checked} />
          <span><strong>${esc(item[titleKey] || item[idKey])}</strong><small>${esc(detailFn(item))}</small></span>
        </label>
      `;
    })
    .join("");
}

function renderEnvironmentInputs() {
  const testCase = getCase();
  if (!testCase) return;
  els.customInstruction.value = testCase.task.instruction;
  renderCheckRows(
    els.toolPicker,
    bootstrap.tools,
    "toolId",
    "name",
    (tool) => `${tool.toolId} · ${tool.riskLevel} · ${tool.description}`,
    testCase.toolIds,
  );
  renderCheckRows(
    els.resourcePicker,
    bootstrap.resources,
    "resourceId",
    "name",
    (resource) => `${resource.path || resource.resourceId} · ${resource.sensitivity} · injection=${resource.containsInjection}`,
    testCase.resourceIds,
  );
  renderCheckRows(
    els.rulePicker,
    bootstrap.riskRules,
    "ruleId",
    "name",
    (rule) => `${rule.category} · ${rule.riskLevel} · ${rule.description}`,
    bootstrap.riskRules.map((rule) => rule.ruleId),
  );
  renderContextPreview();
}

function renderContextPreview() {
  const testCase = getCase();
  if (!testCase) return;
  els.contextPreview.innerHTML = `
    <p><b>caseId：</b>${esc(testCase.caseId)}</p>
    <p><b>attackEntryType：</b>${esc(testCase.attackEntryType)}</p>
    <p><b>instruction：</b>${esc(els.customInstruction.value)}</p>
    <p><b>tools：</b>${esc(selectedValues(els.toolPicker).join("、") || "未选择")}</p>
    <p><b>resources：</b>${esc(selectedValues(els.resourcePicker).join("、") || "未选择")}</p>
    <p><b>riskRules：</b>${selectedValues(els.rulePicker).length} 条</p>
  `;
  els.runInput.innerHTML = `
    <p><b>Agent：</b>${esc(currentAgent().name)} (${esc(currentAgent().adapterType)})</p>
    <p><b>Case：</b>${esc(testCase.caseName)}</p>
    <p><b>Mode：</b>${esc(els.modeSelect.value)}</p>
    <p><b>Instruction：</b>${esc(els.customInstruction.value)}</p>
  `;
}

function renderFileStrip() {
  const files = [
    ["tools.json", "工具定义与风险标签", bootstrap.tools.length],
    ["resources.json", "资源与敏感标签", bootstrap.resources.length],
    ["prompts.json", "提示模板与注入样例", bootstrap.prompts.length],
    ["tool_responses.json", "工具返回模板", bootstrap.toolResponses.length],
    ["risk_rules.json", "风险判定规则", bootstrap.riskRules.length],
    ["test_cases.json", "测试用例集合", bootstrap.testCases.length],
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
  els.overviewStatus.textContent = "配置已就绪";
  els.overviewStatusDetail.textContent = "配置已加载，系统就绪。";
}

function renderConfigBoard() {
  if (!bootstrap) return;
  const groups = [
    ["Tools", bootstrap.tools, "toolId", (item) => `${item.name} · ${item.riskLevel} · ${item.sideEffect}`],
    ["Resources", bootstrap.resources, "resourceId", (item) => `${item.path || item.resourceId} · ${item.sensitivity} · injection=${item.containsInjection}`],
    ["Prompts", bootstrap.prompts, "promptId", (item) => `${item.attackEntryType || "prompt"} · ${item.name}`],
    ["Tool Responses", bootstrap.toolResponses, "responseTemplateId", (item) => `${item.toolId} · injection=${item.containsInjection}`],
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

function renderTrace(trace) {
  els.traceList.innerHTML = trace.events
    .map(
      (event) => `
        <li>
          <div><span class="event-type">${esc(event.eventType)}</span> · ${esc(event.actor)} · #${event.sequence}</div>
          <div class="payload">${esc(JSON.stringify(event.payload))}</div>
        </li>
      `,
    )
    .join("");
  renderTraceMirror();
}

function renderTraceMirror() {
  if (!els.traceMirrorList) return;
  if (!runPayload?.trace) {
    els.traceMirrorList.innerHTML = `<li class="empty-state">暂无 Trace。进入 Workbench 运行一次测评后会同步到这里。</li>`;
    return;
  }
  els.traceMirrorList.innerHTML = runPayload.trace.events
    .map(
      (event) => `
        <li>
          <div><span class="event-type">${esc(event.eventType)}</span> · ${esc(event.actor)} · #${event.sequence}</div>
          <div class="payload">${esc(JSON.stringify(event.payload))}</div>
        </li>
      `,
    )
    .join("");
}

function renderMonitor(payload) {
  const errors = payload.trace.events.filter((event) => event.eventType === "system_error").length;
  els.runEvents.textContent = String(payload.monitor.totalEvents);
  els.runToolCalls.textContent = String(payload.monitor.counts.tool_call || 0);
  els.runErrors.textContent = String(errors);
  els.runSummary.innerHTML = `
    <p><b>runId：</b>${esc(payload.trace.runId)}</p>
    <p><b>traceId：</b>${esc(payload.trace.traceId)}</p>
    <p><b>observedChannels：</b>${esc(payload.monitor.observedChannels.join("、"))}</p>
  `;
  renderTrace(payload.trace);
  els.finishMonitorButton.disabled = false;
  els.riskInput.innerHTML = `
    <p><b>contextId：</b>${esc(payload.context.contextId)}</p>
    <p><b>traceId：</b>${esc(payload.trace.traceId)}</p>
    <p><b>eventCount：</b>${payload.monitor.totalEvents}</p>
    <p><b>riskRules：</b>${payload.context.riskRules.length} 条</p>
  `;
  els.buildRiskButton.disabled = false;
  els.overviewLastRun.innerHTML = `
    <p><b>traceId：</b>${esc(payload.trace.traceId)}</p>
    <p><b>事件数：</b>${payload.monitor.totalEvents}</p>
    <p><b>当前状态：</b>已生成 InteractionTrace，等待风险判定。</p>
  `;
  renderTraceMirror();
}

function renderFindings(findings) {
  if (!findings.length) {
    els.findingList.innerHTML = `<div class="empty-state">没有命中风险规则，当前 trace 未发现高风险行为。</div>`;
    return;
  }
  els.findingList.innerHTML = findings
    .map(
      (finding) => `
        <article class="finding-card">
          <strong>${esc(finding.name || finding.title)} · ${esc(riskText(finding.riskLevel))}</strong>
          <p>${esc(finding.description)}</p>
          <p>分类：${esc(finding.category)}；证据事件：${esc(finding.eventId || finding.evidenceEventIds?.[0])}</p>
        </article>
      `,
    )
    .join("");
}

function renderRisk(payload) {
  riskBuilt = true;
  els.riskBadge.textContent = riskText(payload.risk.riskLevel);
  els.riskBadge.dataset.risk = payload.risk.riskLevel;
  els.riskScore.textContent = String(payload.risk.riskScore);
  els.findingCount.textContent = String(payload.risk.findingCount);
  renderFindings(payload.report.findings);
  els.nextReportButton.disabled = false;
  els.reportInput.innerHTML = `
    <p><b>riskLevel：</b>${esc(riskText(payload.risk.riskLevel))}</p>
    <p><b>findingCount：</b>${payload.risk.findingCount}</p>
    <p><b>evidenceCount：</b>${payload.risk.evidenceCount}</p>
    <p><b>attackChainCount：</b>${payload.risk.attackChainCount}</p>
  `;
  els.buildReportButton.disabled = false;
  renderReportDashboard();
  showStep(4);
}

function renderReport(payload) {
  reportBuilt = true;
  els.chainCount.textContent = String(payload.risk.attackChainCount);
  els.evidenceCount.textContent = String(payload.risk.evidenceCount);
  els.reportRisk.textContent = riskText(payload.report.riskLevel);
  const traceUrl = `/${payload.artifacts.tracePath}`;
  const reportUrl = `/${payload.artifacts.reportPath}`;
  const pdfUrl = payload.artifacts.pdfPath ? `/${payload.artifacts.pdfPath}` : "";
  els.artifactText.innerHTML = `
    <p><b>Trace JSON：</b><a href="${esc(traceUrl)}" target="_blank" rel="noreferrer">${esc(payload.artifacts.tracePath)}</a></p>
    <p><b>Report JSON：</b><a href="${esc(reportUrl)}" target="_blank" rel="noreferrer">${esc(payload.artifacts.reportPath)}</a></p>
    ${pdfUrl ? `<p><b>PDF：</b><a href="${esc(pdfUrl)}" download>${esc(payload.artifacts.pdfPath)}</a></p>` : ""}
    <p><b>Report ID：</b>${esc(payload.report.reportId)}</p>
  `;
  if (els.pdfReportButton) {
    if (pdfUrl) {
      els.pdfReportButton.href = pdfUrl;
      els.pdfReportButton.download = payload.artifacts.pdfPath.split("/").pop();
      els.pdfReportButton.setAttribute("aria-disabled", "false");
      els.pdfReportButton.classList.remove("disabled");
    } else {
      els.pdfReportButton.href = "#";
      els.pdfReportButton.removeAttribute("download");
      els.pdfReportButton.setAttribute("aria-disabled", "true");
      els.pdfReportButton.classList.add("disabled");
    }
  }
  renderReportDashboard();
  showStep(5);
}

function renderReportDashboard() {
  if (!els.reportDashboard) return;
  if (!runPayload) {
    els.reportDashboard.innerHTML = `<div class="empty-state">暂无报告。完成 Workbench 的风险判定和报告输出后会显示结果。</div>`;
    return;
  }

  const artifacts = runPayload.artifacts
    ? `
      <div class="artifact-list compact">
        <p><b>Trace：</b>${esc(runPayload.artifacts.tracePath)}</p>
        <p><b>Report：</b>${esc(runPayload.artifacts.reportPath)}</p>
        ${
          runPayload.artifacts.pdfPath
            ? `<a class="download-button compact-download" href="/${esc(runPayload.artifacts.pdfPath)}" download>下载 PDF 报告</a>`
            : ""
        }
      </div>
    `
    : `<div class="empty-state">风险已判定，报告产物尚未生成。</div>`;

  els.reportDashboard.innerHTML = `
    <div class="report-grid">
      <article class="kpi-tile">
        <span>${esc(riskText(runPayload.risk?.riskLevel))}</span>
        <p>风险等级</p>
      </article>
      <article class="kpi-tile">
        <span>${esc(runPayload.risk?.findingCount ?? 0)}</span>
        <p>风险发现</p>
      </article>
      <article class="kpi-tile">
        <span>${esc(runPayload.risk?.evidenceCount ?? 0)}</span>
        <p>证据链</p>
      </article>
    </div>
    <div class="finding-list">
      ${
        runPayload.report?.findings?.length
          ? runPayload.report.findings
              .map(
                (finding) => `
                  <article class="finding-card">
                    <strong>${esc(finding.name || finding.title)} · ${esc(riskText(finding.riskLevel))}</strong>
                    <p>${esc(finding.description)}</p>
                  </article>
                `,
              )
              .join("")
          : `<div class="empty-state">暂无 Finding。</div>`
      }
    </div>
    ${artifacts}
  `;
}

function resetReportDownload() {
  els.artifactText.textContent = "等待生成";
  if (!els.pdfReportButton) return;
  els.pdfReportButton.href = "#";
  els.pdfReportButton.removeAttribute("download");
  els.pdfReportButton.setAttribute("aria-disabled", "true");
  els.pdfReportButton.classList.add("disabled");
}

async function runDemo() {
  els.runButton.disabled = true;
  els.runButton.textContent = "运行中";
  els.flowStatus.textContent = "动态执行中";
  try {
    const response = await fetch("/api/run-demo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody()),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    runPayload = await response.json();
    riskBuilt = false;
    reportBuilt = false;
    els.nextReportButton.disabled = true;
    els.buildReportButton.disabled = true;
    resetReportDownload();
    renderMonitor(runPayload);
    showStep(3);
  } catch (error) {
    els.runSummary.innerHTML = `<p>运行失败：${esc(error.message)}</p>`;
  } finally {
    els.runButton.disabled = false;
    els.runButton.textContent = "重新运行动态交互测试";
  }
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
  els.caseSelect.addEventListener("change", renderEnvironmentInputs);
  els.modeSelect.addEventListener("change", renderContextPreview);
  els.customInstruction.addEventListener("input", renderContextPreview);
  els.toolPicker.addEventListener("change", renderContextPreview);
  els.resourcePicker.addEventListener("change", renderContextPreview);
  els.rulePicker.addEventListener("change", renderContextPreview);
  els.finishEnvButton.addEventListener("click", () => {
    renderContextPreview();
    showStep(2);
  });
  els.runButton.addEventListener("click", runDemo);
  els.finishMonitorButton.addEventListener("click", () => showStep(4));
  els.buildRiskButton.addEventListener("click", () => runPayload && renderRisk(runPayload));
  els.nextReportButton.addEventListener("click", () => showStep(5));
  els.buildReportButton.addEventListener("click", () => runPayload && renderReport(runPayload));
  [...els.stepList.children].forEach((item) => {
    item.addEventListener("click", () => {
      const step = Number(item.dataset.step);
      if (step === 0 || isDone(step - 1)) showStep(step);
    });
  });
  ["input", "change"].forEach((eventName) => {
    [els.agentName, els.agentId, els.adapterType, els.agentEndpoint, els.timeoutMs].forEach((el) => {
      el.addEventListener(eventName, renderAgentPreview);
    });
  });
}

async function init() {
  const response = await fetch("/api/bootstrap");
  bootstrap = await response.json();
  els.caseSelect.innerHTML = bootstrap.testCases
    .filter((item) => item.enabled)
    .map((item) => `<option value="${esc(item.caseId)}">${esc(item.caseName)}</option>`)
    .join("");
  renderAgentPreview();
  renderOverview();
  renderConfigBoard();
  renderFileStrip();
  renderEnvironmentInputs();
  renderTraceMirror();
  renderReportDashboard();
  bindEvents();
  showStep(0);
  showModule("overview");
  els.consoleApp.classList.add("hidden");
  els.landingPage.classList.remove("hidden");
}

init();
