import type { TestContext } from "@agent-guard/contracts";
import {
  createMcpSandboxForContext,
  type McpSandboxRuntime,
} from "./mcpSandbox";

export function createMockMcpSandboxRuntime(
  context: TestContext,
): McpSandboxRuntime {
  return createMcpSandboxForContext(context);
}
