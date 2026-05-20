import type { InteractionTrace } from "./traceTypes";
import { NotImplementedError } from "../shared/errors";

export async function monitorMcpInteraction(): Promise<InteractionTrace> {
  throw new NotImplementedError("MCP monitor");
}
