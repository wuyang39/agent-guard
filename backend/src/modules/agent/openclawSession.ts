/**
 * openclawSession — CLI execution + JSONL 解析
 *
 * 职责:
 *   1. 执行 openclaw agent --json CLI（采集真实行为）
 *   2. 解析 session JSONL → 提取 tool_call / tool_result
 *   3. 落盘原始 JSONL 作为证据链 artifact
 *
 * 注意: 本模块不做监督判定。监督判定在 e2eRunService 中，
 * PolicyPack 生成后用真实策略做 post-hoc replay。
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createId } from "../../shared";
import type { AgentTask } from "@agent-guard/contracts";
import type {
  OpenClawAgentOutput,
  OpenClawJsonlEvent,
  ParsedSession,
  ParsedToolCall,
  ParsedToolResult,
} from "./openclawTypes";

const DEFAULT_CLI = process.env.OPENCLAW_CLI ?? "openclaw";
const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_TIMEOUT_MS ?? 120_000);
const JSONL_OUTPUT_DIR = path.resolve(
  process.cwd(),
  "outputs",
  "openclaw-sessions",
);

export type OpenClawRunResult = {
  session: ParsedSession;
  output: OpenClawAgentOutput;
  jsonlPath: string;
};

/**
 * 执行一次 OpenClaw agent run，解析 JSONL。不做监督判定。
 */
export async function runOpenClawSession(
  task: AgentTask,
  runMeta: { runId: string; caseId: string; agentId: string },
  sandboxInfo: {
    tools: { toolId: string; toolName?: string; description?: string }[];
    resources: { resourceId: string; path?: string; sensitivity?: string; description?: string }[];
  },
): Promise<OpenClawRunResult> {
  const sessionKey = runMeta.runId;
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

  return { session, output, jsonlPath };
}

// ---- CLI execute ----

async function spawnOpenClawAgent(
  sessionKey: string,
  message: string,
): Promise<OpenClawAgentOutput> {
  // 转义 message: shell 双引号内仍需处理的特殊字符
  const escaped = message
    .replace(/"/g, '\\"')
    .replace(/%/g, "%%")
    .replace(/&/g, "^&")
    .replace(/</g, "^<")
    .replace(/>/g, "^>")
    .replace(/\|/g, "^|");
  const timeoutSec = String(Math.floor(DEFAULT_TIMEOUT_MS / 1000));
  const cmd = `"${DEFAULT_CLI}" agent --session-key "${sessionKey}" --message "${escaped}" --json --timeout ${timeoutSec}`;

  return new Promise((resolve, reject) => {
    exec(cmd, { env: { ...process.env }, timeout: DEFAULT_TIMEOUT_MS + 10_000 },
      (error, stdout, stderr) => {
        if (error && stdout.trim().length === 0) {
          reject(new Error(
            `Cannot execute OpenClaw CLI "${DEFAULT_CLI}": ${error.message}. ` +
            `Check OPENCLAW_CLI env. stderr: ${stderr.slice(0, 300)}`,
          ));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as OpenClawAgentOutput);
        } catch {
          if (stdout.trim()) {
            resolve({
              runId: createId("oc_run"),
              status: "ok",
              summary: "completed",
              result: { payloads: [{ text: stdout.trim(), mediaUrl: null }] },
            });
          } else {
            reject(new Error(`OpenClaw empty output. stderr: ${stderr.slice(0, 300)}`));
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
      toolResults.push({
        callId: event.message.toolCallId ?? "",
        toolName: event.message.toolName ?? "unknown",
        isError: event.message.isError ?? false,
        text: (event.message.content ?? [])
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
        timestamp: event.timestamp,
      });
    }
  }

  return {
    sessionId: output.result?.meta?.agentMeta?.sessionId ?? "",
    sessionKey,
    toolCalls,
    toolResults,
    assistantMessages,
    finalAnswer: output.result?.payloads?.[0]?.text ??
      assistantMessages[assistantMessages.length - 1] ?? "",
  };
}

// ---- JSONL artifact ----

async function saveJsonlArtifact(sessionFile: string, runId: string): Promise<string> {
  await fs.mkdir(JSONL_OUTPUT_DIR, { recursive: true });
  const dest = path.join(JSONL_OUTPUT_DIR, `${runId}_${path.basename(sessionFile)}`);
  await fs.copyFile(sessionFile, dest);
  return dest;
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
    parts.push(`Available tools: ${sandbox.tools.map((t) => t.toolId).join(", ")}.`);
  }
  if (sandbox.resources.length > 0) {
    parts.push(`Available resources: ${sandbox.resources.map((r) => r.resourceId).join(", ")}.`);
  }
  return parts.join(" ");
}
