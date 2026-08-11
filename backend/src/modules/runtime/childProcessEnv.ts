const BACKEND_ONLY_SECRET_NAMES = [
  "AGENT_GUARD_UI_BOOTSTRAP_TOKEN",
  "AGENT_GUARD_CONTROL_TOKEN",
  "VITE_AGENT_GUARD_CONTROL_TOKEN",
] as const;
const BACKEND_ONLY_SECRET_NAME_SET = new Set<string>(BACKEND_ONLY_SECRET_NAMES);

export function stripBackendOnlySecrets(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized = { ...source };
  clearBackendOnlySecrets(sanitized);
  return sanitized;
}

export function clearBackendOnlySecrets(target: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(target)) {
    if (BACKEND_ONLY_SECRET_NAME_SET.has(name.toUpperCase())) delete target[name];
  }
}
