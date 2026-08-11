import type { ToolEvent } from "openclaw/plugin-sdk/plugin-entry";

export type NativeToolRisk = "low" | "high" | "unknown";

const LOW_RISK_EMPTY_PARAM_TOOLS = new Set([
  "session_status",
]);

const HIGH_RISK_TOOLS = new Set([
  "apply_patch",
  "browser",
  "browser_navigate",
  "call_api",
  "canvas",
  "cmd",
  "code_execution",
  "code_mode_exec",
  "create_file",
  "cron",
  "curl",
  "delete_file",
  "edit",
  "edit_file",
  "exec",
  "execute_code",
  "execute_command",
  "fetch",
  "file_write",
  "gateway",
  "http_request",
  "message",
  "network",
  "nodes",
  "patch",
  "process",
  "powershell",
  "run_command",
  "send_request",
  "shell",
  "web_fetch",
  "web_search",
  "write",
  "write_file",
]);

export function classifyToolRisk(event: Pick<
  ToolEvent,
  "toolName" | "toolKind" | "toolInputKind" | "params" | "derivedPaths"
>): NativeToolRisk {
  if (
    event.toolKind === "code_mode_exec" ||
    event.toolInputKind === "javascript" ||
    event.toolInputKind === "typescript"
  ) {
    return "high";
  }
  if (HIGH_RISK_TOOLS.has(event.toolName)) return "high";
  if (!LOW_RISK_EMPTY_PARAM_TOOLS.has(event.toolName)) return "unknown";
  if (!isPlainRecord(event.params) || Object.keys(event.params).length !== 0) return "high";
  if (event.derivedPaths !== undefined && event.derivedPaths.length !== 0) return "high";
  return "low";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
