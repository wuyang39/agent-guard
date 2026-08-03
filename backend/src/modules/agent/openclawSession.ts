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

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
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

const DEFAULT_TIMEOUT_MS = Number(process.env.OPENCLAW_TIMEOUT_MS ?? 300_000);
const MAX_CLI_OUTPUT_BYTES = 256 * 1024;
const MAX_JSONL_ARTIFACT_BYTES = 8 * 1024 * 1024;
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
  /** Per-run environment; never mutates process.env or the user's profile. */
  env?: Record<string, string | undefined>;
  gatewayUrl?: string;
  gatewayToken?: string;
  nativeGuardRequired?: boolean;
  signal?: AbortSignal;
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
    resolveOpenClawDataDirs({ ...cli.env, ...options.env }, !options.nativeGuardRequired),
  );

  // 3. 解析 JSONL → 提取 tool_call / tool_result
  const session = await parseSessionJsonl(jsonlPath, sessionKey, output);

  // 4. 通过 bridge 回放 tool calls → 写入 InteractionTrace
  await replayToolCallsToTrace(session, bridge);

  return { session, output, jsonlPath };
}

async function replayToolCallsToTrace(
  session: ParsedSession,
  bridge: AgentMcpBridge | undefined,
): Promise<void> {
  if (!bridge) return;
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
  // task.resourceIds 只是系统提供给 OpenClaw 的测试夹具说明，不代表
  // OpenClaw 实际访问了这些资源。这里不能回放成 resource_access，
  // 否则会把 fixture 输入误判成 Agent 的真实危险行为。
}

// ---- CLI execute ----

export async function spawnOpenClawAgent(
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
    if (options.signal?.aborted) {
      reject(new Error("OpenClaw CLI aborted."));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const childEnv = buildOpenClawProcessEnv(
      {
        ...cli.env,
        ...options.env,
        ...(options.gatewayUrl ? { OPENCLAW_GATEWAY_URL: options.gatewayUrl } : {}),
        ...(options.gatewayToken ? { OPENCLAW_GATEWAY_TOKEN: options.gatewayToken } : {}),
        AGENT_GUARD_NATIVE_REQUIRED: options.nativeGuardRequired ? "1" : "0",
      },
      !options.nativeGuardRequired,
    );
    const child = spawn(cli.command, args, {
      env: childEnv,
      windowsHide: true,
      shell: cli.shell,
      signal: options.signal,
      detached: Boolean(options.nativeGuardRequired && process.platform !== "win32"),
    });
    const abort = (): void => {
      terminateOpenClawProcessTree(child);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("OpenClaw CLI aborted."));
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      terminateOpenClawProcessTree(child);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`OpenClaw CLI timed out after ${timeoutMs}ms.`));
      }
    }, timeoutMs + 10_000);

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_CLI_OUTPUT_BYTES) {
        terminateOpenClawProcessTree(child);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("OpenClaw CLI output exceeded the size limit."));
        }
      }
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > MAX_CLI_OUTPUT_BYTES) {
        terminateOpenClawProcessTree(child);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("OpenClaw CLI error output exceeded the size limit."));
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      reject(new Error(
        `Cannot execute OpenClaw CLI "${cli.displayPath}": ${error.message}. ` +
        `Check OPENCLAW_CLI env. stderr: ${stderr.slice(0, 300)}`,
      ));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
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
export function resolveOpenClawDataDirs(
  env: Record<string, string | undefined> | undefined,
  inheritProcessEnv = true,
): string[] {
  const roots = [
    env?.OPENCLAW_HOME,
    env?.OPENCLAW_STATE_DIR,
    ...(inheritProcessEnv ? [process.env.OPENCLAW_HOME, process.env.OPENCLAW_STATE_DIR] : []),
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (!roots.length && inheritProcessEnv) {
    roots.push(path.join(os.homedir(), ".openclaw"));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function saveJsonlArtifact(
  sessionFile: string,
  runId: string,
  trustedDataDirs: string[],
): Promise<string> {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(runId)) {
    throw new Error("OpenClaw run id is invalid.");
  }
  const trustedRoots: string[] = [];
  for (const dataDir of trustedDataDirs) {
    trustedRoots.push(await assertNoSymlinkPath(dataDir, true));
  }
  const resolved = await assertNoSymlinkPath(sessionFile, false);
  if (!trustedRoots.some((dataDir) => isPathInsideDirectory(resolved, dataDir))) {
    throw new Error(
      `OpenClaw sessionFile is outside the trusted OpenClaw data directories (${trustedDataDirs.join(", ")}): ${sessionFile.slice(0, 200)}`,
    );
  }

  await assertNoSymlinkAncestors(JSONL_OUTPUT_DIR);
  await fs.mkdir(JSONL_OUTPUT_DIR, { recursive: true });
  const outputRoot = await assertNoSymlinkPath(JSONL_OUTPUT_DIR, true);
  const sourceName = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "session.jsonl";
  const dest = path.join(outputRoot, `${runId}_${sourceName}`);
  if (!isPathInsideDirectory(dest, outputRoot)) throw new Error("OpenClaw artifact path escaped output root.");
  const existingDest = await fs.lstat(dest).catch(() => undefined);
  if (existingDest?.isSymbolicLink() || (existingDest && !existingDest.isFile())) {
    throw new Error("OpenClaw artifact destination has an invalid file type.");
  }
  const preOpenStat = await fs.lstat(resolved);
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(resolved, fsConstants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("OpenClaw session artifact is not a regular file.");
    const postOpenStat = await fs.lstat(resolved);
    if (postOpenStat.isSymbolicLink() || !sameFileIdentity(preOpenStat, stat) || !sameFileIdentity(stat, postOpenStat)) {
      throw new Error("OpenClaw session artifact changed during validation.");
    }
    if (stat.size > MAX_JSONL_ARTIFACT_BYTES) throw new Error("OpenClaw session artifact exceeded the size limit.");
    const temporary = path.join(outputRoot, `.${path.basename(dest)}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      const destinationHandle = await fs.open(temporary, "wx", 0o600);
      try {
        await destinationHandle.writeFile(await handle.readFile());
      } finally {
        await destinationHandle.close();
      }
      await assertNoSymlinkAncestors(outputRoot);
      const currentDest = await fs.lstat(dest).catch(() => undefined);
      if (currentDest?.isSymbolicLink() || (currentDest && !currentDest.isFile())) {
        throw new Error("OpenClaw artifact destination changed during validation.");
      }
      await fs.rename(temporary, dest);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  } finally {
    await handle.close();
  }
  return dest;
}

function terminateOpenClawProcessTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const systemRoot = process.env.SystemRoot;
    const taskkillPath = systemRoot && path.win32.isAbsolute(systemRoot)
      ? path.win32.join(systemRoot, "System32", "taskkill.exe")
      : "C:\\Windows\\System32\\taskkill.exe";
    try {
      spawnSync(taskkillPath, ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, shell: false, stdio: "ignore", timeout: 2_000 });
    } catch { /* fall through to direct kill */ }
  } else if (child.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* process group may already be gone */ }
  }
  try { child.kill(process.platform === "win32" ? undefined : "SIGKILL"); } catch { /* child may already be closed */ }
}

async function assertNoSymlinkPath(target: string, directory: boolean): Promise<string> {
  const resolved = path.resolve(target);
  const root = path.parse(resolved).root;
  let current = root;
  const rest = resolved.slice(root.length).split(path.sep).filter(Boolean);
  for (const segment of rest) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("OpenClaw artifact path contains a symlink.");
  }
  const stat = await fs.lstat(resolved);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("OpenClaw artifact path has an invalid file type.");
  return await fs.realpath(resolved);
}

async function assertNoSymlinkAncestors(target: string): Promise<void> {
  let current = path.resolve(target);
  const root = path.parse(current).root;
  while (current.length >= root.length) {
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat?.isSymbolicLink()) throw new Error("OpenClaw artifact path contains a symlink.");
    if (current === root) break;
    current = path.dirname(current);
  }
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.size === right.size && left.birthtimeMs === right.birthtimeMs && left.mtimeMs === right.mtimeMs;
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
  const relevantResources = task.resourceIds.length
    ? sandbox.resources.filter((resource) => task.resourceIds.includes(resource.resourceId))
    : [];
  if (relevantResources.length > 0) {
    parts.push(`Available resources: ${relevantResources.map((r) => r.resourceId).join(", ")}.`);
  }
  return parts.join(" ");
}
