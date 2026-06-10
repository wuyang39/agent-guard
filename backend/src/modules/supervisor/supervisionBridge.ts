import { createId } from "../../shared";
import type { SupervisionPolicy } from "../policy/policyTypes";
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
import { findMatchingPolicies } from "./policyEngine";
import { askChannel } from "./askChannel";

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

/**
 * 根据命中的 redact 策略的 matchers 脱敏 request.parameters。
 *
 * matcher.fieldPath 使用 runtime payload 路径：
 *   payload.parameters.X  → request.parameters["X"]  (tool_call)
 *   payload.X             → request.parameters["X"]  (file_write, email_send, api_call 等)
 *   payload.Y.Z           → request.parameters["Y"]["Z"]  (嵌套)
 *
 * 第一版实现：对 fieldPath 最终指向的字符串字段替换为 "[REDACTED]"。
 */
function redactRequestParameters(
  request: ToolCallRequest,
  targetType: SupervisionTargetType,
  policies: SupervisionPolicy[],
): ToolCallRequest {
  const redactPolicies = policies.filter((p) => p.action === "redact");
  if (redactPolicies.length === 0) return request;

  const params: Record<string, JsonValue> = { ...request.parameters };

  for (const policy of redactPolicies) {
    for (const matcher of policy.match.matchers ?? []) {
      const paramKey = resolveRequestParameterKey(matcher.fieldPath, targetType);
      if (paramKey && typeof params[paramKey] === "string") {
        params[paramKey] = "[REDACTED]";
      }
    }
  }

  return { ...request, parameters: params as JsonObject };
}

/**
 * 将 matcher.fieldPath (runtime payload 路径) 映射到 request.parameters 的 key。
 *
 * 映射规则：
 *   payload.parameters.X  → "X"      (tool_call 的嵌套参数)
 *   payload.X             → "X"      (file_write, email_send, api_call 的直接字段)
 *   其他                    → 最后一段作为 key
 */
function resolveRequestParameterKey(
  fieldPath: string,
  _targetType: SupervisionTargetType,
): string | null {
  // 去掉 "payload." 前缀
  const withoutPayload = fieldPath.startsWith("payload.")
    ? fieldPath.slice(8)
    : fieldPath;

  // 去掉 "parameters." 前缀（tool_call 场景）
  const key = withoutPayload.startsWith("parameters.")
    ? withoutPayload.slice(11)
    : withoutPayload;

  // 只支持一级 key，不支持嵌套
  return key.includes(".") ? null : key;
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

        case "ask": {
          // B-4 半真实 HITL: 创建 PendingAsk，等待人工确认或超时
          const matchedAskPolicies = findMatchingPolicies(supervisor.policyPack, action);
          const askPolicy = matchedAskPolicies[0] ?? decision;
          const pending = askChannel.create({
            runtimeSessionId,
            agentId,
            policyId: askPolicy.policyId,
            policyPackId: supervisor.policyPack.policyPackId,
            targetType: decision.targetType,
            targetId: request.toolId,
            payload: runtimePayload as Record<string, unknown>,
            reason: askPolicy.reason ?? decision.decisionReason,
            riskLevel: askPolicy.riskLevel ?? "medium",
          });

          const result = await askChannel.wait(pending.askId);

          if (result === "approved") {
            return baseBridge.handleToolCall(request);
          }
          // rejected 或 timeout → 阻断
          recorder.record("system_error", "system", {
            code: "SUPERVISION_ASK_REJECTED",
            message: `Ask ${pending.askId} was ${result}: ${askPolicy.reason}`,
            detail: { policyId: askPolicy.policyId, askId: pending.askId, result },
          });
          return {
            callId: createId("call"),
            toolId: request.toolId,
            result: { blocked: true, reason: `SUPERVISION_ASK_${result.toUpperCase()}`, policyId: askPolicy.policyId, askId: pending.askId },
            containsInjection: false,
            riskTagIds: [],
          };
        }

        case "redact": {
          const matchedPolicies = findMatchingPolicies(
            supervisor.policyPack,
            action,
          );
          const sanitized = redactRequestParameters(
            request,
            targetType,
            matchedPolicies,
          );
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
