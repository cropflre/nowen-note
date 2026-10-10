// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/lib/api", async () => {
  const bridge = await import("@/lib/noteAttachmentAccessBridge");
  return { resolveAttachmentUrl: bridge.resolveAttachmentAccessUrl, getServerUrl: () => "http://localhost" };
});
import { photoMediaUrl } from "../photoMedia";
import { registerAttachmentAccessUrls, registerNativeAttachmentUrl, registerOfflineAttachmentBlob, resetAttachmentAccessStateForTests, resolveAttachmentAccessUrl } from "../noteAttachmentAccessBridge";
import { resolveAttachmentDownloadUrl } from "../downloadFile";
const id = "123e4567-e89b-42d3-a456-426614174216";
describe("照片派生地址保留鉴权，隔离原件离线缓存", () => {
  beforeEach(() => {
    resetAttachmentAccessStateForTests();
    vi.stubGlobal("URL", URL);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:http://localhost/original") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    registerAttachmentAccessUrls({ [id]: `/api/attachments/${id}?exp=2000000000&sig=valid&scope=owner` }, "http://localhost/api/notes/note");
  });
  it("info、MP4 与配对原件不会被原照片 Blob 替换", () => {
    registerOfflineAttachmentBlob(id, new Blob(["original HEIC"], { type: "image/heic" }));
    expect(resolveAttachmentAccessUrl(`/api/attachments/${id}`)).toContain("blob:");
    for (const kind of ["info", "motion", "motion-original"] as const) {
      const url = new URL(photoMediaUrl(`/api/attachments/${id}?w=240&download=1`, kind), "http://localhost");
      expect(url.searchParams.get("sig")).toBe("valid"); expect(url.searchParams.has("w")).toBe(false);
      expect(url.searchParams.get(kind === "info" ? "media" : "variant")).toBe(kind);
      expect(url.searchParams.get("download")).toBe(kind === "motion-original" ? "1" : null);
    }
  });
  it("普通外部图片不会向派生接口发请求", () => expect(photoMediaUrl("https://example.com/a.jpg", "info")).toBe(""));
  it("稳定分享令牌随派生请求保留", () => {
    const url = new URL(photoMediaUrl(`/api/attachments/${id}?share=file-share-token`, "motion"), "http://localhost");
    expect(url.searchParams.get("share")).toBe("file-share-token");
  });
  it("原生封面用于图片渲染，下载取 HEIF 原件，动态请求仍发往服务器", () => {
    const preview = "https://localhost/_capacitor_file_/cache/photo.jpg";
    const original = "https://localhost/_capacitor_file_/files/photo.heic";
    registerNativeAttachmentUrl(id, preview, original);
    expect(resolveAttachmentAccessUrl(`/api/attachments/${id}`)).toBe(preview);
    expect(resolveAttachmentDownloadUrl(preview)).toContain(original);
    expect(photoMediaUrl(preview, "motion")).toContain("variant=motion");
    expect(photoMediaUrl(preview, "motion")).not.toContain("_capacitor_file_");
  });
});
