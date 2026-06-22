import type { TestSelectionPlan, TestSelectionRequest } from "@agent-guard/contracts";
import { request } from "./core";

export const testSelectionApi = {
  async createTestSelectionPlan(input: TestSelectionRequest) {
    const result = await request<{ plan: TestSelectionPlan }>(
      "/api/v1/test-selection/plans",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    return result.plan;
  },

  async testSelectionPlan(selectionPlanId: string) {
    const result = await request<{ plan: TestSelectionPlan }>(
      `/api/v1/test-selection/plans/${encodeURIComponent(selectionPlanId)}`,
    );
    return result.plan;
  },
};
