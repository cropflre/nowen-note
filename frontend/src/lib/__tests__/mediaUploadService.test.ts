import { describe, expect, it, vi } from "vitest";

import {
  isVideoFile,
  toInlineAttachmentUrl,
  uploadMediaAttachment,
} from "@/lib/mediaUploadService";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    attachments: {
      upload: vi.fn(),
    },
  },
}));

describe("mediaUploadService", () => {
  it("detects video files by mime type and filename fallback", () => {
    expect(isVideoFile(new File(["x"], "clip.mp4", { type: "video/mp4" }))).toBe(true);
    expect(isVideoFile(new File(["x"], "screen-recording.MOV", { type: "" }))).toBe(true);
    expect(isVideoFile(new File(["x"], "cover.png", { type: "image/png" }))).toBe(false);
  });

  it("adds inline=1 without dropping existing query parameters", () => {
    expect(toInlineAttachmentUrl("/api/attachments/att-1")).toBe("/api/attachments/att-1?inline=1");
    expect(toInlineAttachmentUrl("/api/attachments/att-1?download=0")).toBe("/api/attachments/att-1?download=0&inline=1");
  });

  it("uploads a video attachment and returns inline preview metadata", async () => {
    vi.mocked(api.attachments.upload).mockResolvedValueOnce({
      id: "att-video",
      url: "/api/attachments/att-video",
      mimeType: "video/mp4",
      size: 12,
      filename: "clip.mp4",
      category: "file",
    });

    const result = await uploadMediaAttachment({
      noteId: "note-1",
      file: new File(["video-data!!"], "clip.mp4", { type: "video/mp4" }),
      source: "paste",
    });

    expect(api.attachments.upload).toHaveBeenCalledWith("note-1", expect.any(File));
    expect(result).toEqual({
      attachmentId: "att-video",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      size: 12,
      url: "/api/attachments/att-video",
      previewUrl: "/api/attachments/att-video?inline=1",
      source: "paste",
    });
  });
});
