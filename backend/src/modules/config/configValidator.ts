import type { ConfigRepository } from "./configRepository";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  code: string;
  message: string;
  path: string;
};

export type ValidationResult = {
  ok: boolean;
  issues: ValidationIssue[];
};

const schemaVersion = "mvp-1";
const aLineSchemaVersion = "p3-a-1";
const matcherOperators = new Set([
  "exists",
  "equals",
  "contains",
  "starts_with",
  "ends_with",
  "in",
  "regex",
]);
const riskCategories = new Set([
  "tool_misuse",
  "unauthorized_access",
  "data_leakage",
  "dangerous_action",
  "instruction_injection_following",
]);
const supervisionActions = new Set([
  "allow",
  "deny",
  "ask",
  "warn",
  "redact",
  "isolate",
]);
const supervisionTargetTypes = new Set([
  "tool_call",
  "resource_access",
  "api_call",
  "file_write",
  "email_send",
  "code_execution",
  "agent_message",
]);
const pyritExecutionModes = new Set([
  "native_ts_adapter",
  "python_reference",
  "metadata_only",
]);
const pyritMaturityLevels = new Set([
  "vendored_reference",
  "config_integrated",
  "runtime_integrated",
]);
const attackEntryTypes = new Set([
  "malicious_user_prompt",
  "malicious_resource",
  "tool_response_injection",
  "multi_turn_induction",
]);

export function validateConfigRepository(
  repository: ConfigRepository,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  assertUnique(issues, "tools", repository.tools.map((tool) => tool.toolId));
  assertUnique(
    issues,
    "resources",
    repository.resources.map((resource) => resource.resourceId),
  );
  assertUnique(
    issues,
    "prompts",
    repository.prompts.map((prompt) => prompt.promptId),
  );
  assertUnique(
    issues,
    "toolResponseTemplates",
    repository.toolResponseTemplates.map((response) => response.responseTemplateId),
  );
  assertUnique(
    issues,
    "riskRules",
    repository.riskRules.map((rule) => rule.ruleId),
  );
  assertUnique(
    issues,
    "testCases",
    repository.testCases.map((testCase) => testCase.caseId),
  );
  assertUnique(
    issues,
    "testOracles",
    repository.testOracles.map((oracle) => oracle.oracleId),
  );
  assertUnique(
    issues,
    "redTeamScenarios",
    repository.redTeamScenarioSet.scenarios.map((scenario) => scenario.scenarioId),
  );
  assertUnique(
    issues,
    "policyTemplates",
    repository.policyTemplates.map((template) => template.policyTemplateId),
  );
  assertUnique(
    issues,
    "pyritAttackLibrary.converterCatalog",
    repository.pyritAttackLibrary.converterCatalog.map((converter) => converter.converterId),
  );
  assertUnique(
    issues,
    "pyritAttackLibrary.attackFamilies",
    repository.pyritAttackLibrary.attackFamilies.map((family) => family.familyId),
  );
  assertUnique(
    issues,
    "pyritAttackLibrary.samples",
    repository.pyritAttackLibrary.samples.map((sample) => sample.sampleId),
  );
  assertUnique(
    issues,
    "pyritJailbreakTemplateIndex.groups",
    repository.pyritJailbreakTemplateIndex.groups.map((group) => group.groupId),
  );
  assertUnique(
    issues,
    "pyritJailbreakTemplateIndex.templates",
    repository.pyritJailbreakTemplateIndex.templates.map((template) => template.templateId),
  );

  const toolIds = new Set(repository.tools.map((tool) => tool.toolId));
  const resourceIds = new Set(
    repository.resources.map((resource) => resource.resourceId),
  );
  const promptIds = new Set(repository.prompts.map((prompt) => prompt.promptId));
  const responseTemplateIds = new Set(
    repository.toolResponseTemplates.map((response) => response.responseTemplateId),
  );
  const caseIds = new Set(repository.testCases.map((testCase) => testCase.caseId));
  const enabledCaseIds = new Set(
    repository.testCases
      .filter((testCase) => testCase.enabled)
      .map((testCase) => testCase.caseId),
  );
  const policyTemplateIds = new Set(
    repository.policyTemplates.map((template) => template.policyTemplateId),
  );
  const scenarioIds = new Set(
    repository.redTeamScenarioSet.scenarios.map((scenario) => scenario.scenarioId),
  );
  const promptIdsForPyrit = new Set(repository.prompts.map((prompt) => prompt.promptId));
  const pyritFamilyIds = new Set(
    repository.pyritAttackLibrary.attackFamilies.map((family) => family.familyId),
  );
  const pyritConverterIds = new Set(
    repository.pyritAttackLibrary.converterCatalog.map((converter) => converter.converterId),
  );
  const riskTagIds = new Set<string>();

  for (const riskTagOwner of [
    ...repository.tools,
    ...repository.resources,
    ...repository.prompts,
    ...repository.toolResponseTemplates,
  ]) {
    for (const tag of riskTagOwner.riskTags) {
      riskTagIds.add(tag.tagId);
    }
  }

  for (const response of repository.toolResponseTemplates) {
    assertReference(
      issues,
      toolIds,
      response.toolId,
      `toolResponseTemplates.${response.responseTemplateId}.toolId`,
    );
  }

  for (const rule of repository.riskRules) {
    if (rule.ruleVersion !== schemaVersion) {
      issues.push({
        severity: "error",
        code: "invalid_schema_version",
        message: `Risk rule "${rule.ruleId}" must use ruleVersion "${schemaVersion}".`,
        path: `riskRules.${rule.ruleId}.ruleVersion`,
      });
    }

    for (const tagId of rule.match.riskTagIds ?? []) {
      assertReference(issues, riskTagIds, tagId, `riskRules.${rule.ruleId}.match.riskTagIds`);
    }

    validateMatchCondition(issues, rule.match, `riskRules.${rule.ruleId}.match`);
  }

  for (const testCase of repository.testCases) {
    if (testCase.schemaVersion !== schemaVersion) {
      issues.push({
        severity: "error",
        code: "invalid_schema_version",
        message: `Test case "${testCase.caseId}" must use schemaVersion "${schemaVersion}".`,
        path: `testCases.${testCase.caseId}.schemaVersion`,
      });
    }
    if (testCase.task.caseId !== testCase.caseId) {
      issues.push({
        severity: "error",
        code: "case_id_mismatch",
        message: `Task caseId "${testCase.task.caseId}" does not match test case "${testCase.caseId}".`,
        path: `testCases.${testCase.caseId}.task.caseId`,
      });
    }

    for (const toolId of testCase.toolIds) {
      assertReference(issues, toolIds, toolId, `testCases.${testCase.caseId}.toolIds`);
    }
    for (const resourceId of testCase.resourceIds) {
      assertReference(
        issues,
        resourceIds,
        resourceId,
        `testCases.${testCase.caseId}.resourceIds`,
      );
    }
    for (const promptId of testCase.promptIds) {
      assertReference(
        issues,
        promptIds,
        promptId,
        `testCases.${testCase.caseId}.promptIds`,
      );
    }
    for (const plan of testCase.toolResponsePlan) {
      assertReference(
        issues,
        toolIds,
        plan.toolId,
        `testCases.${testCase.caseId}.toolResponsePlan.${plan.planId}.toolId`,
      );
      assertReference(
        issues,
        responseTemplateIds,
        plan.responseTemplateId,
        `testCases.${testCase.caseId}.toolResponsePlan.${plan.planId}.responseTemplateId`,
      );
      const response = repository.toolResponseTemplates.find(
        (item) => item.responseTemplateId === plan.responseTemplateId,
      );
      if (response && response.toolId !== plan.toolId) {
        issues.push({
          severity: "error",
          code: "tool_response_tool_mismatch",
          message: `Response template "${response.responseTemplateId}" belongs to "${response.toolId}", not "${plan.toolId}".`,
          path: `testCases.${testCase.caseId}.toolResponsePlan.${plan.planId}`,
        });
      }
      if (
        plan.trigger === "matching_parameters" &&
        (!plan.parameterMatchers || plan.parameterMatchers.length === 0)
      ) {
        issues.push({
          severity: "warning",
          code: "missing_parameter_matchers",
          message: `Plan "${plan.planId}" uses matching_parameters without parameterMatchers.`,
          path: `testCases.${testCase.caseId}.toolResponsePlan.${plan.planId}.parameterMatchers`,
        });
      }
      for (const matcher of plan.parameterMatchers ?? []) {
        if (!matcherOperators.has(matcher.operator)) {
          issues.push({
            severity: "error",
            code: "invalid_match_operator",
            message: `Unknown matcher operator "${matcher.operator}".`,
            path: `testCases.${testCase.caseId}.toolResponsePlan.${plan.planId}.parameterMatchers.${matcher.fieldPath}`,
          });
        }
      }
    }
    for (const resourceId of testCase.task.resourceIds) {
      assertReference(
        issues,
        resourceIds,
        resourceId,
        `testCases.${testCase.caseId}.task.resourceIds`,
      );
    }
    for (const promptId of testCase.task.promptIds) {
      assertReference(
        issues,
        promptIds,
        promptId,
        `testCases.${testCase.caseId}.task.promptIds`,
      );
    }
  }

  for (const oracle of repository.testOracles) {
    if (oracle.schemaVersion !== schemaVersion) {
      issues.push({
        severity: "error",
        code: "invalid_schema_version",
        message: `Test oracle "${oracle.oracleId}" must use schemaVersion "${schemaVersion}".`,
        path: `testOracles.${oracle.oracleId}.schemaVersion`,
      });
    }
    assertReference(issues, caseIds, oracle.caseId, `testOracles.${oracle.oracleId}.caseId`);
    for (const toolId of oracle.expectedOutcome.expectedToolIds) {
      assertReference(
        issues,
        toolIds,
        toolId,
        `testOracles.${oracle.oracleId}.expectedOutcome.expectedToolIds`,
      );
    }
  }

  if (repository.redTeamScenarioSet.schemaVersion !== schemaVersion) {
    issues.push({
      severity: "error",
      code: "invalid_schema_version",
      message: `Red team scenario set "${repository.redTeamScenarioSet.scenarioSetId}" must use schemaVersion "${schemaVersion}".`,
      path: "redTeamScenarioSet.schemaVersion",
    });
  }

  for (const scenario of repository.redTeamScenarioSet.scenarios) {
    if (!scenario.scenarioId) {
      issues.push({
        severity: "error",
        code: "missing_id",
        message: "Red team scenario must have scenarioId.",
        path: "redTeamScenarioSet.scenarios.scenarioId",
      });
    }

    for (const caseId of scenario.caseIds) {
      assertReference(
        issues,
        caseIds,
        caseId,
        `redTeamScenarioSet.scenarios.${scenario.scenarioId}.caseIds`,
      );
    }

    if (!scenario.caseIds.some((caseId) => enabledCaseIds.has(caseId))) {
      issues.push({
        severity: "warning",
        code: "scenario_without_enabled_case",
        message: `Scenario "${scenario.scenarioId}" has no enabled test case.`,
        path: `redTeamScenarioSet.scenarios.${scenario.scenarioId}.caseIds`,
      });
    }

    for (const category of scenario.expectedWeaknessCategories) {
      if (!riskCategories.has(category)) {
        issues.push({
          severity: "error",
          code: "invalid_risk_category",
          message: `Unknown risk category "${category}".`,
          path: `redTeamScenarioSet.scenarios.${scenario.scenarioId}.expectedWeaknessCategories`,
        });
      }
    }

    for (const policyTemplateId of scenario.recommendedPolicyTemplateIds) {
      assertReference(
        issues,
        policyTemplateIds,
        policyTemplateId,
        `redTeamScenarioSet.scenarios.${scenario.scenarioId}.recommendedPolicyTemplateIds`,
      );
    }
  }

  const referencedPolicyTemplateIds = new Set(
    repository.redTeamScenarioSet.scenarios.flatMap(
      (scenario) => scenario.recommendedPolicyTemplateIds,
    ),
  );

  for (const template of repository.policyTemplates) {
    if (template.schemaVersion !== schemaVersion) {
      issues.push({
        severity: "error",
        code: "invalid_schema_version",
        message: `Policy template "${template.policyTemplateId}" must use schemaVersion "${schemaVersion}".`,
        path: `policyTemplates.${template.policyTemplateId}.schemaVersion`,
      });
    }

    if (!supervisionTargetTypes.has(template.targetType)) {
      issues.push({
        severity: "error",
        code: "invalid_supervision_target_type",
        message: `Unknown supervision target type "${template.targetType}".`,
        path: `policyTemplates.${template.policyTemplateId}.targetType`,
      });
    }

    if (!supervisionActions.has(template.action)) {
      issues.push({
        severity: "error",
        code: "invalid_supervision_action",
        message: `Unknown supervision action "${template.action}".`,
        path: `policyTemplates.${template.policyTemplateId}.action`,
      });
    }

    if (!riskCategories.has(template.riskCategory)) {
      issues.push({
        severity: "error",
        code: "invalid_risk_category",
        message: `Unknown risk category "${template.riskCategory}".`,
        path: `policyTemplates.${template.policyTemplateId}.riskCategory`,
      });
    }

    validateMatchCondition(
      issues,
      template.match,
      `policyTemplates.${template.policyTemplateId}.match`,
    );

    for (const tagId of template.match.riskTagIds ?? []) {
      assertReference(
        issues,
        riskTagIds,
        tagId,
        `policyTemplates.${template.policyTemplateId}.match.riskTagIds`,
      );
    }

    if (!referencedPolicyTemplateIds.has(template.policyTemplateId)) {
      issues.push({
        severity: "warning",
        code: "unreferenced_policy_template",
        message: `Policy template "${template.policyTemplateId}" is not recommended by any red team scenario.`,
        path: `policyTemplates.${template.policyTemplateId}`,
      });
    }
  }

  validatePyritAttackLibrary(issues, repository, {
    caseIds,
    promptIds: promptIdsForPyrit,
    scenarioIds,
    pyritFamilyIds,
    pyritConverterIds,
  });
  validatePyritJailbreakTemplateIndex(issues, repository);

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

function validatePyritAttackLibrary(
  issues: ValidationIssue[],
  repository: ConfigRepository,
  refs: {
    caseIds: Set<string>;
    promptIds: Set<string>;
    scenarioIds: Set<string>;
    pyritFamilyIds: Set<string>;
    pyritConverterIds: Set<string>;
  },
): void {
  const library = repository.pyritAttackLibrary;
  if (library.schemaVersion !== aLineSchemaVersion) {
    issues.push({
      severity: "error",
      code: "invalid_schema_version",
      message: `PyRIT attack library "${library.libraryId}" must use schemaVersion "${aLineSchemaVersion}".`,
      path: "pyritAttackLibrary.schemaVersion",
    });
  }

  if (!library.source.importedPath || !library.source.localSourcePath) {
    issues.push({
      severity: "error",
      code: "missing_pyrit_source_path",
      message: "PyRIT attack library source must include localSourcePath and importedPath.",
      path: "pyritAttackLibrary.source",
    });
  }

  for (const converter of library.converterCatalog) {
    if (!pyritExecutionModes.has(converter.executionMode)) {
      issues.push({
        severity: "error",
        code: "invalid_pyrit_execution_mode",
        message: `Unknown PyRIT converter execution mode "${converter.executionMode}".`,
        path: `pyritAttackLibrary.converterCatalog.${converter.converterId}.executionMode`,
      });
    }
    if (!converter.sourcePath) {
      issues.push({
        severity: "error",
        code: "missing_pyrit_source_path",
        message: `PyRIT converter "${converter.converterId}" must include sourcePath.`,
        path: `pyritAttackLibrary.converterCatalog.${converter.converterId}.sourcePath`,
      });
    }
  }

  for (const family of library.attackFamilies) {
    if (!pyritMaturityLevels.has(family.maturity)) {
      issues.push({
        severity: "error",
        code: "invalid_pyrit_maturity",
        message: `Unknown PyRIT family maturity "${family.maturity}".`,
        path: `pyritAttackLibrary.attackFamilies.${family.familyId}.maturity`,
      });
    }
    for (const category of family.riskCategories) {
      if (!riskCategories.has(category)) {
        issues.push({
          severity: "error",
          code: "invalid_risk_category",
          message: `Unknown risk category "${category}".`,
          path: `pyritAttackLibrary.attackFamilies.${family.familyId}.riskCategories`,
        });
      }
    }
    for (const caseId of family.recommendedCaseIds) {
      assertReference(
        issues,
        refs.caseIds,
        caseId,
        `pyritAttackLibrary.attackFamilies.${family.familyId}.recommendedCaseIds`,
      );
    }
  }

  for (const sample of library.samples) {
    assertReference(
      issues,
      refs.pyritFamilyIds,
      sample.familyId,
      `pyritAttackLibrary.samples.${sample.sampleId}.familyId`,
    );

    if (!attackEntryTypes.has(sample.attackEntryType)) {
      issues.push({
        severity: "error",
        code: "invalid_attack_entry_type",
        message: `Unknown attack entry type "${sample.attackEntryType}".`,
        path: `pyritAttackLibrary.samples.${sample.sampleId}.attackEntryType`,
      });
    }

    for (const category of sample.riskCategories) {
      if (!riskCategories.has(category)) {
        issues.push({
          severity: "error",
          code: "invalid_risk_category",
          message: `Unknown risk category "${category}".`,
          path: `pyritAttackLibrary.samples.${sample.sampleId}.riskCategories`,
        });
      }
    }
    for (const caseId of sample.caseIds) {
      assertReference(
        issues,
        refs.caseIds,
        caseId,
        `pyritAttackLibrary.samples.${sample.sampleId}.caseIds`,
      );
    }
    for (const promptId of sample.promptIds) {
      assertReference(
        issues,
        refs.promptIds,
        promptId,
        `pyritAttackLibrary.samples.${sample.sampleId}.promptIds`,
      );
    }
    for (const converterId of sample.converterIds) {
      assertReference(
        issues,
        refs.pyritConverterIds,
        converterId,
        `pyritAttackLibrary.samples.${sample.sampleId}.converterIds`,
      );
    }
    for (const scenarioId of getStringArray(sample.metadata?.scenarioIds)) {
      assertReference(
        issues,
        refs.scenarioIds,
        scenarioId,
        `pyritAttackLibrary.samples.${sample.sampleId}.metadata.scenarioIds`,
      );
    }
  }
}

function validatePyritJailbreakTemplateIndex(
  issues: ValidationIssue[],
  repository: ConfigRepository,
): void {
  const index = repository.pyritJailbreakTemplateIndex;
  if (index.schemaVersion !== aLineSchemaVersion) {
    issues.push({
      severity: "error",
      code: "invalid_schema_version",
      message: `PyRIT jailbreak template index "${index.indexId}" must use schemaVersion "${aLineSchemaVersion}".`,
      path: "pyritJailbreakTemplateIndex.schemaVersion",
    });
  }

  if (!index.sourcePath) {
    issues.push({
      severity: "error",
      code: "missing_pyrit_source_path",
      message: "PyRIT jailbreak template index must include sourcePath.",
      path: "pyritJailbreakTemplateIndex.sourcePath",
    });
  }

  if (index.totalTemplates !== index.templates.length) {
    issues.push({
      severity: "error",
      code: "pyrit_template_count_mismatch",
      message: `PyRIT jailbreak template totalTemplates ${index.totalTemplates} does not match templates length ${index.templates.length}.`,
      path: "pyritJailbreakTemplateIndex.totalTemplates",
    });
  }

  const groupIds = new Set(index.groups.map((group) => group.groupId));
  const actualGroupCounts = new Map<string, number>();

  for (const template of index.templates) {
    assertReference(
      issues,
      groupIds,
      template.groupId,
      `pyritJailbreakTemplateIndex.templates.${template.templateId}.groupId`,
    );

    actualGroupCounts.set(
      template.groupId,
      (actualGroupCounts.get(template.groupId) ?? 0) + 1,
    );

    if (!template.sourcePath || !template.sha256) {
      issues.push({
        severity: "error",
        code: "invalid_pyrit_template_reference",
        message: `PyRIT jailbreak template "${template.templateId}" must include sourcePath and sha256.`,
        path: `pyritJailbreakTemplateIndex.templates.${template.templateId}`,
      });
    }

    if (template.byteLength <= 0) {
      issues.push({
        severity: "error",
        code: "invalid_pyrit_template_reference",
        message: `PyRIT jailbreak template "${template.templateId}" must have positive byteLength.`,
        path: `pyritJailbreakTemplateIndex.templates.${template.templateId}.byteLength`,
      });
    }
  }

  for (const group of index.groups) {
    const actualCount = actualGroupCounts.get(group.groupId) ?? 0;
    if (group.templateCount !== actualCount) {
      issues.push({
        severity: "error",
        code: "pyrit_template_group_count_mismatch",
        message: `PyRIT jailbreak template group "${group.groupId}" declares ${group.templateCount} templates but index contains ${actualCount}.`,
        path: `pyritJailbreakTemplateIndex.groups.${group.groupId}.templateCount`,
      });
    }
  }
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function validateMatchCondition(
  issues: ValidationIssue[],
  match: { relation: string; matchers?: { operator: string; fieldPath: string }[] },
  path: string,
): void {
  if (match.relation !== "all" && match.relation !== "any") {
    issues.push({
      severity: "error",
      code: "invalid_match_relation",
      message: `Unknown match relation "${match.relation}".`,
      path: `${path}.relation`,
    });
  }

  for (const matcher of match.matchers ?? []) {
    if (!matcherOperators.has(matcher.operator)) {
      issues.push({
        severity: "error",
        code: "invalid_match_operator",
        message: `Unknown matcher operator "${matcher.operator}".`,
        path: `${path}.matchers.${matcher.fieldPath}`,
      });
    }
  }
}

function assertUnique(
  issues: ValidationIssue[],
  path: string,
  values: string[],
): void {
  const seen = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) {
      issues.push({
        severity: "error",
        code: "duplicate_id",
        message: `Duplicate id "${value}".`,
        path,
      });
    }
    seen.add(value);
  }
}

function assertReference(
  issues: ValidationIssue[],
  knownIds: Set<string>,
  value: string,
  path: string,
): void {
  if (!knownIds.has(value)) {
    issues.push({
      severity: "error",
      code: "missing_reference",
      message: `Unknown referenced id "${value}".`,
      path,
    });
  }
}
