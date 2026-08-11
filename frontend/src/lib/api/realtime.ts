import { apiBaseUrl, request } from "./core";
import type {
  AskTimeoutConfig,
  DefenseDetailView,
  MainAgentSupervisionStatus,
  PendingSupervisionAsk,
  RealtimeActivePolicyState,
  RealtimePreparedSession,
} from "./types";

type BrowserAccessEnvironment = {
  location: { hash: string; pathname: string; search: string };
  history: {
    state: unknown;
    replaceState(state: unknown, unused: string, url?: string | URL | null): void;
  };
};

export type NativeSupervisionBrowserAccessClient = {
  ensureAccess(): Promise<void>;
  issueEventCapability(): Promise<void>;
};

export function exchangeNativeSupervisionBootstrap(token: string): Promise<void> {
  return request<void>("/api/v1/openclaw/native-supervision/access/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export function createNativeSupervisionBrowserAccessClient(options: {
  getEnvironment(): BrowserAccessEnvironment | undefined;
  exchangeBootstrap(token: string): Promise<void>;
  mintEventCapability(): Promise<void>;
}): NativeSupervisionBrowserAccessClient {
  let accessPromise: Promise<void> | undefined;

  function ensureAccess(): Promise<void> {
    if (accessPromise) return accessPromise;
    const environment = options.getEnvironment();
    const params = new URLSearchParams(
      environment?.location.hash.startsWith("#")
        ? environment.location.hash.slice(1)
        : environment?.location.hash ?? "",
    );
    const hasBootstrap = params.has("agent-guard-bootstrap");
    const bootstrapToken = hasBootstrap
      ? params.get("agent-guard-bootstrap") ?? ""
      : undefined;
    if (environment && bootstrapToken !== undefined) {
      environment.history.replaceState(
        environment.history.state,
        "",
        `${environment.location.pathname}${environment.location.search}`,
      );
    }
    accessPromise = bootstrapToken === undefined
      ? Promise.resolve()
      : Promise.resolve().then(() => options.exchangeBootstrap(bootstrapToken));
    return accessPromise;
  }

  return {
    ensureAccess,
    async issueEventCapability() {
      await ensureAccess();
      await options.mintEventCapability();
    },
  };
}

export function primeNativeSupervisionBrowserAccess(
  access: NativeSupervisionBrowserAccessClient,
): void {
  void access.ensureAccess().catch(() => undefined);
}

type RealtimeApiDependencies = {
  access: NativeSupervisionBrowserAccessClient;
  request: typeof request;
};

export function createRealtimeApi(dependencies: RealtimeApiDependencies) {
  return {
    liveSupervisionUrl(options?: { includeHistory?: boolean }) {
      const replay = options?.includeHistory ? "1" : "0";
      return `${apiBaseUrl}/api/v1/openclaw/realtime/events/stream?replay=${replay}`;
    },

    supervisionAskStreamUrl(options?: { sessionId?: string }) {
      const query = options?.sessionId
        ? `?sessionId=${encodeURIComponent(options.sessionId)}`
        : "";
      return `${apiBaseUrl}/api/v1/supervision/ask/stream${query}`;
    },

    realtimeMcpInfo() {
      return dependencies.request<{
        activePolicy: RealtimeActivePolicyState;
        openclawConfigExample: unknown;
      }>("/api/v1/openclaw/realtime/mcp");
    },

    activeRealtimePolicy() {
      return dependencies.request<RealtimeActivePolicyState>(
        "/api/v1/openclaw/realtime/active-policy",
      );
    },

    async ensureNativeSupervisionAccess() {
      await dependencies.access.ensureAccess();
    },

    async issueNativeSupervisionEventCapability() {
      await dependencies.access.issueEventCapability();
    },

    async nativeSupervisionStatus() {
      await dependencies.access.ensureAccess();
      return dependencies.request<MainAgentSupervisionStatus>(
        "/api/v1/openclaw/native-supervision",
      );
    },

    async startNativeSupervision(policyPackId: string) {
      await dependencies.access.ensureAccess();
      return dependencies.request<MainAgentSupervisionStatus>(
        "/api/v1/openclaw/native-supervision/start",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policyPackId }),
        },
      );
    },

    async stopNativeSupervision() {
      await dependencies.access.ensureAccess();
      return dependencies.request<MainAgentSupervisionStatus>(
        "/api/v1/openclaw/native-supervision/stop",
        { method: "POST" },
      );
    },

    setRealtimeActivePolicy(policyPackId: string, resetSessions = true) {
      return dependencies.request<RealtimeActivePolicyState>(
        "/api/v1/openclaw/realtime/active-policy",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ policyPackId, resetSessions }),
        },
      );
    },

    createRealtimeSession(policyPackId?: string) {
      return dependencies.request<RealtimePreparedSession>(
        "/api/v1/openclaw/realtime/sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(policyPackId ? { policyPackId } : {}),
        },
      );
    },

    resetRealtimeSessions(runtimeSessionId?: string) {
      return dependencies.request<{ resetCount: number; runtimeSessionId?: string }>(
        "/api/v1/openclaw/realtime/sessions/reset",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(runtimeSessionId ? { runtimeSessionId } : {}),
        },
      );
    },

    finalizeRealtimeDefenseReport(runtimeSessionId: string) {
      return dependencies.request<
        DefenseDetailView & { runGroup: { defenseReportId: string } }
      >(
        "/api/v1/openclaw/realtime/reports/defense",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runtimeSessionId }),
        },
      );
    },

    respondSupervisionAsk(askId: string, decision: "approve" | "reject") {
      return dependencies.request<PendingSupervisionAsk>(
        `/api/v1/supervision/ask/${askId}/respond`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision }),
        },
      );
    },
  };
}

const browserAccess = createNativeSupervisionBrowserAccessClient({
  getEnvironment() {
    return typeof window === "undefined"
      ? undefined
      : { location: window.location, history: window.history };
  },
  exchangeBootstrap: exchangeNativeSupervisionBootstrap,
  mintEventCapability() {
    return request<void>("/api/v1/openclaw/native-supervision/access/events", {
      method: "POST",
    });
  },
});
primeNativeSupervisionBrowserAccess(browserAccess);

export const realtimeApi = createRealtimeApi({ access: browserAccess, request });

export type { AskTimeoutConfig, PendingSupervisionAsk };
