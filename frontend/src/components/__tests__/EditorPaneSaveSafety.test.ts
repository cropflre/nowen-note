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

const apiSource = readFileSync(
  path.resolve(__dirname, "../../lib/api.ts"),
  "utf8",
);

const typesSource = readFileSync(
  path.resolve(__dirname, "../../types/index.ts"),
  "utf8",
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

  it("includes contentFormat when manually syncing active note content", () => {
    const manualSync = sourceBetween(
      editorPaneSource,
      "const handleManualSync = useCallback(async () => {",
      "const toggleFavorite = useCallback",
    );

    expect(manualSync).toContain("contentFormat: activeNote.contentFormat");
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
      "const isReadOnlyContent =",
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
