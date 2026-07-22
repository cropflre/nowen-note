export const IMAGE_HOSTING_POLICY_TIMEOUT_MS = 4_000;
export const IMAGE_HOSTING_UPLOAD_TIMEOUT_MS = 12_000;
export const LOCAL_ATTACHMENT_UPLOAD_TIMEOUT_MS = 20_000;

export type UploadErrorCode =
  | "OFFLINE"
  | "UPLOAD_TIMEOUT"
  | "UPLOAD_ABORTED"
  | "HTTP_ERROR"
  | "NETWORK_ERROR";

export class UploadRequestError extends Error {
  readonly code: UploadErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      code: UploadErrorCode;
      status?: number;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "UploadRequestError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? true;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export function isLoopbackServerUrl(value: string): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost"
      || hostname === "0.0.0.0"
      || hostname === "::1"
      || hostname === "[::1]"
      || hostname.startsWith("127.");
  } catch {
    return false;
  }
}

export function isElectronFullLocalRuntime(
  serverUrl: string,
  isDesktop: boolean,
): boolean {
  if (!isDesktop) return false;
  // Full mode injects a loopback URL. During the earliest renderer startup the query value may
  // not have been migrated into storage yet, so an empty URL is also local only on Electron.
  return !serverUrl || isLoopbackServerUrl(serverUrl);
}

export function shouldRejectRemoteOffline(
  online: boolean | undefined,
  fullLocalRuntime: boolean,
): boolean {
  return online === false && !fullLocalRuntime;
}

function isAbortError(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown } | null;
  return candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR";
}

function readResponsePayload(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseErrorMessage(payload: unknown, status: number, fallback: string): string {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string" && record.error.trim()) return record.error;
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  }
  if (typeof payload === "string" && payload.trim()) return payload.slice(0, 240);
  return `${fallback}: HTTP ${status}`;
}

export async function fetchJsonWithUploadDeadline<T>(
  url: string,
  init: RequestInit,
  options: {
    timeoutMs: number;
    timeoutMessage: string;
    httpErrorMessage: string;
  },
): Promise<T> {
  const controller = new AbortController();
  const parentSignal = init.signal;
  let timedOut = false;

  const abortFromParent = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }

  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const payload = readResponsePayload(text);

    if (!response.ok) {
      throw new UploadRequestError(
        responseErrorMessage(payload, response.status, options.httpErrorMessage),
        {
          code: "HTTP_ERROR",
          status: response.status,
          retryable: response.status === 408
            || response.status === 429
            || response.status >= 500,
        },
      );
    }

    return payload as T;
  } catch (error) {
    if (timedOut) {
      throw new UploadRequestError(options.timeoutMessage, {
        code: "UPLOAD_TIMEOUT",
        retryable: true,
        cause: error,
      });
    }
    if (parentSignal?.aborted || isAbortError(error)) {
      throw new UploadRequestError("上传已取消", {
        code: "UPLOAD_ABORTED",
        retryable: true,
        cause: error,
      });
    }
    if (error instanceof UploadRequestError) throw error;
    throw new UploadRequestError(
      error instanceof Error && error.message ? error.message : "网络连接失败",
      {
        code: "NETWORK_ERROR",
        retryable: true,
        cause: error,
      },
    );
  } finally {
    globalThis.clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

export function uploadErrorMetadata(error: unknown): {
  code: UploadErrorCode;
  retryable: boolean;
  message: string;
} {
  if (error instanceof UploadRequestError) {
    return { code: error.code, retryable: error.retryable, message: error.message };
  }
  return {
    code: "NETWORK_ERROR",
    retryable: true,
    message: error instanceof Error && error.message ? error.message : "网络连接失败",
  };
}
