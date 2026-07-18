import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchJsonWithUploadDeadline,
  isElectronFullLocalRuntime,
  isLoopbackServerUrl,
  shouldRejectRemoteOffline,
  UploadRequestError,
} from "@/lib/uploadRequest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bounded image upload requests", () => {
  it("recognizes Electron Full loopback backends", () => {
    expect(isLoopbackServerUrl("http://127.0.0.1:3100")).toBe(true);
    expect(isLoopbackServerUrl("http://localhost:3100")).toBe(true);
    expect(isLoopbackServerUrl("https://nas.example.com")).toBe(false);
    expect(isElectronFullLocalRuntime("http://127.0.0.1:3100", true)).toBe(true);
    expect(isElectronFullLocalRuntime("", true)).toBe(true);
    expect(isElectronFullLocalRuntime("https://nas.example.com", true)).toBe(false);
    expect(isElectronFullLocalRuntime("http://127.0.0.1:3100", false)).toBe(false);
  });

  it("rejects explicit offline uploads only for remote runtimes", () => {
    expect(shouldRejectRemoteOffline(false, false)).toBe(true);
    expect(shouldRejectRemoteOffline(false, true)).toBe(false);
    expect(shouldRejectRemoteOffline(true, false)).toBe(false);
    expect(shouldRejectRemoteOffline(undefined, false)).toBe(false);
  });

  it("aborts a hanging fetch and returns a retryable timeout error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })));

    const request = fetchJsonWithUploadDeadline(
      "/api/attachments",
      { method: "POST" },
      {
        timeoutMs: 50,
        timeoutMessage: "附件上传超时",
        httpErrorMessage: "附件上传失败",
      },
    );
    const assertion = expect(request).rejects.toMatchObject({
      name: "UploadRequestError",
      code: "UPLOAD_TIMEOUT",
      retryable: true,
      message: "附件上传超时",
    });

    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });

  it("preserves HTTP status and retryability for server errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "storage unavailable" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));

    const error = await fetchJsonWithUploadDeadline(
      "/api/attachments",
      { method: "POST" },
      {
        timeoutMs: 500,
        timeoutMessage: "附件上传超时",
        httpErrorMessage: "附件上传失败",
      },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(UploadRequestError);
    expect(error).toMatchObject({
      code: "HTTP_ERROR",
      status: 503,
      retryable: true,
      message: "storage unavailable",
    });
  });
});
