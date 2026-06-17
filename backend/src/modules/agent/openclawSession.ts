/**
 * openclawSession — CLI execution + JSONL 解析
 *
 * 职责:
 *   1. 执行 openclaw agent --json CLI（采集真实行为）
 *   2. 解析 session JSONL → 提取 tool_call / tool_result
 *   3. 落盘原始 JSONL 作为证据链 artifact
 *
 * 注意: 本模块不做实时监督判定。CLI 检测只采集行为和证据；
 * PolicyPack 生成后由 OpenClaw realtime MCP 路径执行实时监督。
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createId } from "../../shared";
import type { AgentMcpBridge } from "./agentMcpBridge";
import type { AgentTask, JsonObject } from "@agent-guard/contracts";
import type {
  OpenClawAgentOutput,
  OpenClawJsonlEvent,
  ParsedSession,
  ParsedToolCall,
  ParsedToolResult,
} from "./openclawTypes";
import {
  buildOpenClawProcessEnv,
  resolveOpenClawCliInvocation,
  type OpenClawCliInvocation,
} from "./openclawAdapter";
import { isPathInsideDirectory } from "../../storage/pathSafety";

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

export type OpenClawRunOptions = {
  cliPath?: string;
  timeoutMs?: number;
};

function getOutputMeta(output: OpenClawAgentOutput) {
  return output.result?.meta ?? output.meta;
}

function getOutputPayloads(output: OpenClawAgentOutput) {
  return output.result?.payloads ?? output.payloads ?? [];
}

function getOutputSessionFile(output: OpenClawAgentOutput): string | undefined {
  return getOutputMeta(output)?.agentMeta?.sessionFile;
}

function getOutputSessionId(output: OpenClawAgentOutput): string {
  return getOutputMeta(output)?.agentMeta?.sessionId ?? "";
}

function getOutputFinalText(output: OpenClawAgentOutput): string {
  return (
    output.finalAssistantVisibleText ??
    output.finalAssistantRawText ??
    getOutputPayloads(output)[0]?.text ??
    ""
  );
}

/**
 * 执行一次 OpenClaw agent run，解析 JSONL。不做监督判定。
 */
// ---- OpenClaw tool name normalization ----

/** 剥离 tool. 前缀（OpenClaw JSONL 可能带或不带） */
function stripToolPrefix(name: string): string {
  return name.startsWith("tool.") ? name.slice(5) : name;
}

/** OpenClaw JSONL tool name → system canonical toolId */
export function normalizeOpenClawToolId(ocName: string): string {
  const base = stripToolPrefix(ocName);
  const canonical: Record<string, string> = {
    read_file:      "tool.read_file",
    read:           "tool.read_file",
    write_file:     "tool.write_file",
    write:          "tool.write_file",
    edit:           "tool.write_file",
    execute_code:   "tool.execute_code",
    exec:           "tool.execute_code",
    bash:           "tool.execute_code",
    process:        "tool.execute_code",
    send_email:     "tool.send_email",
    email:          "tool.send_email",
    call_api:       "tool.call_api",
    request:        "tool.call_api",
    fetch:          "tool.send_request",
    send_request:   "tool.send_request",
    web_search:     "tool.web_search",
    query_database: "tool.query_database",
    browser:        "tool.browser",
    navigate:       "tool.browser",
    glob:           "tool.read_file",
    message:        "tool.send_message",
  };
  return canonical[base] ?? `tool.${base}`;
}

/** OpenClaw JSONL tool name → SupervisionTargetType */
export function normalizeOpenClawTargetType(
  ocName: string,
): "tool_call" | "file_write" | "code_execution" | "email_send" | "api_call" {
  const base = stripToolPrefix(ocName);
  const mapped: Record<string, "file_write" | "code_execution" | "email_send" | "api_call"> = {
    write_file: "file_write", write: "file_write", edit: "file_write",
    execute_code: "code_execution", exec: "code_execution", bash: "code_execution", process: "code_execution",
    send_email: "email_send", email: "email_send",
    call_api: "api_call", request: "api_call", fetch: "api_call", send_request: "api_call",
  };
  return mapped[base] ?? "tool_call";
}

// ---- public API ----

export async function runOpenClawSession(
  task: AgentTask,
  bridge: AgentMcpBridge | undefined,
  runMeta: { runId: string; caseId: string; agentId: string },
  sandboxInfo: {
    tools: { toolId: string; toolName?: string; description?: string }[];
    resources: { resourceId: string; path?: string; sensitivity?: string; description?: string }[];
  },
  options: OpenClawRunOptions = {},
): Promise<OpenClawRunResult> {
  const sessionKey = runMeta.runId;
  const messageText = buildOpenClawMessage(task, sandboxInfo);
  const cli = resolveOpenClawCliInvocation(options.cliPath);

  // 1. 执行 openclaw agent --json
  const output = await spawnOpenClawAgent(sessionKey, messageText, options, cli);

  const sessionFile = getOutputSessionFile(output);
  if (output.status === "error" || !sessionFile) {
    throw new Error(
      `OpenClaw agent failed: ${output.error ?? output.summary ?? "unknown error"}`,
    );
  }

  // 2. 落盘原始 JSONL（证据链 artifact）
  const jsonlPath = await saveJsonlArtifact(
    sessionFile,
    runMeta.runId,
    resolveOpenClawDataDirs(cli.env),
  );

  // 3. 解析 JSONL → 提取 tool_call / tool_result
  const session = await parseSessionJsonl(jsonlPath, sessionKey, output);

  // 4. 通过 bridge 回放 tool calls → 写入 InteractionTrace
  if (bridge) {
    for (const tc of session.toolCalls) {
      const canonicalId = normalizeOpenClawToolId(tc.toolName);
      try {
        await bridge.handleToolCall({
          toolId: canonicalId,
          toolName: tc.toolName,  // 保留原始 OpenClaw 名作为 toolName
          parameters: tc.arguments as JsonObject,
        });
      } catch {
        // sandbox 不认识某些 tool，不影响 trace 采集
      }
    }
    // 回放 resource_access 事件
    for (const taskResourceId of task.resourceIds) {
      try { await bridge.handleResourceAccess(taskResourceId); } catch { /* ok */ }
    }
  }

  return { session, output, jsonlPath };
}

// ---- CLI execute ----

async function spawnOpenClawAgent(
  sessionKey: string,
  message: string,
  options: OpenClawRunOptions,
  cli: OpenClawCliInvocation,
): Promise<OpenClawAgentOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSec = String(Math.floor(timeoutMs / 1000));
  const args = [
    ...cli.argsPrefix,
    "agent",
    "--session-key",
    sessionKey,
    "--message",
    message,
    "--json",
    "--timeout",
    timeoutSec,
  ];

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(cli.command, args, {
      env: buildOpenClawProcessEnv(cli.env),
      windowsHide: true,
      shell: cli.shell,
    });
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        reject(new Error(`OpenClaw CLI timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs + 10_000);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(
        `Cannot execute OpenClaw CLI "${cli.displayPath}": ${error.message}. ` +
        `Check OPENCLAW_CLI env. stderr: ${stderr.slice(0, 300)}`,
      ));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;

      if (code !== 0 && stdout.trim().length === 0) {
        reject(new Error(
          `OpenClaw CLI "${cli.displayPath}" exited with code ${code ?? "unknown"}. ` +
          `stderr: ${stderr.slice(0, 300)}`,
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
    });
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
    sessionId: getOutputSessionId(output),
    sessionKey,
    toolCalls,
    toolResults,
    assistantMessages,
    finalAnswer: getOutputFinalText(output) ||
      (assistantMessages[assistantMessages.length - 1] ?? ""),
  };
}

// ---- JSONL artifact ----

/** 确定 OpenClaw 数据目录（用于 sessionFile 可信校验） */
function resolveOpenClawDataDirs(env: Record<string, string> | undefined): string[] {
  const roots = [
    env?.OPENCLAW_HOME,
    env?.OPENCLAW_STATE_DIR,
    process.env.OPENCLAW_HOME,
    process.env.OPENCLAW_STATE_DIR,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (!roots.length) {
    roots.push(path.join(os.homedir(), ".openclaw"));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function saveJsonlArtifact(
  sessionFile: string,
  runId: string,
  trustedDataDirs: string[],
): Promise<string> {
  // 可信目录校验：sessionFile 必须在 OpenClaw 数据目录内
  const resolved = path.resolve(sessionFile);
  if (!trustedDataDirs.some((dataDir) => isPathInsideDirectory(resolved, dataDir))) {
    throw new Error(
      `OpenClaw sessionFile is outside the trusted OpenClaw data directories (${trustedDataDirs.join(", ")}): ${sessionFile.slice(0, 200)}`,
    );
  }

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
