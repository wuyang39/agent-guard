const BACKEND_ONLY_SECRET_NAMES = [
  "AGENT_GUARD_UI_BOOTSTRAP_TOKEN",
  "AGENT_GUARD_CONTROL_TOKEN",
  "VITE_AGENT_GUARD_CONTROL_TOKEN",
] as const;

export function stripBackendOnlySecrets(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...source };
  clearBackendOnlySecrets(sanitized);
  return sanitized;
}

export function clearBackendOnlySecrets(target: NodeJS.ProcessEnv): void {
  for (const name of BACKEND_ONLY_SECRET_NAMES) delete target[name];
}
