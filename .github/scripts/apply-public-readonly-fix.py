from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    target.write_text(source.replace(old, new, 1), encoding="utf-8")


def replace_exact_count(path: str, old: str, new: str, expected: int, label: str) -> None:
    target = Path(path)
    source = target.read_text(encoding="utf-8")
    count = source.count(old)
    if count != expected:
        raise SystemExit(f"{label}: expected {expected} matches, got {count}")
    target.write_text(source.replace(old, new), encoding="utf-8")


def write_file(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


write_file(
    "frontend/src/lib/notePermissions.ts",
    '''import type { Note } from "@/types";

type NoteWithPermission = Pick<Note, "permission"> | null | undefined;

/**
 * Whether the current user may modify a note.
 *
 * `permission` was added after personal notes already existed. Treating an
 * absent value as writable preserves compatibility, while explicit shared
 * `read` / `comment` permissions must remain read-only.
 */
export function canWriteNote(note: NoteWithPermission): boolean {
  const permission = note?.permission;
  return permission == null || permission === "write" || permission === "manage";
}
''',
)

replace_once(
    "frontend/src/components/EditorPane.tsx",
    '''import {
  isRemoteVersionNewer,
  shouldSkipUnchangedTitleOnlyUpdate,
} from "@/lib/editorSyncGuards";
''',
    '''import {
  isRemoteVersionNewer,
  shouldSkipUnchangedTitleOnlyUpdate,
} from "@/lib/editorSyncGuards";
import { canWriteNote } from "@/lib/notePermissions";
''',
    "EditorPane permission import",
)
replace_once(
    "frontend/src/components/EditorPane.tsx",
    '''  const effectiveLocked = !!activeNote?.isLocked || isViewLocked || isTrashed;
  const showDesktopOutline = showOutline && !state.editorFullscreen;
''',
    '''  const effectiveLocked = !!activeNote?.isLocked || isViewLocked || isTrashed;
  const canEditActiveNote = canWriteNote(activeNote);
  const showDesktopOutline = showOutline && !state.editorFullscreen;
''',
    "EditorPane permission state",
)
replace_exact_count(
    "frontend/src/components/EditorPane.tsx",
    "editable={!effectiveLocked && !modeSwitching}",
    "editable={canEditActiveNote && !effectiveLocked && !modeSwitching}",
    3,
    "EditorPane editor permission gates",
)

replace_once(
    "frontend/src/components/EditorSplitView.tsx",
    '''import { toast } from "@/lib/toast";
import type { Note } from "@/types";
''',
    '''import { toast } from "@/lib/toast";
import { canWriteNote } from "@/lib/notePermissions";
import type { Note } from "@/types";
''',
    "EditorSplitView permission import",
)
replace_once(
    "frontend/src/components/EditorSplitView.tsx",
    '''    if (!current || (data._noteId && data._noteId !== current.id)) return;
''',
    '''    if (!current || !canWriteNote(current) || (data._noteId && data._noteId !== current.id)) return;
''',
    "EditorSplitView stale update permission guard",
)
replace_once(
    "frontend/src/components/EditorSplitView.tsx",
    '''  const editable = !!note && !note.isLocked && !note.isTrashed;
''',
    '''  const editable = !!note && canWriteNote(note) && !note.isLocked && !note.isTrashed;
''',
    "EditorSplitView editable permission gate",
)

replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''type TiptapEditorProps = NoteEditorProps;
''',
    '''type TiptapEditorProps = NoteEditorProps & {
  /** Published/read-only embedding: render document content without editor chrome. */
  presentationMode?: boolean;
};
''',
    "Tiptap presentation prop",
)
replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''  { note, onUpdate, onTagsChange, onHeadingsChange, onEditorReady, onOpenNote, editable = true, isGuest = false, searchQuery },
''',
    '''  { note, onUpdate, onTagsChange, onHeadingsChange, onEditorReady, onOpenNote, editable = true, isGuest = false, presentationMode = false, searchQuery },
''',
    "Tiptap presentation destructuring",
)
replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''    <div className="flex flex-col h-full relative">
''',
    '''    <div className={cn("flex flex-col h-full relative", presentationMode && "tiptap-presentation-mode")}>
''',
    "Tiptap presentation root marker",
)
replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''      <div
        className={cn(
          "editor-toolbar-scroll-fade''',
    '''      {!presentationMode && (
      <div
        className={cn(
          "editor-toolbar-scroll-fade''',
    "Tiptap hide toolbar start",
)
replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''      </div>

      {/* 查找替换浮窗：依附最外层 relative，右上角应于序列。''',
    '''      </div>
      )}

      {/* 查找替换浮窗：依附最外层 relative，右上角应于序列。''',
    "Tiptap hide toolbar end",
)
replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''      {editor && (
        <SearchReplacePanel
''',
    '''      {editor && !presentationMode && (
        <SearchReplacePanel
''',
    "Tiptap hide search panel in presentation mode",
)
replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''      {/* Title */}
      <div className="px-4 md:px-8 pt-4 md:pt-6 pb-0">
''',
    '''      {/* Title */}
      {!presentationMode && (
      <div className="px-4 md:px-8 pt-4 md:pt-6 pb-0">
''',
    "Tiptap hide title start",
)
replace_once(
    "frontend/src/components/TiptapEditor.tsx",
    '''      </div>

      {/* Tag Bar：访客模式下隐藏（TagInput 依赖 AppProvider + 登录态 API） */}''',
    '''      </div>
      )}

      {/* Tag Bar：访客模式下隐藏（TagInput 依赖 AppProvider + 登录态 API） */}''',
    "Tiptap hide title end",
)

replace_once(
    "frontend/src/components/PublicNotebookView.tsx",
    '''                    <TiptapEditor note={fakeNote} editable={false} onUpdate={() => undefined} isGuest />
''',
    '''                    <TiptapEditor
                      note={fakeNote}
                      editable={false}
                      onUpdate={() => undefined}
                      isGuest
                      presentationMode
                    />
''',
    "Public notebook presentation mode",
)

write_file(
    "frontend/src/components/__tests__/PublicNotebookReadOnlyPermissions.test.ts",
    '''import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canWriteNote } from "../../lib/notePermissions";

const editorPaneSource = readFileSync(path.resolve(__dirname, "../EditorPane.tsx"), "utf8");
const splitViewSource = readFileSync(path.resolve(__dirname, "../EditorSplitView.tsx"), "utf8");
const publicViewSource = readFileSync(path.resolve(__dirname, "../PublicNotebookView.tsx"), "utf8");
const tiptapSource = readFileSync(path.resolve(__dirname, "../TiptapEditor.tsx"), "utf8");

describe("shared note read-only permissions", () => {
  it("only grants write access to explicit write/manage permissions", () => {
    expect(canWriteNote(undefined)).toBe(true);
    expect(canWriteNote({ permission: undefined } as any)).toBe(true);
    expect(canWriteNote({ permission: "manage" } as any)).toBe(true);
    expect(canWriteNote({ permission: "write" } as any)).toBe(true);
    expect(canWriteNote({ permission: "comment" } as any)).toBe(false);
    expect(canWriteNote({ permission: "read" } as any)).toBe(false);
  });

  it("gates every main editor mode with the active note permission", () => {
    expect(editorPaneSource).toContain('import { canWriteNote } from "@/lib/notePermissions";');
    expect(editorPaneSource).toContain("const canEditActiveNote = canWriteNote(activeNote);");
    const gates = editorPaneSource.match(
      /editable=\{canEditActiveNote && !effectiveLocked && !modeSwitching\}/g,
    ) || [];
    expect(gates).toHaveLength(3);
  });

  it("keeps the split editor read-only and ignores stale update callbacks", () => {
    expect(splitViewSource).toContain('import { canWriteNote } from "@/lib/notePermissions";');
    expect(splitViewSource).toContain(
      "const editable = !!note && canWriteNote(note) && !note.isLocked && !note.isTrashed;",
    );
    expect(splitViewSource).toContain(
      "if (!current || !canWriteNote(current) || (data._noteId && data._noteId !== current.id)) return;",
    );
  });

  it("uses a chrome-free Tiptap presentation mode on public pages", () => {
    expect(publicViewSource).toContain("presentationMode");
    expect(publicViewSource).toContain("editable={false}");
    expect(tiptapSource).toContain("presentationMode?: boolean;");
    expect(tiptapSource).toContain('presentationMode && "tiptap-presentation-mode"');
    expect(tiptapSource).toContain("{!presentationMode && (");
    expect(tiptapSource).toContain("editor && !presentationMode");
  });
});
''',
)
