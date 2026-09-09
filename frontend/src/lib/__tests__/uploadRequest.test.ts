import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchJsonWithUploadDeadline,
  getAttachmentUploadTimeoutMs,
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

  it("uses the size-based deadline for browser multipart uploads", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })));

    const fileSize = 12 * 1024 * 1024;
    expect(getAttachmentUploadTimeoutMs(1024)).toBe(90_000);
    expect(getAttachmentUploadTimeoutMs(fileSize)).toBe(93_000);
    expect(getAttachmentUploadTimeoutMs(200 * 1024 * 1024)).toBe(600_000);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(fileSize)]), "large.bin");
    const request = fetchJsonWithUploadDeadline(
      "/api/attachments",
      { method: "POST", body: form },
      {
        timeoutMs: 20_000,
        timeoutMessage: "附件上传超时",
        httpErrorMessage: "附件上传失败",
      },
    );
    const assertion = expect(request).rejects.toMatchObject({
      code: "UPLOAD_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(20_001);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(72_999);
    await assertion;
  });

  it("distinguishes an explicit cancellation from a deadline timeout", async () => {
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })));

    const controller = new AbortController();
    const request = fetchJsonWithUploadDeadline(
      "/api/attachments",
      { method: "POST", signal: controller.signal },
      {
        timeoutMs: 500,
        timeoutMessage: "附件上传超时",
        httpErrorMessage: "附件上传失败",
      },
    );
    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: "UPLOAD_ABORTED",
      message: "上传已取消",
    });
  });

  it("keeps file-size limit responses distinct from upload timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "附件大小超过限制" }),
      { status: 413, headers: { "Content-Type": "application/json" } },
    )));

    await expect(fetchJsonWithUploadDeadline(
      "/api/attachments",
      { method: "POST" },
      {
        timeoutMs: 500,
        timeoutMessage: "附件上传超时",
        httpErrorMessage: "附件上传失败",
      },
    )).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 413,
      retryable: false,
      message: "附件大小超过限制",
    });
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
