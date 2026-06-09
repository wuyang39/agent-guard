/**
 * openclawSession — CLI spawn + JSONL 解析 + shadow supervision
 *
 * 职责:
 *   1. spawn("openclaw", ["agent", "--json", ...]) 执行任务
 *   2. 解析 session JSONL → 提取 tool_call / tool_result
 *   3. 对每个 tool_call 做影子 sandbox + supervision 判定
 *   4. 构建 InteractionTrace events + shadow supervision records
 *
 * 约束:
 *   - 使用真实 openclaw agent --json CLI，不伪造 REST API
 *   - 原始 JSONL 落盘作为证据链 artifact
 *   - 监督结果标注 post_hoc / shadow
 *   - deny/ask 语义为 would_deny / would_ask
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createId, nowIso } from "../../shared";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type {
  AgentTask,
  JsonObject,
  RuntimeSupervisionRecord,
} from "@agent-guard/contracts";
import type {
  OpenClawAgentOutput,
  OpenClawJsonlEvent,
  ParsedSession,
  ParsedToolCall,
  ParsedToolResult,
  ShadowSupervisionMeta,
} from "./openclawTypes";

const DEFAULT_CLI = process.env.OPENCLAW_CLI ?? "openclaw";
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_TIMEOUT_MS ?? 120_000);
const JSONL_OUTPUT_DIR = path.resolve(
  process.cwd(),
  "outputs",
  "openclaw-sessions",
);

// ---- public API ----

export type OpenClawRunResult = {
  session: ParsedSession;
  output: OpenClawAgentOutput;
  jsonlPath: string;
  /** Shadow supervision records (post-hoc, 非实时阻断) */
  shadowRecords: RuntimeSupervisionRecord[];
};

/**
 * 执行一次 OpenClaw agent run，解析 JSONL，做影子监督。
 */
export async function runOpenClawSession(
  task: AgentTask,
  bridge: AgentMcpBridge,
  runMeta: { runId: string; caseId: string; agentId: string },
  sandboxInfo: {
    tools: { toolId: string; toolName?: string; description?: string }[];
    resources: { resourceId: string; path?: string; sensitivity?: string; description?: string }[];
  },
): Promise<OpenClawRunResult> {
  const sessionKey = `agent:main:agent-guard-${runMeta.runId}`;
  const messageText = buildOpenClawMessage(task, sandboxInfo);

  // 1. 执行 openclaw agent --json
  const output = await spawnOpenClawAgent(sessionKey, messageText);

  if (output.status === "error" || !output.result?.meta?.agentMeta?.sessionFile) {
    throw new Error(
      `OpenClaw agent failed: ${output.error ?? output.summary ?? "unknown error"}`,
    );
  }

  const sessionFile = output.result.meta.agentMeta.sessionFile;

  // 2. 落盘原始 JSONL（证据链 artifact）
  const jsonlPath = await saveJsonlArtifact(sessionFile, runMeta.runId);

  // 3. 解析 JSONL → 提取 tool_call / tool_result
  const session = await parseSessionJsonl(sessionFile, sessionKey, output);

  // 4. 影子监督: 对每个 tool_call 跑 sandbox + supervision
  const shadowRecords: RuntimeSupervisionRecord[] = [];
  for (const tc of session.toolCalls) {
    const meta: ShadowSupervisionMeta = {
      mode: "post_hoc",
      wouldAction: "allow",
      reason: "",
      originalToolCall: tc,
    };

    try {
      // 影子 sandbox 执行
      const result = await bridge.handleToolCall({
        toolId: tc.toolName,
        toolName: tc.toolName,
        parameters: tc.arguments as JsonObject,
      });

      // 检查 sandbox 返回中是否有阻断标记
      const blocked = (result.result as Record<string, unknown>)?.blocked === true;
      if (blocked) {
        meta.wouldAction = "would_deny";
        meta.reason =
          ((result.result as Record<string, unknown>)?.reason as string) ??
          "Shadow supervision: sandbox would have blocked this action";
      }

      // 记录 shadow record
      shadowRecords.push(buildShadowRecord(runMeta, tc, meta));
    } catch (err) {
      meta.wouldAction = "would_deny";
      meta.reason = `Shadow supervision error: ${err instanceof Error ? err.message : String(err)}`;
      shadowRecords.push(buildShadowRecord(runMeta, tc, meta));
    }
  }

  return { session, output, jsonlPath, shadowRecords };
}

// ---- CLI spawn ----

async function spawnOpenClawAgent(
  sessionKey: string,
  message: string,
): Promise<OpenClawAgentOutput> {
  // 转义 message 中的特殊字符（Windows cmd 需要双引号转义）
  const escaped = message
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%"); // Windows cmd % 转义
  const timeoutSec = String(Math.floor(DEFAULT_TIMEOUT_MS / 1000));
  const cmd = `"${DEFAULT_CLI}" agent --session-key "${sessionKey}" --message "${escaped}" --json --timeout ${timeoutSec}`;

  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { env: { ...process.env }, timeout: DEFAULT_TIMEOUT_MS + 10_000 },
      (error, stdout, stderr) => {
        if (error && stdout.trim().length === 0) {
          reject(
            new Error(
              `Cannot execute OpenClaw CLI "${DEFAULT_CLI}": ${error.message}. ` +
                `Check that OpenClaw is installed and OPENCLAW_CLI env is set correctly. ` +
                `stderr: ${stderr.slice(0, 300)}`,
            ),
          );
          return;
        }

        try {
          const output = JSON.parse(stdout.trim()) as OpenClawAgentOutput;
          resolve(output);
        } catch {
          if (stdout.trim()) {
            resolve({
              runId: createId("oc_run"),
              status: "ok",
              summary: "completed",
              result: {
                payloads: [{ text: stdout.trim(), mediaUrl: null }],
              },
            });
          } else {
            reject(
              new Error(
                `OpenClaw CLI returned empty output. stderr: ${stderr.slice(0, 300)}`,
              ),
            );
          }
        }
      },
    );
  });
}

// ---- JSONL 解析 ----

async function parseSessionJsonl(
  sessionFile: string,
  sessionKey: string,
  output: OpenClawAgentOutput,
): Promise<ParsedSession> {
  const raw = await fs.readFile(sessionFile, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const events: OpenClawJsonlEvent[] = lines.map((line) => JSON.parse(line));

  const toolCalls: ParsedToolCall[] = [];
  const toolResults: ParsedToolResult[] = [];
  const assistantMessages: string[] = [];

  for (const event of events) {
    if (event.type !== "message" || !event.message) continue;

    const content = event.message.content ?? [];

    for (const c of content) {
      if (c.type === "toolCall") {
        toolCalls.push({
          callId: c.id,
          toolName: c.name,
          arguments: c.arguments,
          timestamp: event.timestamp,
          parentId: event.parentId,
        });
      } else if (c.type === "text" && event.message.role === "assistant") {
        assistantMessages.push(c.text);
      }
    }

    if (event.message.role === "toolResult") {
      const text = (event.message.content ?? [])
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      toolResults.push({
        callId: event.message.toolCallId ?? "",
        toolName: event.message.toolName ?? "unknown",
        isError: event.message.isError ?? false,
        text,
        timestamp: event.timestamp,
      });
    }
  }

  const finalAnswer =
    output.result?.payloads?.[0]?.text ??
    assistantMessages[assistantMessages.length - 1] ??
    "";

  return {
    sessionId: output.result?.meta?.agentMeta?.sessionId ?? "",
    sessionKey,
    toolCalls,
    toolResults,
    assistantMessages,
    finalAnswer,
  };
}

// ---- JSONL artifact ----

async function saveJsonlArtifact(
  sessionFile: string,
  runId: string,
): Promise<string> {
  await fs.mkdir(JSONL_OUTPUT_DIR, { recursive: true });
  const dest = path.join(
    JSONL_OUTPUT_DIR,
    `${runId}_${path.basename(sessionFile)}`,
  );
  await fs.copyFile(sessionFile, dest);
  return dest;
}

// ---- shadow record ----

function buildShadowRecord(
  runMeta: { runId: string; caseId: string; agentId: string },
  tc: ParsedToolCall,
  meta: ShadowSupervisionMeta,
): RuntimeSupervisionRecord {
  return {
    schemaVersion: "mvp-1",
    recordId: createId("shadow_rec"),
    runtimeSessionId: `shadow_session.${runMeta.runId}`,
    agentId: runMeta.agentId,
    policyPackId: "post_hoc", // 影子模式 — 非实时 policy pack
    policyId: "post_hoc",
    action: meta.wouldAction as RuntimeSupervisionRecord["action"],
    decisionReason: `[SHADOW/POST-HOC] ${meta.reason} (tool: ${tc.toolName}, callId: ${tc.callId})`.slice(0, 500),
    targetType: "tool_call",
    targetId: tc.toolName,
    inputEventId: tc.callId,
    createdAt: nowIso(),
  };
}

// ---- task → OpenClaw message ----

function buildOpenClawMessage(
  task: AgentTask,
  sandbox: {
    tools: { toolId: string; toolName?: string; description?: string }[];
    resources: { resourceId: string; path?: string; sensitivity?: string; description?: string }[];
  },
): string {
  const parts: string[] = [task.instruction];

  if (sandbox.tools.length > 0) {
    const toolNames = sandbox.tools.map((t) => t.toolId).join(", ");
    parts.push(`Available tools: ${toolNames}.`);
  }

  if (sandbox.resources.length > 0) {
    const resourceNames = sandbox.resources.map((r) => r.resourceId).join(", ");
    parts.push(`Available resources: ${resourceNames}.`);
  }

  // 单行格式——CLI --message 不接受多行文本（Windows shell 会截断）
  return parts.join(" ");
}
