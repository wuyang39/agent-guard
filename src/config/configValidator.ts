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

  const toolIds = new Set(repository.tools.map((tool) => tool.toolId));
  const resourceIds = new Set(
    repository.resources.map((resource) => resource.resourceId),
  );
  const promptIds = new Set(repository.prompts.map((prompt) => prompt.promptId));
  const responseTemplateIds = new Set(
    repository.toolResponseTemplates.map((response) => response.responseTemplateId),
  );
  const caseIds = new Set(repository.testCases.map((testCase) => testCase.caseId));

  for (const testCase of repository.testCases) {
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
    }
  }

  for (const oracle of repository.testOracles) {
    assertReference(issues, caseIds, oracle.caseId, `testOracles.${oracle.oracleId}.caseId`);
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
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
