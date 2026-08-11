import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAgentGuardPlugin } from "./controlRoutes";

export default definePluginEntry({
  id: "agent-guard-supervision",
  name: "Agent Guard Supervision",
  description: "Lease-scoped native tool policy enforcement for Agent Guard.",
  register: (api) => registerAgentGuardPlugin(api),
});
