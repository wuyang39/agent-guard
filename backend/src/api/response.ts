import { createId } from "../shared/ids";

export type ApiResponse<T> = {
  ok: boolean;
  data?: T;
  error?: ApiError;
  requestId: string;
};

export type ApiError = {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
};

export function success<T>(data: T): ApiResponse<T> {
  return {
    ok: true,
    data,
    requestId: createId("req"),
  };
}

export function failure(code: string, message: string, detail?: Record<string, unknown>): ApiResponse<never> {
  return {
    ok: false,
    error: { code, message, detail },
    requestId: createId("req"),
  };
}
