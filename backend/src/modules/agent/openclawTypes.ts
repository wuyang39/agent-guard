/**
 * openclawTypes — OpenClaw JSONL 事件私有类型
 *
 * 不入 contracts。仅 openclawSession.ts 内部使用。
 */

/** openclaw agent --json 的 stdout 输出 */
export type OpenClawAgentOutput = {
  runId?: string;
  status?: "ok" | "error";
  summary?: string;
  result?: {
    payloads?: { text: string; mediaUrl: string | null }[];
    meta?: OpenClawRunMeta;
  };
  payloads?: { text: string; mediaUrl: string | null }[];
  meta?: OpenClawRunMeta;
  finalAssistantVisibleText?: string;
  finalAssistantRawText?: string;
  error?: string;
};

export type OpenClawRunMeta = {
  durationMs: number;
  agentMeta: {
    sessionId: string;
    sessionFile: string;
    provider: string;
    model: string;
    usage?: OpenClawUsage;
    sandbox?: { mode: string; sandboxed: boolean };
  };
  aborted: boolean;
};

export type OpenClawUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  total: number;
};

/** Session JSONL 的单行事件 */
export type OpenClawJsonlEvent = {
  type: "message" | "custom" | "status";
  id: string;
  parentId?: string;
  timestamp: string;
  message?: OpenClawMessage;
  customType?: string;
  data?: Record<string, unknown>;
};

export type OpenClawMessage = {
  role: "user" | "assistant" | "toolResult" | "system";
  content?: OpenClawContent[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: Record<string, unknown>;
};

export type OpenClawContent =
  | OpenClawTextContent
  | OpenClawThinkingContent
  | OpenClawToolCallContent;

export type OpenClawTextContent = {
  type: "text";
  text: string;
};

export type OpenClawThinkingContent = {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
};

export type OpenClawToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/** 从 JSONL 提取的结构化结果 */
export type ParsedSession = {
  sessionId: string;
  sessionKey: string;
  toolCalls: ParsedToolCall[];
  toolResults: ParsedToolResult[];
  assistantMessages: string[];
  finalAnswer: string;
};

export type ParsedToolCall = {
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timestamp: string;
  parentId?: string;
};

export type ParsedToolResult = {
  callId: string;
  toolName: string;
  isError: boolean;
  text: string;
  timestamp: string;
};

/** Shadow supervision record — 事后影子判定 */
export type ShadowSupervisionMeta = {
  mode: "post_hoc";
  wouldAction: string;
  reason: string;
  originalToolCall: ParsedToolCall;
};
