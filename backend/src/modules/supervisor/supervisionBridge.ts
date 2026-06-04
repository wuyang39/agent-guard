import { createId } from "../../shared";
import type { AgentMcpBridge, ToolCallRequest } from "../agent/agentMcpBridge";
import type {
  JsonObject,
  JsonValue,
  PromptLoadPayload,
  ResourceAccessPayload,
  ToolResultPayload,
  RuntimeSupervisionRecord,
  SupervisionRuntimeAction,
  RuntimeActionPayload,
  SupervisionTargetType,
  RuntimeToolCallPayload,
  RuntimeFileWritePayload,
  RuntimeEmailSendPayload,
  RuntimeApiCallPayload,
  RuntimeResourceAccessPayload,
} from "@agent-guard/contracts";
import type { TraceRecorder } from "../monitor/traceRecorder";
import type { AgentSupervisor } from "./agentSupervisor";

export type SupervisionBridgeOptions = {
  baseBridge: AgentMcpBridge;
  supervisor: AgentSupervisor;
  recorder: TraceRecorder;
  runtimeSessionId: string;
  agentId: string;
};

const ACTION_PRIORITY: Record<string, number> = {
  deny: 5,
  ask: 4,
  redact: 3,
  warn: 2,
  allow: 1,
};

function highestAction(
  records: RuntimeSupervisionRecord[],
): RuntimeSupervisionRecord | null {
  if (records.length === 0) return null;
  return records.reduce((a, b) =>
    (ACTION_PRIORITY[a.action] ?? 0) >= (ACTION_PRIORITY[b.action] ?? 0) ? a : b,
  );
}

function mapTargetTypeForToolCall(toolId: string): SupervisionTargetType {
  switch (toolId) {
    case "tool.write_file":
      return "file_write";
    case "tool.send_email":
      return "email_send";
    case "tool.send_request":
    case "tool.call_api":
      return "api_call";
    default:
      return "tool_call";
  }
}

function buildRuntimePayload(
  targetType: SupervisionTargetType,
  request: ToolCallRequest,
): RuntimeActionPayload {
  const params = request.parameters;

  switch (targetType) {
    case "tool_call":
      return {
        toolId: request.toolId,
        toolName: request.toolName,
        parameters: request.parameters,
      } satisfies RuntimeToolCallPayload;

    case "file_write":
      return {
        path: typeof params.path === "string" ? params.path : "",
      } satisfies RuntimeFileWritePayload;

    case "email_send":
      return {
        to: Array.isArray(params.to) ? (params.to as string[]) : [],
        subject: typeof params.subject === "string" ? params.subject : "",
        bodyPreview:
          typeof params.bodyPreview === "string"
            ? params.bodyPreview
            : undefined,
      } satisfies RuntimeEmailSendPayload;

    case "api_call":
      return {
        method: typeof params.method === "string" ? params.method : "GET",
        url: typeof params.url === "string" ? params.url : "",
        data: typeof params.data === "string" ? params.data : undefined,
        headers:
          isJsonObject(params.headers) ? params.headers : undefined,
      } satisfies RuntimeApiCallPayload;

    default:
      return {
        toolId: request.toolId,
        toolName: request.toolName,
        parameters: request.parameters,
      } satisfies RuntimeToolCallPayload;
  }
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactRequestParameters(
  request: ToolCallRequest,
  _record: RuntimeSupervisionRecord,
): ToolCallRequest {
  const params: Record<string, JsonValue> = { ...request.parameters };

  // 对 bodyPreview 中匹配 "token" 的字段脱敏
  if (
    typeof params["bodyPreview"] === "string" &&
    (params["bodyPreview"] as string).includes("token")
  ) {
    params["bodyPreview"] = "[REDACTED]";
  }

  return { ...request, parameters: params as JsonObject };
}

export function createSupervisionBridge(
  opts: SupervisionBridgeOptions,
): AgentMcpBridge & { getRecords(): RuntimeSupervisionRecord[] } {
  const { baseBridge, supervisor, recorder, runtimeSessionId, agentId } = opts;
  const allRecords: RuntimeSupervisionRecord[] = [];

  // 构造时校验 defaultAction
  if (supervisor.policyPack.defaultAction !== "allow") {
    throw new Error(
      `SupervisionBridge: defaultAction must be "allow", got "${supervisor.policyPack.defaultAction}"`,
    );
  }

  return {
    getRecords() {
      return [...allRecords];
    },

    async handleToolCall(request: ToolCallRequest): Promise<ToolResultPayload> {
      const targetType = mapTargetTypeForToolCall(request.toolId);
      const runtimePayload = buildRuntimePayload(targetType, request);

      const action: SupervisionRuntimeAction = {
        runtimeSessionId,
        agentId,
        targetType,
        targetId: request.toolId,
        payload: runtimePayload,
      };

      const records = supervisor.preCheck(action);
      const decision = highestAction(records);

      if (!decision) {
        return baseBridge.handleToolCall(request);
      }

      allRecords.push(...records);

      switch (decision.action) {
        case "deny":
          recorder.record("system_error", "system", {
            code: "SUPERVISION_DENY",
            message: decision.decisionReason,
            detail: {
              policyId: decision.policyId,
              policyPackId: decision.policyPackId,
              targetType: decision.targetType,
            },
          });
          return {
            callId: createId("call"),
            toolId: request.toolId,
            result: {
              blocked: true,
              reason: "SUPERVISION_DENY",
              policyId: decision.policyId,
            },
            containsInjection: false,
            riskTagIds: [],
          };

        case "ask":
          // demo 固定确认通过
          return baseBridge.handleToolCall(request);

        case "redact": {
          const sanitized = redactRequestParameters(request, decision);
          return baseBridge.handleToolCall(sanitized);
        }

        case "warn":
        case "allow":
          return baseBridge.handleToolCall(request);

        default:
          return baseBridge.handleToolCall(request);
      }
    },

    async handleResourceAccess(
      resourceId: string,
    ): Promise<ResourceAccessPayload> {
      const targetType: SupervisionTargetType = "resource_access";
      const payload: RuntimeResourceAccessPayload = { resourceId };

      const action: SupervisionRuntimeAction = {
        runtimeSessionId,
        agentId,
        targetType,
        targetId: resourceId,
        payload,
      };

      const records = supervisor.preCheck(action);
      const decision = highestAction(records);

      if (!decision) {
        return baseBridge.handleResourceAccess(resourceId);
      }

      allRecords.push(...records);

      if (decision.action === "deny") {
        recorder.record("system_error", "system", {
          code: "SUPERVISION_DENY",
          message: decision.decisionReason,
          detail: {
            policyId: decision.policyId,
            policyPackId: decision.policyPackId,
            targetType: decision.targetType,
          },
        });
        return {
          resourceId,
          sensitivity: "secret",
          authorized: false,
          containsInjection: false,
          riskTagIds: [],
        };
      }

      return baseBridge.handleResourceAccess(resourceId);
    },

    async handlePromptLoad(
      promptId: string,
    ): Promise<PromptLoadPayload> {
      // handlePromptLoad 不进监督，直接转发
      return baseBridge.handlePromptLoad(promptId);
    },
  };
}
