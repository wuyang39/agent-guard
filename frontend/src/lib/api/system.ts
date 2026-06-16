import { request } from "./core";
import type { SystemStatus } from "./types";

export const systemApi = {
  systemStatus() {
    return request<SystemStatus>("/api/v1/system/status");
  },
};
