import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { resetAttachmentAccessStateForTests } from "@/lib/noteAttachmentAccessBridge";
import { ATTACHMENT_UPLOAD_MIN_TIMEOUT_MS } from "@/lib/uploadRequest";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  Reflect.deleteProperty(window, "Capacitor");
  resetAttachmentAccessStateForTests();
});

describe("attachment upload response recovery", () => {
  it.each(["network", "server", "invalid-json"])("recovers a persisted upload after %s failure without uploading twice (DCC-003)", async (failure) => {
    localStorage.setItem("nowen-server-url", "https://notes.example");
    localStorage.setItem("nowen-token", "test-token");
    let uploadId = "";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        uploadId = String((init.body as FormData).get("uploadId"));
        if (failure === "network") throw new TypeError("Failed to fetch");
        return new Response(failure === "server" ? '{"error":"response failed"}' : "broken response", { status: failure === "server" ? 500 : 201 });
      }
      return new Response(JSON.stringify({ id: uploadId, url: `/api/attachments/${uploadId}`, filename: "中文.pdf", size: 3, mimeType: "application/pdf", category: "file" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await api.attachments.upload("note-1", new File(["pdf"], "中文.pdf", { type: "application/pdf" }));
    expect(uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.id).toBe(uploadId);
    expect(result.url).toBe(`/api/attachments/${uploadId}`);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/attachments/upload-result/${uploadId}?noteId=note-1`);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each([401, 403, 413])("does not recover a rejected HTTP %s upload", async (status) => {
    const fetchMock = vi.fn(async () => new Response('{"error":"rejected"}', { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.attachments.upload("note-1", new File(["pdf"], "a.pdf"))).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recovers a persisted upload after its request deadline", async () => {
    vi.useFakeTimers();
    let uploadId = "";
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        uploadId = String((init.body as FormData).get("uploadId"));
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ id: uploadId, url: `/api/attachments/${uploadId}` })));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = api.attachments.upload("note-1", new File(["pdf"], "a.pdf"));
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_MIN_TIMEOUT_MS + 1);
    expect((await result).id).toBe(uploadId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves the original error when recovery is unavailable on an old server", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("connection lost")).mockResolvedValueOnce(new Response("Not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.attachments.upload("note-1", new File(["pdf"], "a.pdf"))).rejects.toThrow("connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not recover into a changed server or account (DCC-006)", async () => {
    localStorage.setItem("nowen-token", "old-token");
    const fetchMock = vi.fn(async () => {
      localStorage.setItem("nowen-token", "new-token");
      throw new TypeError("connection lost");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.attachments.upload("note-1", new File(["pdf"], "a.pdf"))).rejects.toThrow("connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a recovery response for a different upload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("connection lost")).mockResolvedValueOnce(new Response(JSON.stringify({
      id: "different-upload", url: "/api/attachments/different-upload",
    }))));
    await expect(api.attachments.upload("note-1", new File(["pdf"], "a.pdf"))).rejects.toThrow("connection lost");
  });

  it("ignores recovery arriving after the account changes", async () => {
    localStorage.setItem("nowen-token", "old-token");
    const fetchMock = vi.fn().mockRejectedValueOnce(new TypeError("connection lost")).mockImplementationOnce(async () => {
      const uploadId = String((fetchMock.mock.calls[0][1].body as FormData).get("uploadId"));
      localStorage.setItem("nowen-token", "new-token");
      return new Response(JSON.stringify({ id: uploadId, url: `/api/attachments/${uploadId}` }));
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.attachments.upload("note-1", new File(["pdf"], "a.pdf"))).rejects.toThrow("connection lost");
  });

  it("does not query a new server for the old upload", async () => {
    Object.assign(window, { Capacitor: { isNativePlatform: () => true } });
    localStorage.setItem("nowen-server-url", "https://old.example");
    const fetchMock = vi.fn(async () => {
      localStorage.setItem("nowen-server-url", "https://new.example");
      throw new TypeError("connection lost");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.attachments.upload("note-1", new File(["pdf"], "a.pdf"))).rejects.toThrow("connection lost");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
