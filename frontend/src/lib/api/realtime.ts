import { apiBaseUrl, request } from "./core";
import type {
  DefenseDetailView,
  RealtimeActivePolicyState,
  RealtimePreparedSession,
} from "./types";

export const realtimeApi = {
  liveSupervisionUrl(options?: { includeHistory?: boolean }) {
    const replay = options?.includeHistory ? "1" : "0";
    return `${apiBaseUrl}/api/v1/openclaw/realtime/events/stream?replay=${replay}`;
  },

  realtimeMcpInfo() {
    return request<{ activePolicy: RealtimeActivePolicyState; openclawConfigExample: unknown }>(
      "/api/v1/openclaw/realtime/mcp",
    );
  },

  activeRealtimePolicy() {
    return request<RealtimeActivePolicyState>("/api/v1/openclaw/realtime/active-policy");
  },

  setRealtimeActivePolicy(policyPackId: string, resetSessions = true) {
    return request<RealtimeActivePolicyState>("/api/v1/openclaw/realtime/active-policy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ policyPackId, resetSessions }),
    });
  },

  createRealtimeSession(policyPackId?: string) {
    return request<RealtimePreparedSession>("/api/v1/openclaw/realtime/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(policyPackId ? { policyPackId } : {}),
    });
  },

  resetRealtimeSessions(runtimeSessionId?: string) {
    return request<{ resetCount: number; runtimeSessionId?: string }>(
      "/api/v1/openclaw/realtime/sessions/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(runtimeSessionId ? { runtimeSessionId } : {}),
      },
    );
  },

  finalizeRealtimeDefenseReport(runtimeSessionId: string) {
    return request<DefenseDetailView & { runGroup: { defenseReportId: string } }>(
      "/api/v1/openclaw/realtime/reports/defense",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtimeSessionId }),
      },
    );
  },
};
