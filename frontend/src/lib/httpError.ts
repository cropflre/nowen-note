/**
 * Backwards-compatible interpretation of error responses from the backend.
 * Never discard the server's stable code or cross-platform request ID.
 */
export type HttpRequestError = Error & {
  code?: string;
  status: number;
  requestId?: string;
  retryable: boolean;
  currentVersion?: number;
  manifest?: Record<string, unknown>;
};

export function createHttpRequestError(response: Response, payload: unknown, fallback: string): HttpRequestError {
  const record = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const error = new Error(typeof record?.error === "string" && record.error ? record.error : fallback) as HttpRequestError;
  error.name = "HttpRequestError";
  error.status = response.status;
  if (typeof record?.code === "string") error.code = record.code;
  // Server header wins over JSON: it remains accessible on older error payloads.
  const headerId = response.headers.get("X-Request-Id");
  const bodyId = typeof record?.requestId === "string" ? record.requestId : null;
  const requestId = headerId || bodyId;
  if (requestId) error.requestId = requestId;
  error.retryable = typeof record?.retryable === "boolean"
    ? record.retryable
    : (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500);
  if (typeof record?.currentVersion === "number") error.currentVersion = record.currentVersion;
  if (record?.manifest && typeof record.manifest === "object" && !Array.isArray(record.manifest)) {
    error.manifest = record.manifest as Record<string, unknown>;
  }
  return error;
}

/**
 * Avoid leaking signed URLs, query tokens, URL credentials or share capabilities
 * in exception messages and in diagnostic bundles.
 */
export function safeDiagnosticRequestTarget(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    const safePath = url.pathname.replace(
      /\/(share|public|notebook-share|plugin-inbound|invite)\/[^/]+/gi,
      "/$1/[redacted]",
    );
    return url.origin + safePath;
  } catch {
    return "(invalid request URL)";
  }
}
