import type { McpSandboxProfile } from "./sandboxTypes";

export type McpSandbox = {
  profile: McpSandboxProfile;
};

export function createMcpSandbox(profile: McpSandboxProfile): McpSandbox {
  return { profile };
}
