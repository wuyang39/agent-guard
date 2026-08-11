import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type { SupervisionPolicy } from "../policy/policyTypes";
import type {
  RuntimeSupervisionRecord,
  SupervisionRuntimeAction,
} from "./supervisorTypes";

export type SupervisionRecorderOptions = {
  createId?: (prefix: string) => string;
  now?: () => string;
};

export function recordSupervisionDecision(
  policyPackId: string,
  policy: SupervisionPolicy,
  action: SupervisionRuntimeAction,
  options: SupervisionRecorderOptions = {},
): RuntimeSupervisionRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    recordId: (options.createId ?? createId)("supervision_record"),
    runtimeSessionId: action.runtimeSessionId,
    agentId: action.agentId,
    policyPackId,
    policyId: policy.policyId,
    action: policy.action,
    decisionReason: policy.reason,
    targetType: action.targetType,
    targetId: action.targetId,
    inputEventId: action.inputEventId,
    gateway: action.gateway,
    createdAt: (options.now ?? nowIso)(),
  };
}
