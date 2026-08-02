from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    file = Path(path)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(text, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one literal match, found {count}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex match, found {count}")
    write(path, updated)


write("frontend/src/lib/editorLifecycleSafety.ts", '''import { shouldEmitTitleUpdate } from "@/lib/titleIme";

export type EditorLifecycleSaveMode = "none" | "title" | "content";

export function resolveEditorLifecycleSave({
  hasPendingContent,
  title,
  noteTitle,
  lastEmittedTitle,
  isTitleComposing,
}: {
  hasPendingContent: boolean;
  title: string;
  noteTitle: string;
  lastEmittedTitle: string;
  isTitleComposing: boolean;
}): EditorLifecycleSaveMode {
  if (hasPendingContent) return "content";
  if (isTitleComposing) return "none";
  return shouldEmitTitleUpdate({ title, noteTitle, lastEmittedTitle })
    ? "title"
    : "none";
}
''')

write("frontend/src/lib/__tests__/editorLifecycleSafety.test.ts", '''import { describe, expect, it } from "vitest";
import { resolveEditorLifecycleSave } from "@/lib/editorLifecycleSafety";

describe("editor lifecycle save safety", () => {
  it("flushes pending content even when the title is unchanged", () => {
    expect(resolveEditorLifecycleSave({
      hasPendingContent: true,
      title: "Title",
      noteTitle: "Title",
      lastEmittedTitle: "Title",
      isTitleComposing: false,
    })).toBe("content");
  });

  it("flushes a title-only edit when no body debounce exists", () => {
    expect(resolveEditorLifecycleSave({
      hasPendingContent: false,
      title: "New title",
      noteTitle: "Old title",
      lastEmittedTitle: "Old title",
      isTitleComposing: false,
    })).toBe("title");
  });

  it("does not emit an unchanged title during lifecycle events", () => {
    expect(resolveEditorLifecycleSave({
      hasPendingContent: false,
      title: "Title",
      noteTitle: "Title",
      lastEmittedTitle: "Title",
      isTitleComposing: false,
    })).toBe("none");
  });

  it("does not send an unfinished IME title without pending body content", () => {
    expect(resolveEditorLifecycleSave({
      hasPendingContent: false,
      title: "未完成输",
      noteTitle: "旧标题",
      lastEmittedTitle: "旧标题",
      isTitleComposing: true,
    })).toBe("none");
  });
});
''')

for path in (
    "frontend/src/components/TiptapEditor.tsx",
    "frontend/src/components/MarkdownEditorImpl.tsx",
):
    replace_once(
        path,
        'import { shouldEmitTitleUpdate, shouldSkipTitleChange, shouldSyncTitleValue } from "@/lib/titleIme";\n',
        'import { shouldEmitTitleUpdate, shouldSkipTitleChange, shouldSyncTitleValue } from "@/lib/titleIme";\nimport { resolveEditorLifecycleSave } from "@/lib/editorLifecycleSafety";\n',
    )

regex_once(
    "frontend/src/components/TiptapEditor.tsx",
    r'''      flushSave: \(\) => \{\n        if \(!editor\) return;\n        if \(!debounceTimer\.current\) return;\n.*?\n      \},\n      discardPending:''',
    '''      flushSave: () => {
        if (!editor) return;
        const title = isTitleComposingRef.current
          ? noteRef.current.title
          : titleRef.current?.value || noteRef.current.title;
        const mode = resolveEditorLifecycleSave({
          hasPendingContent: !!debounceTimer.current,
          title,
          noteTitle: noteRef.current.title,
          lastEmittedTitle: lastEmittedTitleRef.current,
          isTitleComposing: isTitleComposingRef.current,
        });
        if (mode === "none") return;
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
          debounceTimer.current = null;
        }
        if (mode === "title") {
          lastEmittedTitleRef.current = title;
          onUpdateRef.current({ title, _noteId: noteRef.current.id });
          return;
        }
        const json = JSON.stringify(editor.getJSON());
        const text = getEditorPlainTextForSave(editor, analysisCacheRef.current);
        lastEmittedTitleRef.current = title;
        onUpdateRef.current({
          content: json,
          contentText: text,
          title,
          _noteId: noteRef.current.id,
          _saveGeneration: ++saveGenerationRef.current,
        });
      },
      discardPending:''',
)

regex_once(
    "frontend/src/components/MarkdownEditorImpl.tsx",
    r'''      flushSave: \(\) => \{\n        if \(debounceTimer\.current\) \{\n          clearTimeout\(debounceTimer\.current\);\n          debounceTimer\.current = null;\n          emitSave\(\);\n        \}\n      \},\n      discardPending:''',
    '''      flushSave: () => {
        const title = isTitleComposingRef.current
          ? noteRef.current.title
          : titleRef.current?.value || noteRef.current.title;
        const mode = resolveEditorLifecycleSave({
          hasPendingContent: !!debounceTimer.current,
          title,
          noteTitle: noteRef.current.title,
          lastEmittedTitle: lastEmittedTitleRef.current,
          isTitleComposing: isTitleComposingRef.current,
        });
        if (mode === "none") return;
        if (debounceTimer.current) {
          clearTimeout(debounceTimer.current);
          debounceTimer.current = null;
        }
        if (mode === "content") {
          emitSave();
          return;
        }
        lastEmittedTitleRef.current = title;
        onUpdateRef.current({ title, _noteId: noteRef.current.id });
      },
      discardPending:''',
)

replace_once(
    "frontend/src/components/EditorPane.tsx",
    '''  function getCurrentEditorSnapshot(): { content: string; contentText: string } | null {
    try {
      const snap = editorHandleRef.current?.getSnapshot?.();
      return snap && typeof snap.content === "string" ? snap : null;
    } catch {
      return null;
    }
  }

  function hasLocalUnsavedChanges(): boolean {
    const cur = activeNoteRef.current;
    if (!cur) return false;
    if (syncStatusRef.current === "saving" || !!saveInflightRef.current) return true;
    const snap = getCurrentEditorSnapshot();
    if (!snap) return false;
    return snap.content !== cur.content || snap.contentText !== cur.contentText;
  }
''',
    '''  function getCurrentEditorSnapshot(): { content: string; contentText: string; title?: string } | null {
    try {
      const snap = editorHandleRef.current?.getSnapshot?.();
      return snap && typeof snap.content === "string" ? snap : null;
    } catch {
      return null;
    }
  }

  function persistCurrentEditorSnapshotDraft(): void {
    const current = activeNoteRef.current;
    if (!current || current.isLocked || viewLockedIdsRef.current.has(current.id)) return;
    const snapshot = getCurrentEditorSnapshot();
    if (!snapshot) return;
    const title = snapshot.title ?? current.title;
    if (
      snapshot.content === current.content
      && snapshot.contentText === current.contentText
      && title === current.title
    ) return;
    try {
      saveDraft({
        noteId: current.id,
        editorMode: editorModeRef.current,
        content: snapshot.content,
        contentText: snapshot.contentText,
        title,
        baseVersion: current.version,
        savedAt: Date.now(),
      });
    } catch {
      /* Local storage may be unavailable; flushSave still attempts the server write. */
    }
  }

  function hasLocalUnsavedChanges(): boolean {
    const cur = activeNoteRef.current;
    if (!cur) return false;
    if (syncStatusRef.current === "saving" || !!saveInflightRef.current) return true;
    const snap = getCurrentEditorSnapshot();
    if (!snap) return false;
    return snap.content !== cur.content
      || snap.contentText !== cur.contentText
      || (snap.title ?? cur.title) !== cur.title;
  }
''',
)

replace_once(
    "frontend/src/components/EditorPane.tsx",
    '''      try {
        const snapshot = editorHandleRef.current?.getSnapshot?.();
        if (snapshot && typeof snapshot.content === "string") {
          const next = {
            ...current,
            content: snapshot.content,
            contentText: snapshot.contentText,
          };
          activeNoteRef.current = next;
          actions.setActiveNote(next);
        }
      } catch {
        /* flushSave below remains the fallback when a snapshot is unavailable. */
      }

      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
''',
    '''      persistCurrentEditorSnapshotDraft();
      try {
        const snapshot = editorHandleRef.current?.getSnapshot?.();
        if (snapshot && typeof snapshot.content === "string") {
          const next = {
            ...current,
            title: snapshot.title ?? current.title,
            content: snapshot.content,
            contentText: snapshot.contentText,
          };
          activeNoteRef.current = next;
          actions.setActiveNote(next);
        }
      } catch {
        /* flushSave below remains the fallback when a snapshot is unavailable. */
      }

      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
''',
)

replace_once(
    "frontend/src/components/EditorPane.tsx",
    '''      publishEditorSplitMirrorUpdate(noteId, {
        title: current.title,
        content: snapshot.content,
''',
    '''      publishEditorSplitMirrorUpdate(noteId, {
        title: snapshot.title ?? current.title,
        content: snapshot.content,
''',
)

replace_once(
    "frontend/src/components/EditorPane.tsx",
    '''        activeNote.updatedAt,
        activeNote.content,
      )
''',
    '''        activeNote.updatedAt,
        activeNote.content,
        activeNote.title,
      )
''',
)

replace_once(
    "frontend/src/components/EditorPane.tsx",
    '''  useEffect(() => {
    const onBeforeUnload = () => {
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
''',
    '''  useEffect(() => {
    const flushLifecycleSave = () => {
      persistCurrentEditorSnapshotDraft();
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
    };
    window.addEventListener("beforeunload", flushLifecycleSave);
    window.addEventListener("pagehide", flushLifecycleSave);
    return () => {
      window.removeEventListener("beforeunload", flushLifecycleSave);
      window.removeEventListener("pagehide", flushLifecycleSave);
    };
  }, []);
''',
)

replace_once(
    "frontend/src/components/EditorPane.tsx",
    '''      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
    };
    window.addEventListener("nowen:before-note-switch", onBeforeNoteSwitch);
''',
    '''      persistCurrentEditorSnapshotDraft();
      try { editorHandleRef.current?.flushSave(); } catch { /* ignore */ }
    };
    window.addEventListener("nowen:before-note-switch", onBeforeNoteSwitch);
''',
)

replace_once(
    "frontend/src/lib/draftStorage.ts",
    '''export function shouldOfferRestore(
  draft: NoteDraft,
  serverVersion: number,
  serverUpdatedAt: string | undefined,
  serverContent: string | undefined,
): boolean {
''',
    '''export function shouldOfferRestore(
  draft: NoteDraft,
  serverVersion: number,
  serverUpdatedAt: string | undefined,
  serverContent: string | undefined,
  serverTitle?: string,
): boolean {
''',
)
replace_once(
    "frontend/src/lib/draftStorage.ts",
    '''  if (typeof serverContent === "string") {
    return serverContent !== draft.content;
  }
''',
    '''  if (typeof serverContent === "string") {
    const sameBody = serverContent === draft.content;
    const sameTitle = serverTitle === undefined || serverTitle === draft.title;
    return !(sameBody && sameTitle);
  }
''',
)

path = "frontend/src/lib/__tests__/draftStorage.conflict.test.ts"
text = read(path)
marker = '  it("allows a genuinely changed local body to start a new draft lineage", () => {'
if text.count(marker) != 1:
    raise SystemExit(f"{path}: title-test insertion marker not found exactly once")
tests = '''  it("offers restore for a title-only draft when the server body matches", () => {
    const draft = {
      noteId: "note-title-only",
      editorMode: "tiptap" as const,
      title: "Unsaved title",
      content: "same body",
      contentText: "same body",
      baseVersion: 4,
      savedAt: Date.now(),
    };

    expect(shouldOfferRestore(
      draft,
      4,
      "2099-01-01T00:00:00.000Z",
      "same body",
      "Persisted title",
    )).toBe(true);
  });

  it("does not offer restore when both title and body already match", () => {
    const draft = {
      noteId: "note-title-persisted",
      editorMode: "md" as const,
      title: "Persisted title",
      content: "same body",
      contentText: "same body",
      baseVersion: 4,
      savedAt: Date.now(),
    };

    expect(shouldOfferRestore(
      draft,
      5,
      "2020-01-01T00:00:00.000Z",
      "same body",
      "Persisted title",
    )).toBe(false);
  });

'''
write(path, text.replace(marker, tests + marker, 1))

ci_path = ".github/workflows/issue-612-data-protection-ci.yml"
ci = read(ci_path)
ci = ci.replace(
    '      - "frontend/src/hooks/useYDoc.ts"\n',
    '      - "frontend/src/hooks/useYDoc.ts"\n      - "frontend/src/components/EditorPane.tsx"\n      - "frontend/src/components/TiptapEditor.tsx"\n      - "frontend/src/components/MarkdownEditorImpl.tsx"\n      - "frontend/src/lib/editorLifecycleSafety.ts"\n',
)
ci = ci.replace(
    '      - "frontend/src/lib/__tests__/draftStorage.conflict.test.ts"\n',
    '      - "frontend/src/lib/__tests__/draftStorage.conflict.test.ts"\n      - "frontend/src/lib/__tests__/editorLifecycleSafety.test.ts"\n',
)
ci = ci.replace(
    '          src/lib/__tests__/draftStorage.conflict.test.ts\n',
    '          src/lib/__tests__/draftStorage.conflict.test.ts\n          src/lib/__tests__/editorLifecycleSafety.test.ts\n',
    1,
)
write(ci_path, ci)
