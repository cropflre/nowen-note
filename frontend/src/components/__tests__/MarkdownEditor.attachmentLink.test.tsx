// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "@/types";
import type { NoteEditorHandle } from "@/components/editors/types";
import {
  registerAttachmentAccessUrls,
  resetAttachmentAccessStateForTests,
} from "@/lib/noteAttachmentAccessBridge";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh-CN", on() {}, off() {} } }) }));
vi.mock("@/lib/api", () => ({ api: {}, getServerUrl: () => "", getCurrentWorkspace: () => null }));
vi.mock("@/hooks/useUserPreferences", () => ({ useUserPreferences: () => ({ prefs: { markdownDefaultViewMode: "source" } }) }));
vi.mock("@/hooks/useKeyboardVisible", () => ({ useKeyboardVisible: () => ({ visible: false }) }));
vi.mock("@/components/MarkdownPreview", () => ({ MarkdownPreview: () => null }));
vi.mock("@/components/AttachmentLibraryPicker", () => ({ default: () => null }));
vi.mock("@/components/NoteLinkExtension", () => ({ NoteLinkMenu: () => null }));
import MarkdownEditor from "../MarkdownEditorImpl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = "11111111-2222-4333-8444-555555555555";
const bareUrl = `https://notes.example/api/attachments/${id}/image.webp`;
const signedUrl = `https://notes.example/api/attachments/${id}?exp=4102444800&sig=session-signature&scope=v2.user`;
const note: Note = {
  id: "link-note", userId: "owner", notebookId: "book", workspaceId: null,
  title: "Image link", content: "", contentText: "", contentFormat: "markdown",
  isPinned: 0, isFavorite: 0, isLocked: 0, isArchived: 0, isTrashed: 0,
  trashedAt: null, version: 1, sortOrder: 0, createdAt: "", updatedAt: "",
};

describe("Markdown selection attachment links", () => {
  let host: HTMLDivElement;
  let root: Root;
  const ref = React.createRef<NoteEditorHandle>();

  beforeEach(() => {
    resetAttachmentAccessStateForTests();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    Object.defineProperties(Range.prototype, {
      getClientRects: { configurable: true, value: () => [] },
      getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    });
    vi.spyOn(EditorView.prototype, "coordsAtPos").mockReturnValue({ left: 100, right: 200, top: 100, bottom: 120 });
    vi.spyOn(window, "open").mockReturnValue(null);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetAttachmentAccessStateForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function selectLink(url: string) {
    const content = `![photo](${url})`;
    await act(async () => root.render(<MarkdownEditor note={{ ...note, content }} onUpdate={() => {}} isGuest ref={ref} />));
    const view = EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
    await act(async () => {
      view.focus();
      view.dispatch({ selection: { anchor: content.indexOf(url), head: content.indexOf(url) + url.length } });
    });
    const button = host.querySelector<HTMLButtonElement>(`button[title="${url}"]`);
    expect(button).not.toBeNull();
    return button!;
  }

  it("opens a bare named image with the current session signature without changing Markdown", async () => {
    const button = await selectLink(bareUrl);
    // Resolve at click time, including a signature delivered after the selection was made.
    registerAttachmentAccessUrls({ [id]: signedUrl }, "https://notes.example/api/notes/link-note");
    await act(async () => button.click());
    expect(window.open).toHaveBeenCalledWith(signedUrl, "_blank", "noopener");
    expect(ref.current?.getSnapshot?.()?.content).toBe(`![photo](${bareUrl})`);
  });

  it("keeps ordinary web links unchanged", async () => {
    registerAttachmentAccessUrls({ [id]: signedUrl });
    const url = "https://example.com/image.webp?size=large#photo";
    const button = await selectLink(url);
    await act(async () => button.click());
    expect(window.open).toHaveBeenCalledWith(url, "_blank", "noopener");
  });

  it("opens an existing share link without requiring a session signature", async () => {
    const url = `${bareUrl}?share=existing-capability`;
    const button = await selectLink(url);
    await act(async () => button.click());
    expect(window.open).toHaveBeenCalledWith(url, "_blank", "noopener");
  });

  it("does not reuse a previous session signature after logout (DCC-006)", async () => {
    registerAttachmentAccessUrls({ [id]: signedUrl });
    const button = await selectLink(bareUrl);
    window.dispatchEvent(new CustomEvent("nowen:token-changed", { detail: { authenticated: false } }));
    await act(async () => button.click());
    expect(window.open).toHaveBeenCalledWith(bareUrl, "_blank", "noopener");
  });
});
