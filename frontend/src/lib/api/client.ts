import { agentsApi } from "./agents";
import { realtimeApi } from "./realtime";
import { reportsApi } from "./reports";
import { runsApi } from "./runs";
import { systemApi } from "./system";

export { apiBaseUrl } from "./core";

export const agentGuardApi = {
  ...systemApi,
  ...agentsApi,
  ...runsApi,
  ...reportsApi,
  ...realtimeApi,
};
