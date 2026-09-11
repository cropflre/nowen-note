import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTACHMENT_UPLOAD_MIN_TIMEOUT_MS,
  fetchJsonWithUploadDeadline,
  getAttachmentUploadTimeoutMs,
  UploadRequestError,
} from "@/lib/uploadRequest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachment upload request contract", () => {
  it("keeps dynamic timeout scaling for large files", () => {
    expect(getAttachmentUploadTimeoutMs(1 * 1024 * 1024)).toBeGreaterThanOrEqual(ATTACHMENT_UPLOAD_MIN_TIMEOUT_MS);
    expect(getAttachmentUploadTimeoutMs(200 * 1024 * 1024)).toBeGreaterThan(
      getAttachmentUploadTimeoutMs(10 * 1024 * 1024),
    );
  });

  it("sends exact file-size hint and preserves structured 413 metadata", async () => {
    const file = new File([new Uint8Array(101)], "clip.mp4", { type: "video/mp4" });
    const form = new FormData();
    form.set("file", file);
    form.set("noteId", "note-1");

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("__uploadSize=101");
      return new Response(JSON.stringify({
        code: "ATTACHMENT_TOO_LARGE",
        maxSizeBytes: 100,
        actualSizeBytes: 101,
        error: "文件大小超过服务器允许的 100 MiB",
      }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await fetchJsonWithUploadDeadline("https://notes.example/api/attachments", {
        method: "POST",
        body: form,
      }, {
        timeoutMs: ATTACHMENT_UPLOAD_MIN_TIMEOUT_MS,
        timeoutMessage: "timeout",
        httpErrorMessage: "upload failed",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(UploadRequestError);
    expect(caught).toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
      status: 413,
      retryable: false,
      maxSizeBytes: 100,
      actualSizeBytes: 101,
    });
  });
});
