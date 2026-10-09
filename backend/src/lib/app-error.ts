/**
 * Stable, backwards-compatible API error contract.
 *
 * Legacy clients still read `error` and `code`. Never expose raw exception
 * details, credentials or storage paths to a remote client.
 */
export type PublicErrorDetails = Record<string, string | number | boolean | null>;

export interface ApiErrorPayload {
  error: string;
  code: string;
  requestId: string;
  retryable: boolean;
  details?: PublicErrorDetails;
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: PublicErrorDetails;

  constructor(code: string, message: string, options: {
    status?: number;
    retryable?: boolean;
    details?: PublicErrorDetails;
    cause?: unknown;
  } = {}) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    if (!ERROR_CODE_PATTERN.test(code)) throw new TypeError("Invalid application error code");
    this.code = code;
    this.status = options.status ?? 500;
    if (!Number.isInteger(this.status) || this.status < 400 || this.status > 599) {
      throw new RangeError("Invalid application error status");
    }
    this.retryable = options.retryable ?? (this.status === 408 || this.status === 429 || this.status >= 500);
    this.details = options.details;
  }
}

export function toPublicApiError(error: unknown, requestId: string): {
  payload: ApiErrorPayload;
  status: number;
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      payload: {
        error: error.message,
        code: error.code,
        requestId,
        retryable: error.retryable,
        ...(error.details ? { details: error.details } : {}),
      },
    };
  }
  // A thrown SyntaxError, database exception or unexpected error must not leak
  // SQL, file paths, secrets or stack traces into the API response.
  return {
    status: 500,
    payload: {
      error: "服务器内部错误，请稍后重试",
      code: "SYSTEM_INTERNAL_ERROR",
      requestId,
      retryable: true,
    },
  };
}

/** Log metadata only; never serialize arbitrary error messages or stacks. */
export function safeErrorLog(error: unknown, requestId: string, status: number, code: string): string {
  const name = error instanceof Error ? error.name : typeof error;
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level: "ERROR",
    event: "http.request.failed",
    module: "http",
    requestId,
    code,
    httpStatus: status,
    errorName: /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(name) ? name : "UnknownError",
  });
}
