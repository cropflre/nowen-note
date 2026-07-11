// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ warning: vi.fn() }));

vi.mock("@/lib/toast", () => ({
  toast: toastMock,
}));

import { installTaskAttachmentExportFallback } from "@/lib/taskAttachmentExportFallback";

const INSTALL_MARKER = "__nowenTaskAttachmentExportFallbackInstalled";
let originalFetch: typeof window.fetch;

describe("taskAttachmentExportFallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toastMock.warning.mockReset();
    originalFetch = window.fetch;
    delete (window as unknown as Record<string, unknown>)[INSTALL_MARKER];
  });

  afterEach(() => {
    window.fetch = originalFetch;
    delete (window as unknown as Record<string, unknown>)[INSTALL_MARKER];
    vi.useRealTimers();
  });

  it("replaces a missing task image with a visible PNG so ZIP export can continue", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("missing", { status: 404 }));
    window.fetch = upstream as typeof window.fetch;
    installTaskAttachmentExportFallback();

    const response = await window.fetch("/api/task-attachments/80cedae6-cab6-4925-b69a-3505e68ccb70");

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Nowen-Task-Attachment-Placeholder")).toBe("missing");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    await vi.runAllTimersAsync();
    expect(toastMock.warning).toHaveBeenCalledWith(
      expect.stringContaining("1 张历史任务图片已失效"),
      6000,
    );
  });

  it("does not hide permission, server, network, or unrelated 404 failures", async () => {
    const upstream = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockRejectedValueOnce(new TypeError("network failed"));
    window.fetch = upstream as typeof window.fetch;
    installTaskAttachmentExportFallback();

    const serverError = await window.fetch("/api/task-attachments/attachment-1");
    const unrelated = await window.fetch("/api/notes/missing");

    expect(serverError.status).toBe(500);
    expect(unrelated.status).toBe(404);
    await expect(window.fetch("/api/task-attachments/attachment-2")).rejects.toThrow("network failed");
    expect(toastMock.warning).not.toHaveBeenCalled();
  });

  it("installs only once", async () => {
    const upstream = vi.fn().mockResolvedValue(new Response("missing", { status: 410 }));
    window.fetch = upstream as typeof window.fetch;

    installTaskAttachmentExportFallback();
    const wrapped = window.fetch;
    installTaskAttachmentExportFallback();

    expect(window.fetch).toBe(wrapped);
    const response = await window.fetch("/api/task-attachments/attachment-3");
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();
  });
});
