import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitMediaUploadLifecycle } from "@/lib/mediaUploadLifecycle";
import {
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

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  vi.mocked(emitMediaUploadLifecycle).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("media insertion commit", () => {
  it("recognizes a Tiptap video node even when its runtime URL is signed", () => {
    document.body.innerHTML = `
      <div class="ProseMirror" contenteditable="true">
        <video src="https://notes.example/api/attachments/${result.attachmentId}?exp=1&sig=x"></video>
      </div>
    `;
    expect(hasCommittedMediaInsertion(result)).toBe(true);
  });

  it("recognizes a Markdown insertion by persistent attachment marker", () => {
    document.body.innerHTML = `
      <div class="cm-content" contenteditable="true">[clip.mp4](${result.url})</div>
    `;
    expect(hasCommittedMediaInsertion(result)).toBe(true);
  });

  it("does not report final success until the editor actually contains the uploaded attachment", async () => {
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    document.body.innerHTML = `<div class="cm-content" contenteditable="true"></div>`;

    scheduleMediaInsertionCommit({ file, filename: file.name, result });
    await vi.advanceTimersByTimeAsync(180);
    expect(emitMediaUploadLifecycle).not.toHaveBeenCalled();

    document.querySelector(".cm-content")!.textContent = `[clip.mp4](${result.url})`;
    await vi.advanceTimersByTimeAsync(400);

    expect(emitMediaUploadLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      phase: "success",
      file,
      result,
    }));
  });

  it("reports uploaded-but-not-inserted as an actionable error instead of false success", async () => {
    const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
    document.body.innerHTML = `<div class="ProseMirror" contenteditable="true"></div>`;

    scheduleMediaInsertionCommit({ file, filename: file.name, result });
    await vi.runAllTimersAsync();

    expect(emitMediaUploadLifecycle).toHaveBeenCalledTimes(1);
    expect(emitMediaUploadLifecycle).toHaveBeenCalledWith(expect.objectContaining({
      phase: "error",
      file,
      result,
      error: expect.stringMatching(/已上传.*插入正文失败.*附件库/),
    }));
  });
});
