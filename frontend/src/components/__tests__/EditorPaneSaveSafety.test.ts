import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editorPaneSource = readFileSync(
  path.resolve(__dirname, "../EditorPane.tsx"),
  "utf8",
);

const sharedNoteViewSource = readFileSync(
  path.resolve(__dirname, "../SharedNoteView.tsx"),
  "utf8",
);

const markdownEditorSource = readFileSync(
  path.resolve(__dirname, "../MarkdownEditor.tsx"),
  "utf8",
);

const tiptapEditorSource = readFileSync(
  path.resolve(__dirname, "../TiptapEditor.tsx"),
  "utf8",
);

const apiSource = readFileSync(
  path.resolve(__dirname, "../../lib/api.ts"),
  "utf8",
);

const typesSource = readFileSync(
  path.resolve(__dirname, "../../types/index.ts"),
  "utf8",
);

const zhCnLocale = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../i18n/locales/zh-CN.json"), "utf8"),
);

const enLocale = JSON.parse(
  readFileSync(path.resolve(__dirname, "../../i18n/locales/en.json"), "utf8"),
);

function sourceBetween(source: string, startNeedle: string, endNeedle: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("EditorPane save safety", () => {
  it("sends contentFormat with normal editor content saves", () => {
    const sendOnce = sourceBetween(
      editorPaneSource,
      "const sendOnce = (version: number) => {",
      "return api.updateNote(currentNote.id, payload);",
    );

    expect(sendOnce).toContain("payload.contentFormat = currentNote.contentFormat");
  });

  it("keeps contentFormat in all offline fallback payloads", () => {
    const pageHideFallback = sourceBetween(
      editorPaneSource,
      "const flushToLocal = () => {",
      "const onPageHide = () => flushToLocal();",
    );
    const saveFailureFallback = sourceBetween(
      editorPaneSource,
      "const snap = editorHandleRef.current?.getSnapshot?.();",
      "console.warn(\"[EditorPane] enqueue offline fallback failed:\"",
    );

    expect(pageHideFallback).toContain("contentFormat: note.contentFormat");
    expect(saveFailureFallback).toContain("contentFormat: currentNote.contentFormat");
  });

  it("manually syncs the live editor snapshot with the latest server version", () => {
    const manualSync = sourceBetween(
      editorPaneSource,
      "const handleManualSync = useCallback(async () => {",
      "const toggleFavorite = useCallback",
    );

    expect(manualSync).toContain("editorHandleRef.current?.getSnapshot?.()");
    expect(manualSync).toContain("editorHandleRef.current?.discardPending?.()");
    expect(manualSync).toContain("const persisted = await api.getNote(currentNote.id)");
    expect(manualSync).toContain("api.updateNoteConfirmed(currentNote.id");
    expect(manualSync).toContain("contentFormat: currentNote.contentFormat");
    expect(manualSync).toContain("version: persisted.version");
    expect(manualSync).toContain("syncToYjs: true");
  });

  it("does not replay normalized content with a newer version after a 409", () => {
    const normalizePersist = sourceBetween(
      editorPaneSource,
      "async function normalizeAndPersistOnSwitchRteToMd",
      "const lastActiveIdRef = useRef",
    );

    expect(normalizePersist).not.toContain("putWithReconcile({");
    expect(normalizePersist).toContain("is409Error(err)");
    expect(normalizePersist).toContain("saveDraft({");
  });

  it("does not silently retry AI title writes with latest version after a 409", () => {
    const aiTitle = sourceBetween(
      editorPaneSource,
      "const handleAITitle = useCallback(async () => {",
      "// AI �Ƽ���ǩ",
    );

    expect(aiTitle).not.toContain("getNoteSlim");
    expect(aiTitle).not.toContain("doUpdate(latest.version)");
    expect(aiTitle).toContain("is409Error");
  });

  it("does not REST-save Markdown document changes while CRDT is enabled", () => {
    const updateListener = sourceBetween(
      markdownEditorSource,
      "const updateListener = EditorView.updateListener.of((update) => {",
      "// MARKDOWN-PREVIEW-MODE-01",
    );
    const emitSave = sourceBetween(
      markdownEditorSource,
      "const emitSave = useCallback(() => {",
      "const scheduleSave = useCallback",
    );

    expect(updateListener).toContain("if (!collabEnabledRef.current)");
    expect(updateListener).toContain("scheduleSave();");
    expect(emitSave).toContain("title !== noteRef.current.title");
  });

  it("skips unchanged title-only editor updates before entering saving state", () => {
    const handleUpdatePrefix = sourceBetween(
      editorPaneSource,
      "const handleUpdate = useCallback(async",
      "actions.setSyncStatus(\"saving\");",
    );

    expect(handleUpdatePrefix).toContain("shouldSkipUnchangedTitleOnlyUpdate");
    expect(handleUpdatePrefix).toContain("return;");
  });

  it("defers standalone title saves until the title input blurs", () => {
    for (const source of [markdownEditorSource, tiptapEditorSource]) {
      const titleInput = sourceBetween(
        source,
        "ref={titleRef}",
        "className=",
      );

      expect(titleInput).toContain("onBlur={handleTitleBlur}");
      expect(titleInput).not.toContain("onChange={handleTitleChange}");
      expect(source).not.toContain("scheduleTitleSave");
    }
  });

  it("wires Markdown split resizing and preview task toggles to the editor", () => {
    expect(markdownEditorSource).toContain("handleSplitResizerPointerDown");
    expect(markdownEditorSource).toContain('role="separator"');
    expect(markdownEditorSource).toContain("sourcePaneWidthPercent");
    expect(markdownEditorSource).toContain("bg-app-hover/70");
    expect(markdownEditorSource).toContain("rounded-full");
    expect(markdownEditorSource).toContain("shadow-sm");
    expect(markdownEditorSource).toContain("handlePreviewTaskCheckboxChange");
    expect(markdownEditorSource).toContain("onTaskCheckboxChange={editable ? handlePreviewTaskCheckboxChange : undefined}");
    expect(markdownEditorSource).toContain("getMarkdownTaskCheckboxChangeAtOffset");
    expect(markdownEditorSource).toContain("posAtCoords");
    expect(markdownEditorSource).toContain("applyMarkdownTaskCheckboxChange");
  });

  it("localizes the Markdown split resize tooltip", () => {
    expect(zhCnLocale.markdown.view.resizeSplit).toBe("拖拽调整分屏宽度");
    expect(enLocale.markdown.view.resizeSplit).toBe("Drag to resize split panes");
  });

  it("keeps remote active-note refresh enabled in CRDT mode", () => {
    const applyRemote = sourceBetween(
      editorPaneSource,
      "async function applyRemoteNoteUpdate",
      "async function checkActiveNoteRemoteVersion",
    );
    const checkRemote = sourceBetween(
      editorPaneSource,
      "async function checkActiveNoteRemoteVersion",
      "const { presenceUsers",
    );

    expect(applyRemote).not.toContain("if (collabYDocRef.current) return;");
    expect(checkRemote).not.toContain("if (!cur || collabYDocRef.current) return;");
    expect(applyRemote).toContain("api.getNote(msg.noteId)");
    expect(applyRemote).toContain("collabSynced");
  });

  it("uses note:list-updated to refresh a stale active note", () => {
    const listUpdated = sourceBetween(
      editorPaneSource,
      "const offListUpdated = realtime.on(\"note:list-updated\"",
      "offListUpdated();",
    );

    expect(listUpdated).toContain("actions.updateNoteInList");
    expect(listUpdated).toContain("actions.updateNoteTab");
    expect(listUpdated).toContain("isRemoteVersionNewer");
    expect(listUpdated).toContain("applyRemoteNoteUpdate");
  });
});

describe("shared editing save safety", () => {
  it("preserves contentFormat across shared editing types and payloads", () => {
    const sharedContentType = sourceBetween(
      typesSource,
      "export interface SharedNoteContent",
      "// 版本历史",
    );
    const apiUpdateSharedContent = sourceBetween(
      apiSource,
      "updateSharedContent: async (",
      "// Phase 4: 同步轮询",
    );
    const fakeNote = sourceBetween(
      sharedNoteViewSource,
      "const fakeNoteForEditing = useMemo<Note | null>(() => {",
      "useEffect(() => {",
    );
    const guestSave = sourceBetween(
      sharedNoteViewSource,
      "const handleGuestSave = useCallback(async",
      "// 卸载时清理定时器",
    );

    expect(sharedContentType).toContain("contentFormat?: string | null");
    expect(apiUpdateSharedContent).toContain("contentFormat?: string | null");
    expect(fakeNote).toContain("contentFormat: content.contentFormat || \"tiptap-json\"");
    expect(guestSave).toContain("contentFormat: content.contentFormat || \"tiptap-json\"");
  });
});
