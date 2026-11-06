import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceDataUrlImagesWithAttachments } from "../rtfImageUploader";

const mocks = vi.hoisted(() => ({ upload: vi.fn() }));
vi.mock("../api", () => ({ api: { attachments: { upload: mocks.upload } } }));

const dataUrl = (index: number) => `data:image/png;base64,${btoa(`photo-${index}`)}`;
const imageNode = (src: string, alt = "photo") => ({ type: "image", attrs: { src, alt, title: "original title" } });
const editors: Editor[] = [];
function editorWithImages(sources: string[]) {
  const editor = new Editor({
    extensions: [StarterKit, Image.configure({ inline: true, allowBase64: true })],
    content: { type: "doc", content: [{ type: "paragraph", content: sources.map((src) => imageNode(src)) }] },
  });
  editors.push(editor);
  return editor;
}
function images(editor: Editor) {
  const result: Array<Record<string, unknown>> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") result.push(node.attrs);
  });
  return result;
}

beforeEach(() => {
  mocks.upload.mockReset();
  mocks.upload.mockImplementation(async () => ({ url: `/api/attachments/photo-${mocks.upload.mock.calls.length}` }));
});
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  vi.restoreAllMocks();
});

describe("Word pasted image attachment upload", () => {
  it("reports the actual nine-image queue before upload and completes every image", async () => {
    const editor = editorWithImages(Array.from({ length: 9 }, (_, index) => dataUrl(index)));
    const progress = vi.fn();
    const pending = replaceDataUrlImagesWithAttachments(editor, "word-note", { onProgress: progress });
    expect(progress).toHaveBeenCalledWith(0, 9);
    expect(await pending).toEqual({ total: 9, uploaded: 9, failed: 0 });
    expect(progress.mock.calls).toEqual(Array.from({ length: 10 }, (_, done) => [done, 9]));
    expect(mocks.upload).toHaveBeenCalledTimes(9);
    expect(mocks.upload.mock.calls.every(([noteId, file]) => noteId === "word-note" && file instanceof File && file.type === "image/png")).toBe(true);
    expect(images(editor).every((attrs) => String(attrs.src).startsWith("/api/attachments/"))).toBe(true);
  });

  it("does not start a progress indicator when no inline images need uploading", async () => {
    const editor = editorWithImages(["/api/attachments/existing"]);
    const progress = vi.fn();
    expect(await replaceDataUrlImagesWithAttachments(editor, "word-note", { onProgress: progress }))
      .toEqual({ total: 0, uploaded: 0, failed: 0 });
    expect(progress).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("keeps a failed image available while uploading the remaining photos (DCC-003)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.upload.mockRejectedValueOnce(new Error("network unavailable"));
    const editor = editorWithImages([dataUrl(1), dataUrl(2)]);
    const progress = vi.fn();
    expect(await replaceDataUrlImagesWithAttachments(editor, "word-note", { concurrency: 1, onProgress: progress }))
      .toEqual({ total: 2, uploaded: 1, failed: 1 });
    expect(images(editor).map((attrs) => attrs.src)).toEqual([dataUrl(1), "/api/attachments/photo-2"]);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });

  it("uploads repeated photo bytes once and replaces every occurrence while retaining attributes", async () => {
    const editor = editorWithImages([dataUrl(1), dataUrl(1)]);
    const secondImagePos = 2;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(secondImagePos, undefined, { ...editor.state.doc.nodeAt(secondImagePos)!.attrs, alt: "second photo" }));
    expect(await replaceDataUrlImagesWithAttachments(editor, "word-note")).toEqual({ total: 1, uploaded: 1, failed: 0 });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(images(editor)).toEqual([
      expect.objectContaining({ src: "/api/attachments/photo-1", alt: "photo", title: "original title" }),
      expect.objectContaining({ src: "/api/attachments/photo-1", alt: "second photo", title: "original title" }),
    ]);
  });

  it("finds the current image position after text is inserted while uploading", async () => {
    let finish!: (value: { url: string }) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const editor = editorWithImages([dataUrl(1)]);
    const pending = replaceDataUrlImagesWithAttachments(editor, "word-note");
    editor.commands.insertContentAt(1, "new text ");
    finish({ url: "/api/attachments/edited-photo" });
    expect(await pending).toEqual({ total: 1, uploaded: 1, failed: 0 });
    expect(editor.state.doc.textContent).toBe("new text ");
    expect(images(editor)[0].src).toBe("/api/attachments/edited-photo");
  });

  it("stops queued uploads and ignores late results after the note changes (DCC-006)", async () => {
    let current = true;
    let finish!: (value: { url: string }) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const editor = editorWithImages([dataUrl(1), dataUrl(2)]);
    const progress = vi.fn();
    const pending = replaceDataUrlImagesWithAttachments(editor, "old-note", { concurrency: 1, isCurrent: () => current, onProgress: progress });
    current = false;
    editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [imageNode(dataUrl(1), "new note photo")] }] });
    finish({ url: "/api/attachments/old-note-photo" });
    await pending;
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(images(editor)[0]).toEqual(expect.objectContaining({ src: dataUrl(1), alt: "new note photo" }));
    expect(progress.mock.calls).toEqual([[0, 2]]);
  });

  it("does not scan or upload a stale editor scope", async () => {
    const editor = editorWithImages([dataUrl(1)]);
    const progress = vi.fn();
    expect(await replaceDataUrlImagesWithAttachments(editor, "old-note", { isCurrent: () => false, onProgress: progress }))
      .toEqual({ total: 0, uploaded: 0, failed: 0 });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});
