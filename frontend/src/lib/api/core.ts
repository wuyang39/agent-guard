import type { ApiResponse } from "./types";

const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

const defaultBaseUrl = "http://127.0.0.1:3100";

export const apiBaseUrl = viteEnv.VITE_AGENT_GUARD_API_BASE ?? defaultBaseUrl;
export const defaultOpenClawCliPath = viteEnv.VITE_OPENCLAW_CLI_PATH ?? "";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json()) as ApiResponse<T>;

  if (!payload.ok) {
    throw new ApiRequestError(
      payload.error.message,
      payload.error.code,
      response.status,
    );
  }

  return payload.data;
}
