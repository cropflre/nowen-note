import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitMediaUploadLifecycle } from "@/lib/mediaUploadLifecycle";
import {
  confirmMediaNotePersistence,
  hasCommittedMediaInsertion,
  scheduleMediaInsertionCommit,
} from "@/lib/mediaInsertionCommit";

vi.mock("@/lib/mediaUploadLifecycle", () => ({
  emitMediaUploadLifecycle: vi.fn(),
}));

const result = {
  attachmentId: "11111111-2222-4333-8444-555555555555",
  url: "/api/attachments/11111111-2222-4333-8444-555555555555",
  previewUrl: "/api/attachments/11111111-2222-4333-8444-555555555555?inline=1",
  filename: "clip.mp4",
};
const tiptapContent = JSON.stringify({
  type: "doc",
  content: [{ type: "video", attrs: { kind: "file", attachmentId: result.attachmentId, src: result.previewUrl } }],
});
const markdownContent = `Before\n\n@[video](${result.previewUrl} "clip.mp4")\n\nAfter`;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  vi.mocked(emitMediaUploadLifecycle).mockClear();
});

afterEach(async () => {
  await vi.runAllTimersAsync();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("media insertion persistence commit", () => {
  it("recognizes saved Tiptap video nodes and Markdown video syntax, not ordinary mentions", () => {
    expect(hasCommittedMediaInsertion(result, tiptapContent)).toBe(true);
    expect(hasCommittedMediaInsertion(result, markdownContent)).toBe(true);
    expect(hasCommittedMediaInsertion(result, `{literal}\n${markdownContent}`)).toBe(true);
    expect(hasCommittedMediaInsertion(result, `See ${result.url} for details`)).toBe(false);
    expect(hasCommittedMediaInsertion(result, JSON.stringify({ type: "doc", content: [{ type: "video", attrs: { kind: "file", attachmentId: "other" } }] }))).toBe(false);
    expect(hasCommittedMediaInsertion(result, JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: result.url }] }] }))).toBe(false);
  });

  it("does not accept a DOM marker or a save acknowledgement for another note", async () => {
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    document.body.innerHTML = `<div class="ProseMirror"><video src="${result.previewUrl}"></video></div>`;
    scheduleMediaInsertionCommit({ noteId: "note-a", file, filename: file.name, result });
    confirmMediaNotePersistence("note-b", tiptapContent);
    await vi.advanceTimersByTimeAsync(1000);
    expect(emitMediaUploadLifecycle).not.toHaveBeenCalled();
    confirmMediaNotePersistence("note-a", tiptapContent);
    expect(emitMediaUploadLifecycle).toHaveBeenCalledWith(expect.objectContaining({ phase: "success", file, result }));
  });

  it("marks a queued save as pending sync, not a server save", () => {
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    scheduleMediaInsertionCommit({ noteId: "note-a", file, filename: file.name, result });
    confirmMediaNotePersistence("note-a", markdownContent, "queued");
    expect(emitMediaUploadLifecycle).toHaveBeenCalledWith(expect.objectContaining({ phase: "success", queued: true }));
  });

  it("reports uploaded-but-not-persisted as recoverable instead of false success", async () => {
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    scheduleMediaInsertionCommit({ noteId: "note-a", file, filename: file.name, result });
    confirmMediaNotePersistence("note-a", "no inserted video");
    await vi.runAllTimersAsync();
    expect(emitMediaUploadLifecycle).toHaveBeenCalledTimes(1);
    expect(emitMediaUploadLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      phase: "error",
      error: expect.stringMatching(/已上传.*正文.*失败.*附件库/),
    }));
  });
});
