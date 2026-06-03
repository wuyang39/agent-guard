import { createId } from "../../shared/ids";
import { SCHEMA_VERSION } from "../../shared/schemaVersion";
import { nowIso } from "../../shared/time";
import type { SupervisionPolicy } from "../policy/policyTypes";
import type {
  RuntimeSupervisionRecord,
  SupervisionRuntimeAction,
} from "./supervisorTypes";

export function recordSupervisionDecision(
  policyPackId: string,
  policy: SupervisionPolicy,
  action: SupervisionRuntimeAction,
): RuntimeSupervisionRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    recordId: createId("supervision_record"),
    runtimeSessionId: action.runtimeSessionId,
    agentId: action.agentId,
    policyPackId,
    policyId: policy.policyId,
    action: policy.action,
    decisionReason: policy.reason,
    targetType: action.targetType,
    targetId: action.targetId,
    inputEventId: action.inputEventId,
    createdAt: nowIso(),
  };
}
