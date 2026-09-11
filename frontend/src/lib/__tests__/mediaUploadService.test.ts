import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isVideoFile,
  toInlineAttachmentUrl,
  uploadMediaAttachment,
} from "@/lib/mediaUploadService";
import { api } from "@/lib/api";
import { scheduleMediaInsertionCommit } from "@/lib/mediaInsertionCommit";

vi.mock("@/lib/api", () => ({
  api: {
    attachments: {
      upload: vi.fn(),
    },
  },
}));

vi.mock("@/lib/mediaInsertionCommit", () => ({
  scheduleMediaInsertionCommit: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(api.attachments.upload).mockReset();
  vi.mocked(scheduleMediaInsertionCommit).mockReset();
});

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

  it("uploads a video attachment but delegates final success to insertion commit", async () => {
    vi.mocked(api.attachments.upload).mockResolvedValueOnce({
      id: "att-video",
      url: "/api/attachments/att-video",
      mimeType: "video/mp4",
      size: 12,
      filename: "clip.mp4",
      category: "file",
    });

    const file = new File(["video-data!!"], "clip.mp4", { type: "video/mp4" });
    const result = await uploadMediaAttachment({
      noteId: "note-1",
      file,
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
    expect(scheduleMediaInsertionCommit).toHaveBeenCalledWith(expect.objectContaining({
      filename: "clip.mp4",
      result,
      onSuccess: expect.any(Function),
    }));
  });

  it("retries editor insertion with the already uploaded attachment instead of uploading twice", async () => {
    vi.mocked(api.attachments.upload).mockResolvedValueOnce({
      id: "att-recover",
      url: "/api/attachments/att-recover",
      mimeType: "video/mp4",
      size: 12,
      filename: "recover.mp4",
      category: "file",
    });

    const file = new File(["video-data!!"], "recover.mp4", { type: "video/mp4" });
    const first = await uploadMediaAttachment({ noteId: "note-1", file, source: "drag-drop" });
    const second = await uploadMediaAttachment({ noteId: "note-1", file, source: "drag-drop" });

    expect(api.attachments.upload).toHaveBeenCalledTimes(1);
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(scheduleMediaInsertionCommit).toHaveBeenCalledTimes(2);
  });

  it("never reuses a pending upload after the user switches to another note", async () => {
    vi.mocked(api.attachments.upload)
      .mockResolvedValueOnce({
        id: "att-note-1",
        url: "/api/attachments/att-note-1",
        mimeType: "video/mp4",
        size: 12,
        filename: "switch.mp4",
        category: "file",
      })
      .mockResolvedValueOnce({
        id: "att-note-2",
        url: "/api/attachments/att-note-2",
        mimeType: "video/mp4",
        size: 12,
        filename: "switch.mp4",
        category: "file",
      });

    const file = new File(["video-data!!"], "switch.mp4", { type: "video/mp4" });
    const first = await uploadMediaAttachment({ noteId: "note-1", file, source: "drag-drop" });
    const second = await uploadMediaAttachment({ noteId: "note-2", file, source: "drag-drop" });

    expect(api.attachments.upload).toHaveBeenCalledTimes(2);
    expect(first.attachmentId).toBe("att-note-1");
    expect(second.attachmentId).toBe("att-note-2");
  });
});
