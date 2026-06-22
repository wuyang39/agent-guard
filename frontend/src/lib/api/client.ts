import { agentsApi } from "./agents";
import { realtimeApi } from "./realtime";
import { reportsApi } from "./reports";
import { runtimeConfigApi } from "./runtimeConfig";
import { runsApi } from "./runs";
import { systemApi } from "./system";
import { testSelectionApi } from "./testSelection";

export { apiBaseUrl } from "./core";

export const agentGuardApi = {
  ...systemApi,
  ...agentsApi,
  ...runsApi,
  ...testSelectionApi,
  ...reportsApi,
  ...realtimeApi,
  ...runtimeConfigApi,
};
