import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import type { Note } from "@/types";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), extract: vi.fn(), editor: null as Editor | null }));
vi.mock("@tiptap/react", async () => {
  const actual = await vi.importActual<typeof import("@tiptap/react")>("@tiptap/react");
  return { ...actual, useEditor: (...args: Parameters<typeof actual.useEditor>) => {
    const editor = actual.useEditor(...args);
    mocks.editor = editor;
    return editor;
  } };
});
vi.mock("@/lib/api", () => ({ api: { attachments: { upload: mocks.upload } }, getServerUrl: () => "", getCurrentWorkspace: () => null, resolveAttachmentUrl: (url: string) => url }));
vi.mock("@/lib/rtfImageWorkerClient", () => ({ extractRtfImagesAsync: mocks.extract }));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: { remoteImagePasteMode: "keep-remote" } }) }));
vi.mock("@/hooks/useKeyboardVisible", () => ({ useKeyboardVisible: () => ({ visible: false }) }));
vi.mock("../ResizableImageView", () => ({ createResizableImageNodeView: () => () => ({ dom: document.createElement("img") }) }));
import TiptapEditor from "../TiptapEditor";
import i18n from "@/i18n";
import * as uploader from "@/lib/rtfImageUploader";
import { extractImagesFromRtfSync } from "@/lib/rtfImageFallback";

const note = {
  id: "word-note", userId: "owner", notebookId: "book", workspaceId: null,
  title: "Word", content: '{"type":"doc","content":[{"type":"paragraph"}]}',
  contentText: "", contentFormat: "tiptap-json", version: 1, tags: [],
} as unknown as Note;
const photos = Array.from({ length: 9 }, (_, index) => `data:image/jpeg;base64,${btoa(`photo-${index}`.repeat(40))}`);
const rtf = "{\\rtf1" + photos.map((src) => "{\\pict\\jpegblip " + Array.from(atob(src.split(",")[1]), (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("") + "}").join("") + "}";

describe("Word photo paste", () => {
  let host: HTMLDivElement;
  let root: Root;
  async function render(value = note) {
    await act(async () => root.render(<TiptapEditor note={value} onUpdate={() => {}} isGuest />));
  }
  async function paste(html: string, beforeUpload?: () => void) {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      items: [], files: [], getData: (type: string) => ({ "text/html": html, "text/plain": "Word photos", "text/rtf": rtf })[type] || "",
    } });
    await act(async () => mocks.editor!.view.dom.dispatchEvent(event));
    if (beforeUpload) await act(async () => beforeUpload());
    await act(async () => vi.advanceTimersByTimeAsync(201));
  }
  beforeEach(async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    await i18n.changeLanguage("zh-CN");
    mocks.extract.mockImplementation(async (value: string) => extractImagesFromRtfSync(value));
    mocks.upload.mockImplementation(async (_noteId: string, file: File) => ({ id: file.name, url: `/api/attachments/${file.name}` }));
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  it("recovers all nine photos when Word HTML exposes images only in conditional comments", async () => {
    await paste('<p class="MsoNormal">Word photos</p>' + '<!--[if gte vml 1]><v:shape><v:imagedata src="file:///photo.jpg"/></v:shape><![endif]-->'.repeat(9));
    expect(mocks.upload).toHaveBeenCalledTimes(9);
    expect(mocks.upload.mock.calls.every(([noteId]) => noteId === note.id)).toBe(true);
    expect(mocks.editor!.getJSON().content?.flatMap((node) => node.content || []).filter((node) => node.type === "image")).toHaveLength(9);
    expect(host.textContent).toContain("已上传 9/9 张图片");
    expect(host.textContent).not.toContain("正在上传图片到服务器");
  });
  it("does not leave an upload spinner when the recovered document has no data images", async () => {
    await paste('<p class="MsoNormal">Word photos<img src="file:///photo.jpg"></p>', () => {
      mocks.editor!.commands.clearContent();
    });
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("正在上传图片到服务器");
  });
  it("ends the waiting toast if the background upload unexpectedly rejects", async () => {
    vi.spyOn(uploader, "replaceDataUrlImagesWithAttachments").mockRejectedValueOnce(new Error("upload failed"));
    await paste('<p class="MsoNormal">Word photos<img src="file:///photo.jpg"></p>');
    expect(host.textContent).toContain("图片上传失败");
    expect(host.textContent).not.toContain("正在上传图片到服务器");
    expect(mocks.editor!.getHTML()).toContain('src="data:image/');
  });
  it("ignores decoded Word photos after switching notes (DCC-006)", async () => {
    let finish!: (images: string[]) => void;
    mocks.extract.mockImplementationOnce(() => new Promise<string[]>((resolve) => { finish = resolve; }));
    await paste('<p class="MsoNormal">Word photos<img src="file:///photo.jpg"></p>');
    await render({ ...note, id: "next-note" });
    await act(async () => finish(photos));
    await act(async () => vi.advanceTimersByTimeAsync(201));
    expect(mocks.editor!.getText()).toBe("");
    expect(mocks.editor!.getJSON().content).toHaveLength(1);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("正在解析");
  });
  it("keeps the mapped paste position while RTF decoding is pending", async () => {
    let finish!: (images: string[]) => void;
    mocks.extract.mockImplementationOnce(() => new Promise<string[]>((resolve) => { finish = resolve; }));
    await act(async () => mocks.editor!.commands.insertContent("before after"));
    await act(async () => mocks.editor!.commands.setTextSelection(8));
    await paste('<p class="MsoNormal">Word photos<img src="file:///photo.jpg"></p>');
    await act(async () => {
      mocks.editor!.commands.insertContentAt(1, "new ");
      mocks.editor!.commands.setTextSelection(mocks.editor!.state.doc.content.size - 1);
    });
    await act(async () => finish(photos));
    expect(mocks.editor!.getText().replace(/\n/g, "")).toBe("new before Word photosafter");
  });
  it("still uploads a single clipboard image through the normal image path", async () => {
    const file = new File(["single photo"], "single.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: {
      items: [{ type: "image/png", kind: "file", getAsFile: () => file }], files: [], getData: () => "",
    } });
    await act(async () => mocks.editor!.view.dom.dispatchEvent(event));
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.upload).toHaveBeenCalledWith(note.id, file);
    expect(mocks.extract).not.toHaveBeenCalled();
    expect(mocks.editor!.state.doc.firstChild?.firstChild?.attrs.src).toBe("/api/attachments/single.png");
    expect(host.textContent).not.toContain("正在上传");
  });
});
