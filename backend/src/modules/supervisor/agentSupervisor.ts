import type { SupervisionPolicyPack } from "../policy/policyTypes";
import { findMatchingPolicies } from "./policyEngine";
import { recordSupervisionDecision } from "./supervisionRecorder";
import type {
  RuntimeSupervisionRecord,
  SupervisionRuntimeAction,
} from "./supervisorTypes";

export type AgentSupervisor = {
  policyPack: SupervisionPolicyPack;
  preCheck(action: SupervisionRuntimeAction): RuntimeSupervisionRecord[];
};

export function createAgentSupervisor(
  policyPack: SupervisionPolicyPack,
): AgentSupervisor {
  return {
    policyPack,
    preCheck(action) {
      return findMatchingPolicies(policyPack, action).map((policy) =>
        recordSupervisionDecision(policyPack.policyPackId, policy, action),
      );
    },
  };
}
