// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import type { NoteEditorHandle } from "@/components/editors/types";

const mocks = vi.hoisted(() => ({
  upload: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), pickerClick: vi.fn(),
  t: (key: string) => key,
  i18n: { language: "zh-CN", on: () => {}, off: () => {} },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t, i18n: mocks.i18n }) }));
vi.mock("@/lib/api", () => ({ api: { attachments: { upload: mocks.upload } }, getServerUrl: () => "", getCurrentWorkspace: () => null }));
vi.mock("@/lib/toast", () => ({ toast: { error: mocks.error, info: mocks.info, success: mocks.success } }));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: { markdownDefaultViewMode: "source", remoteImagePasteMode: "keep-remote" } }) }));
vi.mock("@/hooks/useKeyboardVisible", () => ({ useKeyboardVisible: () => ({ visible: false }) }));
vi.mock("@/components/MarkdownPreview", () => ({ MarkdownPreview: () => null }));
vi.mock("@/components/AttachmentLibraryPicker", () => ({ default: () => null }));
vi.mock("@/components/NoteLinkExtension", () => ({ NoteLinkMenu: () => null }));
import MarkdownEditor from "../MarkdownEditorImpl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const note: Note = {
  id: "photo-note", userId: "owner", notebookId: "book", workspaceId: null,
  title: "照片", content: "前文\n\n后文", contentText: "前文 后文", contentFormat: "markdown",
  isPinned: 0, isFavorite: 0, isLocked: 0, isArchived: 0, isTrashed: 0,
  trashedAt: null, version: 1, sortOrder: 0, createdAt: "", updatedAt: "",
};
const photo = () => new File(["heic"], "IMG.HEIC");
const movie = () => new File(["mov"], "IMG.MOV");
const result = (file: File) => ({ category: file.name.endsWith("MOV") ? "file" : "image", url: `/api/attachments/${file.name}`, filename: file.name });

describe("Markdown 图片按钮上传完整 Live Photo 原件", () => {
  let host: HTMLDivElement;
  let root: Root;
  let picker: HTMLInputElement;
  const ref = React.createRef<NoteEditorHandle>();
  async function render(value = note) {
    await act(async () => root.render(<MarkdownEditor note={value} onUpdate={() => {}} isGuest ref={ref} />));
  }
  function view() { return EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!; }
  async function open() {
    await act(async () => host.querySelector<HTMLButtonElement>('button[title="tiptap.insertImage"]')!.click());
    picker = mocks.pickerClick.mock.instances.at(-1) as HTMLInputElement;
  }
  async function select(files: File[]) {
    Object.defineProperty(picker, "files", { configurable: true, value: files });
    await act(async () => picker.dispatchEvent(new Event("change")));
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(mocks.pickerClick);
    mocks.upload.mockImplementation(async (_id: string, file: File) => result(file));
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  it("支持 HEIC + MOV 多选，先保存 MOV，正文只插入照片", async () => {
    await open();
    expect(picker.accept).toBe("image/*,.heic,.heif,.mov"); expect(picker.multiple).toBe(true);
    await select([photo(), movie()]);
    expect(mocks.upload.mock.calls.map((call) => call[1].name)).toEqual(["IMG.MOV", "IMG.HEIC"]);
    expect(ref.current?.getSnapshot?.()?.content).toContain("![IMG](/api/attachments/IMG.HEIC)");
    expect(ref.current?.getSnapshot?.()?.content).not.toContain("IMG.MOV");
  });
  it("上传期间移动光标和编辑文字，照片仍插入映射后的原选区", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await act(async () => view().dispatch({ selection: { anchor: 4 } }));
    await open(); await select([photo(), movie()]);
    await act(async () => view().dispatch({ changes: { from: 0, insert: "新增\n" }, selection: { anchor: view().state.doc.length + "新增\n".length } }));
    await act(async () => finish(result(movie())));
    expect(ref.current?.getSnapshot?.()?.content).toBe("新增\n前文\n\n![IMG](/api/attachments/IMG.HEIC)\n后文");
  });
  it("上传期间切换笔记，不把旧照片插入新笔记", async () => {
    let finish!: (value: ReturnType<typeof result>) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await open(); await select([photo(), movie()]);
    await render({ ...note, id: "another-note", content: "新笔记", contentText: "新笔记" });
    await act(async () => finish(result(movie())));
    expect(mocks.upload.mock.calls.every((call) => call[0] === "photo-note")).toBe(true);
    expect(ref.current?.getSnapshot?.()?.content).toBe("新笔记");
  });
  it("MOV 上传失败时显示错误，不插入残缺照片或 base64", async () => {
    mocks.upload.mockRejectedValueOnce(new Error("MOV 原件上传失败"));
    await open(); await select([photo(), movie()]);
    expect(mocks.error).toHaveBeenCalledWith("MOV 原件上传失败");
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(ref.current?.getSnapshot?.()?.content).toBe(note.content);
  });
});
