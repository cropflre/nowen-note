import { afterEach, describe, expect, it, vi } from "vitest";
import { fileUploadProgressFetch } from "../fileUploadProgress";

class FakeRequest {
  static last: FakeRequest;
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  status = 201; responseText = '{"id":"saved"}'; timeout = 0;
  onload?: () => void; onabort?: () => void; onerror?: () => void;
  constructor() { FakeRequest.last = this; }
  open = vi.fn(); setRequestHeader = vi.fn(); send = vi.fn();
  getAllResponseHeaders() { return "content-type: application/json\r\n"; }
  abort() { this.onabort?.(); }
}
afterEach(() => { vi.unstubAllGlobals(); });
describe("upload network progress", () => {
  it("only reports measurable network bytes and forwards auth headers", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const progress = vi.fn();
    const pending = fileUploadProgressFetch(progress, 100)("/api/files/upload", {
      method: "POST", headers: { Authorization: "Bearer test-only" }, body: new FormData(),
    });
    const request = FakeRequest.last;
    expect(request.setRequestHeader).toHaveBeenCalledWith("authorization", "Bearer test-only");
    expect(progress).not.toHaveBeenCalled();
    request.upload.onprogress?.({ lengthComputable: false, loaded: 50, total: 0 });
    expect(progress).not.toHaveBeenCalled();
    request.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 });
    expect(progress).toHaveBeenCalledWith(50, 100);
    request.onload?.();
    expect(await (await pending).json()).toEqual({ id: "saved" });
  });
  it("aborts a running request and surfaces a network failure", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeRequest);
    const controller = new AbortController();
    const pending = fileUploadProgressFetch(() => undefined, 100)("/api/files/upload", { body: new FormData(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const failed = fileUploadProgressFetch(() => undefined, 100)("/api/files/upload", { body: new FormData() });
    FakeRequest.last.onerror?.();
    await expect(failed).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});
