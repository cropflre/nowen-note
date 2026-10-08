import { describe, expect, it } from "vitest";
import { createHttpRequestError, safeDiagnosticRequestTarget } from "../httpError";

describe("unified HTTP error adapter", () => {
  it("preserves machine-readable errors and the response correlation ID", () => {
    const response = new Response(null, {
      status: 409,
      headers: { "X-Request-Id": "req_12345678" },
    });
    const error = createHttpRequestError(response, {
      error: "版本冲突", code: "VERSION_CONFLICT",
      requestId: "ignored-body-id", retryable: false,
      currentVersion: 4, manifest: { rootGuid: "root" },
    }, "Request failed");
    expect(error).toMatchObject({
      message: "版本冲突",
      status: 409,
      code: "VERSION_CONFLICT",
      requestId: "req_12345678",
      retryable: false,
      currentVersion: 4,
      manifest: { rootGuid: "root" },
    });
  });

  it("keeps legacy error-only responses compatible", () => {
    const error = createHttpRequestError(new Response(null, { status: 503 }), {
      error: "服务暂不可用",
    }, "Fallback");
    expect(error.message).toBe("服务暂不可用");
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.code).toBeUndefined();
  });

  it("never includes URL credentials, signed query params or share tokens", () => {
    expect(safeDiagnosticRequestTarget(
      "https://user:password@example.com/share/secret-capability?token=private&sig=abc#section",
    )).toBe("https://example.com/share/[redacted]");
    expect(safeDiagnosticRequestTarget("http://%zz")).toBe("(invalid request URL)");
  });
});
