declare module "openclaw/plugin-sdk/plugin-entry" {
  import type { IncomingMessage, ServerResponse } from "node:http";

  export type ToolEvent = {
    toolName: string;
    params: Record<string, unknown>;
    toolKind?: "code_mode_exec";
    toolInputKind?: "javascript" | "typescript";
    runId?: string;
    toolCallId?: string;
    derivedPaths?: readonly string[];
  };

  export type ToolContext = {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    toolName: string;
    toolKind?: "code_mode_exec";
    toolInputKind?: "javascript" | "typescript";
    toolCallId?: string;
    channelId?: string;
  };

  export type BeforeResult = {
    params?: Record<string, unknown>;
    block?: boolean;
    blockReason?: string;
    requireApproval?: {
      title: string;
      description: string;
      severity?: "info" | "warning" | "critical";
      timeoutMs?: number;
      timeoutBehavior?: "allow" | "deny";
      allowedDecisions?: Array<"allow-once" | "allow-always" | "deny">;
    };
  };

  export type AfterToolEvent = ToolEvent & {
    result?: unknown;
    error?: string;
    durationMs?: number;
  };

  export type ToolResultPersistEvent = {
    toolName: string;
    toolCallId?: string;
    message: unknown;
  };

  export type SessionEvent = {
    sessionKey?: string;
    reason?: string;
  };

  export type SubagentSpawnedEvent = {
    childSessionKey: string;
    agentId: string;
    label?: string;
    mode: "run" | "session";
    threadRequested: boolean;
    runId: string;
    resolvedModel?: string;
    resolvedProvider?: string;
  };

  export type SubagentEndedEvent = {
    targetSessionKey: string;
    targetKind: "subagent" | "acp";
    reason: string;
    sendFarewell?: boolean;
    accountId?: string;
    runId?: string;
    endedAt?: number;
    outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
    error?: string;
  };

  export type SubagentContext = {
    runId?: string;
    childSessionKey?: string;
    requesterSessionKey?: string;
  };

  export type HookMap = {
    before_tool_call: (event: ToolEvent, context: ToolContext) => BeforeResult | void | Promise<BeforeResult | void>;
    after_tool_call: (event: AfterToolEvent, context: ToolContext) => void | Promise<void>;
    tool_result_persist: (event: ToolResultPersistEvent, context: ToolContext) => void | Promise<void>;
    session_start: (event: SessionEvent, context: { sessionKey?: string }) => void | Promise<void>;
    session_end: (event: SessionEvent, context: { sessionKey?: string }) => void | Promise<void>;
    subagent_spawned: (event: SubagentSpawnedEvent, context: SubagentContext) => void | Promise<void>;
    subagent_ended: (event: SubagentEndedEvent, context: SubagentContext) => void | Promise<void>;
  };

  export type PluginLogger = {
    debug?: (message: string) => void;
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };

  export type TrustedToolPolicy = {
    id: string;
    description: string;
    evaluate: HookMap["before_tool_call"];
  };

  export type HttpRoute = {
    path: string;
    auth: "gateway" | "plugin";
    match?: "exact" | "prefix";
    handler: (request: IncomingMessage, response: ServerResponse) => boolean | void | Promise<boolean | void>;
  };

  export type PluginServiceContext = {
    config: Record<string, unknown>;
    workspaceDir?: string;
    stateDir: string;
    logger: PluginLogger;
  };

  export type PluginService = {
    id: string;
    start: (context: PluginServiceContext) => void | Promise<void>;
    stop?: (context: PluginServiceContext) => void | Promise<void>;
  };

  export type PluginApi = {
    pluginConfig?: Record<string, unknown>;
    logger: PluginLogger;
    on<K extends keyof HookMap>(name: K, handler: HookMap[K], options?: {
      priority?: number;
      timeoutMs?: number;
    }): void;
    registerTrustedToolPolicy(policy: TrustedToolPolicy): void;
    registerHttpRoute(route: HttpRoute): void;
    registerService(service: PluginService): void;
  };

  export type PluginEntryOptions = {
    id: string;
    name: string;
    description: string;
    register(api: PluginApi): void;
  };

  export function definePluginEntry(options: PluginEntryOptions): PluginEntryOptions;
}
