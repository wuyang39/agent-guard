import type {
  JsonObject,
  JsonValue,
  ToolProviderType,
  ToolResultPayload,
} from "@agent-guard/contracts";
import { createId } from "../../shared";
import { getResolvedRuntimeDownstreamMcpSettings } from "../runtime/runtimeSettings";

export type DownstreamMcpTool = {
  originalToolName: string;
  canonicalToolId: string;
  description: string;
  inputSchema: JsonObject;
};

export type DownstreamMcpProvider = {
  providerId: string;
  providerName: string;
  providerType: ToolProviderType;
  listTools(): Promise<DownstreamMcpTool[]>;
  callTool(originalToolName: string, args: JsonObject): Promise<ToolResultPayload>;
};

type JsonRpcResponse<T> = {
  jsonrpc?: "2.0";
  id?: string | number | null;
  result?: T;
  error?: { code?: number; message?: string; data?: JsonValue };
};

type McpToolListResult = {
  tools?: {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
  }[];
};

type McpToolCallResult = {
  content?: { type?: unknown; text?: unknown }[];
  isError?: boolean;
  [key: string]: unknown;
};

export function createHttpMcpDownstreamProvider(input: {
  providerId: string;
  providerName: string;
  endpointUrl: string;
  timeoutMs?: number;
}): DownstreamMcpProvider {
  return {
    providerId: input.providerId,
    providerName: input.providerName,
    providerType: "mcp",

    async listTools(): Promise<DownstreamMcpTool[]> {
      const result = await callJsonRpc<McpToolListResult>(
        input.endpointUrl,
        "tools/list",
        {},
        input.timeoutMs,
      );
      return (result.tools ?? [])
        .filter((tool): tool is Required<McpToolListResult>["tools"][number] & { name: string } =>
          typeof tool.name === "string" && tool.name.length > 0,
        )
        .map((tool) => ({
          originalToolName: tool.name,
          canonicalToolId: buildExternalCanonicalToolId(input.providerId, tool.name),
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: isJsonObject(tool.inputSchema) ? tool.inputSchema : {},
        }));
    },

    async callTool(originalToolName: string, args: JsonObject): Promise<ToolResultPayload> {
      const result = await callJsonRpc<McpToolCallResult>(
        input.endpointUrl,
        "tools/call",
        { name: originalToolName, arguments: args },
        input.timeoutMs,
      );
      return {
        callId: createId("call"),
        toolId: buildExternalCanonicalToolId(input.providerId, originalToolName),
        result: normalizeMcpToolCallResult(result),
        containsInjection: false,
        riskTagIds: [],
      };
    },
  };
}

export function createEnvDownstreamMcpProviders(): DownstreamMcpProvider[] {
  const providers: DownstreamMcpProvider[] = [];
  const settings = getResolvedRuntimeDownstreamMcpSettings();
  if (!settings.enabled || !settings.endpointUrl) return providers;

  providers.push(
    createHttpMcpDownstreamProvider({
      providerId: settings.providerId,
      providerName: settings.providerName,
      endpointUrl: settings.endpointUrl,
      timeoutMs: settings.timeoutMs,
    }),
  );

  return providers;
}

export function buildExternalCanonicalToolId(providerId: string, toolName: string): string {
  return `tool.external.${safeId(providerId)}.${safeId(toolName)}`;
}

async function callJsonRpc<T>(
  endpointUrl: string,
  method: string,
  params: JsonObject,
  timeoutMs = 5000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: createId("rpc"), method, params }),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as JsonRpcResponse<T>) : {};
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
    }
    if (parsed.error) {
      throw new Error(parsed.error.message ?? `JSON-RPC error for ${method}`);
    }
    if (parsed.result === undefined) {
      throw new Error(`JSON-RPC ${method} returned no result.`);
    }
    return parsed.result;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Downstream MCP ${method} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeMcpToolCallResult(result: McpToolCallResult): JsonValue {
  let text: string | undefined;
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      text = item.text;
      break;
    }
  }
  if (text) {
    try {
      return JSON.parse(text) as JsonValue;
    } catch {
      return { text };
    }
  }
  return JSON.parse(JSON.stringify(result)) as JsonValue;
}

function safeId(value: string): string {
  return value
    .replace(/^tool[._-]/i, "tool_")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "unknown";
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
