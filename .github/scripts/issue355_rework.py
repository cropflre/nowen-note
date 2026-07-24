from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one occurrence, found {count}: {old[:80]!r}")
    write(path, text.replace(old, new, 1))


frontend_projection = r'''export type InternalMarkdownMarkerKind = "inline" | "line";

export interface InternalMarkdownMarkerRange {
  from: number;
  to: number;
  kind: InternalMarkdownMarkerKind;
  blockId: string;
}

const INLINE_MARKER_RE = /[ \t]+\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
const LINE_MARKER_RE = /^[ \t]*\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Locate Nowen's reserved Markdown block markers while respecting fenced code blocks.
 * The returned offsets refer to the original internal Markdown string.
 */
export function findInternalMarkdownMarkerRanges(markdown: string): InternalMarkdownMarkerRange[] {
  if (!markdown || !markdown.includes("^blk_")) return [];
  const ranges: InternalMarkdownMarkerRange[] = [];
  let offset = 0;
  let fenceChar = "";
  let fenceLength = 0;

  while (offset <= markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const lineEndWithNewline = newline < 0 ? markdown.length : newline + 1;
    const line = markdown.slice(offset, lineEnd);

    if (fenceChar) {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`);
      if (closeRe.test(line)) {
        fenceChar = "";
        fenceLength = 0;
      }
    } else {
      const opener = line.match(FENCE_OPEN_RE);
      if (opener) {
        fenceChar = opener[1][0];
        fenceLength = opener[1].length;
      } else {
        const standalone = line.match(LINE_MARKER_RE);
        if (standalone) {
          ranges.push({
            from: offset,
            to: lineEndWithNewline,
            kind: "line",
            blockId: standalone[1],
          });
        } else {
          const inline = line.match(INLINE_MARKER_RE);
          if (inline && inline.index != null) {
            ranges.push({
              from: offset + inline.index,
              to: lineEnd,
              kind: "inline",
              blockId: inline[1],
            });
          }
        }
      }
    }

    if (newline < 0) break;
    offset = lineEndWithNewline;
  }

  return ranges;
}

/** Project internal Markdown into user-visible Markdown without changing persisted block identity. */
export function projectMarkdownForUser(markdown: string): string {
  const ranges = findInternalMarkdownMarkerRanges(markdown);
  if (ranges.length === 0) return markdown;
  let output = markdown;
  for (const range of [...ranges].sort((a, b) => b.from - a.from)) {
    output = output.slice(0, range.from) + output.slice(range.to);
  }
  return output;
}
'''
write("frontend/src/lib/markdownUserContent.ts", frontend_projection)

frontend_markers = r'''import { RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  findInternalMarkdownMarkerRanges,
  projectMarkdownForUser,
} from "@/lib/markdownUserContent";

function buildMarkerDecorations(markdown: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of findInternalMarkdownMarkerRanges(markdown)) {
    if (range.kind === "line") {
      builder.add(
        range.from,
        range.from,
        Decoration.line({ attributes: { class: "cm-nowen-internal-block-marker-line" } }),
      );
    } else {
      builder.add(range.from, range.to, Decoration.replace({}));
    }
  }
  return builder.finish();
}

const markerField = StateField.define<DecorationSet>({
  create(state) {
    return buildMarkerDecorations(state.doc.toString());
  },
  update(value, transaction) {
    return transaction.docChanged
      ? buildMarkerDecorations(transaction.state.doc.toString())
      : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const markerTheme = EditorView.baseTheme({
  ".cm-nowen-internal-block-marker-line": {
    display: "none",
  },
});

const cleanClipboard = EditorView.domEventHandlers({
  copy(event, view) {
    if (!event.clipboardData || view.state.selection.ranges.every((range) => range.empty)) {
      return false;
    }
    const selected = view.state.selection.ranges
      .map((range) => view.state.doc.sliceString(range.from, range.to))
      .join("\n");
    event.clipboardData.setData("text/plain", projectMarkdownForUser(selected));
    event.preventDefault();
    return true;
  },
});

export const internalMarkdownMarkerExtensions: Extension[] = [
  markerField,
  markerTheme,
  cleanClipboard,
];
'''
write("frontend/src/lib/markdownInternalMarkers.ts", frontend_markers)

routing = r'''import type { EditorMode } from "@/lib/editorMode";

export type NoteEditorKind = "markdown" | "tiptap" | "html-preview";

export function resolveNoteEditorKind(contentFormat: string | null | undefined): NoteEditorKind {
  if (contentFormat === "markdown") return "markdown";
  if (contentFormat === "html") return "html-preview";
  return "tiptap";
}

export function editorModeForNoteEditorKind(kind: NoteEditorKind): EditorMode {
  return kind === "markdown" ? "md" : "tiptap";
}
'''
write("frontend/src/lib/noteEditorRouting.ts", routing)

format_aware = r'''import { useLayoutEffect, useMemo, useState } from "react";
import EditorPane from "@/components/EditorPane";
import { useApp } from "@/store/AppContext";
import { setActiveNoteEditorModeOverride } from "@/lib/editorMode";
import {
  editorModeForNoteEditorKind,
  resolveNoteEditorKind,
} from "@/lib/noteEditorRouting";

/**
 * Route an existing note by its persisted contentFormat before EditorPane mounts.
 * This override is in-memory and note-scoped: it neither mutates the user's global
 * editor preference nor allows the debug URL flag to open an incompatible editor.
 */
export default function FormatAwareEditorPane() {
  const { state } = useApp();
  const note = state.activeNote;
  const kind = resolveNoteEditorKind(note?.contentFormat);
  const mode = editorModeForNoteEditorKind(kind);
  const editorKey = useMemo(
    () => note ? `${note.id}:${kind}` : "empty",
    [kind, note?.id],
  );
  const [preparedKey, setPreparedKey] = useState<string>(() => note ? "" : "empty");

  useLayoutEffect(() => {
    if (!note) {
      setActiveNoteEditorModeOverride(null);
      setPreparedKey("empty");
      return;
    }

    setActiveNoteEditorModeOverride(mode);
    setPreparedKey(editorKey);
    return () => setActiveNoteEditorModeOverride(null);
  }, [editorKey, mode, note?.id]);

  if (note && preparedKey !== editorKey) {
    return <div className="flex-1 min-h-0 bg-app-bg" aria-hidden="true" />;
  }

  return <EditorPane key={editorKey} />;
}
'''
write("frontend/src/components/FormatAwareEditorPane.tsx", format_aware)

routing_test = r'''import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FormatAwareEditorPane from "../FormatAwareEditorPane";
import {
  EDITOR_MODE_CHANGE_EVENT,
  EDITOR_MODE_KEY,
  resolveEditorMode,
} from "@/lib/editorMode";
import { resolveNoteEditorKind } from "@/lib/noteEditorRouting";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  state: {
    activeNote: null as null | { id: string; contentFormat?: string },
  },
}));

vi.mock("@/store/AppContext", () => ({
  useApp: () => ({ state: mocks.state }),
}));

vi.mock("@/components/EditorPane", () => ({
  default: () => <div data-testid="editor-pane" />,
}));

describe("FormatAwareEditorPane", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    mocks.state.activeNote = null;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
  });

  async function render() {
    await act(async () => {
      root.render(<FormatAwareEditorPane />);
    });
  }

  it("Markdown note overrides an incompatible URL mode without mutating global preference", async () => {
    localStorage.setItem(EDITOR_MODE_KEY, "tiptap");
    window.history.replaceState(null, "", "/?md=0");
    mocks.state.activeNote = { id: "md-note", contentFormat: "markdown" };

    await render();

    expect(resolveEditorMode()).toBe("md");
    expect(localStorage.getItem(EDITOR_MODE_KEY)).toBe("tiptap");
    expect(document.querySelector('[data-testid="editor-pane"]')).not.toBeNull();
  });

  it("Tiptap note overrides ?md=1 and remains on the rich-text path", async () => {
    window.history.replaceState(null, "", "/?md=1");
    mocks.state.activeNote = { id: "rich-note", contentFormat: "tiptap-json" };

    await render();

    expect(resolveEditorMode()).toBe("tiptap");
  });

  it("routes HTML through the explicit preview kind", () => {
    expect(resolveNoteEditorKind("html")).toBe("html-preview");
  });

  it("switches note-scoped mode without broadcasting a global preference change", async () => {
    const onPreferenceChange = vi.fn();
    window.addEventListener(EDITOR_MODE_CHANGE_EVENT, onPreferenceChange);
    mocks.state.activeNote = { id: "md-note", contentFormat: "markdown" };
    await render();
    expect(resolveEditorMode()).toBe("md");

    mocks.state.activeNote = { id: "rich-note", contentFormat: "tiptap-json" };
    await render();

    expect(resolveEditorMode()).toBe("tiptap");
    expect(onPreferenceChange).not.toHaveBeenCalled();
    window.removeEventListener(EDITOR_MODE_CHANGE_EVENT, onPreferenceChange);
  });
});
'''
write("frontend/src/components/__tests__/FormatAwareEditorPane.test.tsx", routing_test)

frontend_projection_test = r'''import { describe, expect, it } from "vitest";
import {
  findInternalMarkdownMarkerRanges,
  projectMarkdownForUser,
} from "../markdownUserContent";

describe("projectMarkdownForUser", () => {
  it("removes inline and post-fence system markers while preserving code contents", () => {
    const source = [
      "# 标题 ^blk_heading1",
      "",
      "正文 ^blk_para001",
      "",
      "```ts",
      "const value = '^blk_inside';",
      "```",
      "^blk_code001",
      "",
      "尾声",
    ].join("\n");

    expect(projectMarkdownForUser(source)).toBe([
      "# 标题",
      "",
      "正文",
      "",
      "```ts",
      "const value = '^blk_inside';",
      "```",
      "",
      "尾声",
    ].join("\n"));
  });

  it("returns source offsets for editor decorations", () => {
    const source = "a ^blk_abcdef\n^blk_ghijkl\n";
    expect(findInternalMarkdownMarkerRanges(source).map(({ kind, blockId }) => ({ kind, blockId }))).toEqual([
      { kind: "inline", blockId: "blk_abcdef" },
      { kind: "line", blockId: "blk_ghijkl" },
    ]);
  });
});
'''
write("frontend/src/lib/__tests__/markdownUserContent.test.ts", frontend_projection_test)

backend_projection = r'''import type Database from "better-sqlite3";

export interface MarkdownNoteForProjection {
  id: string;
  content: string;
  contentFormat: string;
  [key: string]: unknown;
}

const INLINE_MARKER_RE = /[ \t]+\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
const LINE_MARKER_RE = /^[ \t]*\^(blk_[A-Za-z0-9_-]{6,})[ \t]*$/;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/**
 * Remove reserved block markers from a user-facing Markdown projection.
 * When knownBlockIds is supplied, only markers owned by the note index are removed.
 */
export function projectMarkdownForUser(
  markdown: string,
  knownBlockIds?: ReadonlySet<string>,
): string {
  if (!markdown || !markdown.includes("^blk_")) return markdown;
  const removals: Array<{ from: number; to: number }> = [];
  let offset = 0;
  let fenceChar = "";
  let fenceLength = 0;

  const owned = (blockId: string) => !knownBlockIds || knownBlockIds.has(blockId);

  while (offset <= markdown.length) {
    const newline = markdown.indexOf("\n", offset);
    const lineEnd = newline < 0 ? markdown.length : newline;
    const lineEndWithNewline = newline < 0 ? markdown.length : newline + 1;
    const line = markdown.slice(offset, lineEnd);

    if (fenceChar) {
      const closeRe = new RegExp(`^[ \\t]{0,3}${fenceChar}{${fenceLength},}[ \\t]*$`);
      if (closeRe.test(line)) {
        fenceChar = "";
        fenceLength = 0;
      }
    } else {
      const opener = line.match(FENCE_OPEN_RE);
      if (opener) {
        fenceChar = opener[1][0];
        fenceLength = opener[1].length;
      } else {
        const standalone = line.match(LINE_MARKER_RE);
        if (standalone && owned(standalone[1])) {
          removals.push({ from: offset, to: lineEndWithNewline });
        } else {
          const inline = line.match(INLINE_MARKER_RE);
          if (inline && inline.index != null && owned(inline[1])) {
            removals.push({ from: offset + inline.index, to: lineEnd });
          }
        }
      }
    }

    if (newline < 0) break;
    offset = lineEndWithNewline;
  }

  let output = markdown;
  for (const removal of removals.sort((a, b) => b.from - a.from)) {
    output = output.slice(0, removal.from) + output.slice(removal.to);
  }
  return output;
}

export function projectMarkdownNoteForUser<T extends MarkdownNoteForProjection>(
  db: Database.Database,
  note: T,
): T {
  if (!note || note.contentFormat !== "markdown" || typeof note.content !== "string") return note;
  try {
    const rows = db.prepare(
      "SELECT blockId FROM note_blocks_index WHERE noteId = ?",
    ).all(note.id) as Array<{ blockId: string }>;
    if (rows.length === 0) return note;
    const known = new Set(rows.map((row) => row.blockId));
    return { ...note, content: projectMarkdownForUser(note.content, known) };
  } catch {
    return note;
  }
}
'''
write("backend/src/lib/markdownUserContent.ts", backend_projection)

backend_projection_test = r'''import assert from "node:assert/strict";
import test from "node:test";
import { projectMarkdownForUser } from "../src/lib/markdownUserContent";

test("projects only indexed Markdown block markers", () => {
  const source = [
    "# 标题 ^blk_heading1",
    "用户保留 ^blk_unknown1",
    "```",
    "^blk_heading1",
    "```",
    "^blk_code001",
    "尾声",
  ].join("\n");
  const visible = projectMarkdownForUser(
    source,
    new Set(["blk_heading1", "blk_code001"]),
  );
  assert.equal(visible, [
    "# 标题",
    "用户保留 ^blk_unknown1",
    "```",
    "^blk_heading1",
    "```",
    "尾声",
  ].join("\n"));
});
'''
write("backend/tests/markdown-user-content.test.ts", backend_projection_test)

# Editor mode: note-scoped in-memory override takes precedence over debug URL and persisted preference.
replace_once(
    "frontend/src/lib/editorMode.ts",
    'const URL_FORCE_KEY = "md";\n',
    '''const URL_FORCE_KEY = "md";\n\nlet activeNoteEditorModeOverride: EditorMode | null = null;\n\nexport function setActiveNoteEditorModeOverride(mode: EditorMode | null): void {\n  activeNoteEditorModeOverride = mode;\n}\n''',
)
replace_once(
    "frontend/src/lib/editorMode.ts",
    'export function resolveEditorMode(defaultMode: EditorMode = "tiptap"): EditorMode {\n  try {',
    'export function resolveEditorMode(defaultMode: EditorMode = "tiptap"): EditorMode {\n  if (activeNoteEditorModeOverride) return activeNoteEditorModeOverride;\n  try {',
)

# First-party clients explicitly request the internal representation used by block patch/Yjs.
replace_once(
    "frontend/src/lib/api.impl.ts",
    '    const buildHeaders = (includeConnId: boolean): HeadersInit => ({\n      "Content-Type": "application/json",',
    '    const buildHeaders = (includeConnId: boolean): HeadersInit => ({\n      "Content-Type": "application/json",\n      "X-Nowen-Content-View": "internal",',
)
replace_once(
    "frontend/src/lib/api.ts",
    '      "Content-Type": "application/json",\n      ...(token ? { Authorization: `Bearer ${token}` } : {}),',
    '      "Content-Type": "application/json",\n      "X-Nowen-Content-View": "internal",\n      ...(token ? { Authorization: `Bearer ${token}` } : {}),',
)

# User-facing projection in preview/plain-text paths.
replace_once(
    "frontend/src/components/MarkdownPreview.tsx",
    'import { preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";',
    'import { preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";\nimport { projectMarkdownForUser } from "@/lib/markdownUserContent";',
)
replace_once(
    "frontend/src/components/MarkdownPreview.tsx",
    'preprocessMarkdownVideos((markdown || "")',
    'preprocessMarkdownVideos(projectMarkdownForUser(markdown || "")',
)
replace_once(
    "frontend/src/lib/contentFormat.ts",
    'import { preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";',
    'import { preprocessInternalNoteLinks } from "@/lib/noteLinkSyntax";\nimport { projectMarkdownForUser } from "@/lib/markdownUserContent";',
)
replace_once(
    "frontend/src/lib/contentFormat.ts",
    '  let text = md;\n',
    '  let text = projectMarkdownForUser(md);\n',
)

# CodeMirror keeps internal markers in the document but hides them and cleans clipboard output.
replace_once(
    "frontend/src/components/MarkdownEditorImpl.tsx",
    'import { normalizeToMarkdown, markdownToPlainText } from "@/lib/contentFormat";',
    'import { normalizeToMarkdown, markdownToPlainText } from "@/lib/contentFormat";\nimport { internalMarkdownMarkerExtensions } from "@/lib/markdownInternalMarkers";',
)
replace_once(
    "frontend/src/components/MarkdownEditorImpl.tsx",
    '        EditorView.lineWrapping,\n        EditorView.contentAttributes.of({ spellcheck: "false" }),',
    '        EditorView.lineWrapping,\n        ...internalMarkdownMarkerExtensions,\n        EditorView.contentAttributes.of({ spellcheck: "false" }),',
)
replace_once(
    "frontend/src/components/LargeMarkdownSafeEditor.tsx",
    'import { normalizeToMarkdown } from "@/lib/contentFormat";',
    'import { normalizeToMarkdown } from "@/lib/contentFormat";\nimport { internalMarkdownMarkerExtensions } from "@/lib/markdownInternalMarkers";',
)
replace_once(
    "frontend/src/components/LargeMarkdownSafeEditor.tsx",
    '        performanceCompartmentRef.current.of(performanceExtensions(runtimeDecision.mode)),\n        EditorView.contentAttributes.of({',
    '        performanceCompartmentRef.current.of(performanceExtensions(runtimeDecision.mode)),\n        ...internalMarkdownMarkerExtensions,\n        EditorView.contentAttributes.of({',
)

# REST defaults to clean Markdown; trusted first-party clients opt into internal content with a header.
replace_once(
    "backend/src/routes/notes.ts",
    'import { Hono } from "hono";',
    'import { Hono } from "hono";\nimport { projectMarkdownNoteForUser } from "../lib/markdownUserContent";',
)
replace_once(
    "backend/src/routes/notes.ts",
    'const app = new Hono();\n',
    '''const app = new Hono();\n\nfunction wantsInternalNoteContent(c: any): boolean {\n  return c.req.header("X-Nowen-Content-View") === "internal";\n}\n\nfunction presentNoteForResponse(db: any, c: any, note: any): any {\n  if (!note || wantsInternalNoteContent(c)) return note;\n  return projectMarkdownNoteForUser(db, note);\n}\n''',
)
replace_once(
    "backend/src/routes/notes.ts",
    '  return c.json({ ...note as any, tags, permission });',
    '  const responseNote = presentNoteForResponse(db, c, note);\n  return c.json({ ...responseNote as any, tags, permission });',
)
replace_once(
    "backend/src/routes/notes.ts",
    '  return c.json({ ...note as any, tags: [] }, 201);',
    '  const responseNote = presentNoteForResponse(db, c, note);\n  return c.json({ ...responseNote as any, tags: [] }, 201);',
)
replace_once(
    "backend/src/routes/notes.ts",
    '  return c.json({ ...note as any, tags });',
    '  const responseNote = presentNoteForResponse(db, c, note);\n  return c.json({ ...responseNote as any, tags });',
)

# Exported Markdown is always user-facing and must never contain internal block markers.
replace_once(
    "backend/src/routes/export.ts",
    'import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";',
    'import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";\nimport { projectMarkdownForUser } from "../lib/markdownUserContent";',
)
replace_once(
    "backend/src/routes/export.ts",
    '  const notes = wsParam === null ? stmt.all(userId) : stmt.all(userId, wsParam);\n\n  return c.json(notes);',
    '''  const notes = (wsParam === null ? stmt.all(userId) : stmt.all(userId, wsParam)) as any[];\n  const visibleNotes = notes.map((note) => note.contentFormat === "markdown"\n    ? { ...note, content: projectMarkdownForUser(note.content || "") }\n    : note);\n\n  return c.json(visibleNotes);''',
)

permanent_ci = r'''name: Issue 355 Content Format CI

on:
  push:
    branches: [main]
    paths:
      - "backend/src/lib/markdownUserContent.ts"
      - "backend/src/routes/notes.ts"
      - "backend/src/routes/export.ts"
      - "backend/tests/markdown-user-content.test.ts"
      - "frontend/src/lib/editorMode.ts"
      - "frontend/src/lib/noteEditorRouting.ts"
      - "frontend/src/lib/markdownUserContent.ts"
      - "frontend/src/lib/markdownInternalMarkers.ts"
      - "frontend/src/lib/contentFormat.ts"
      - "frontend/src/lib/api.impl.ts"
      - "frontend/src/lib/api.ts"
      - "frontend/src/components/FormatAwareEditorPane.tsx"
      - "frontend/src/components/MarkdownEditorImpl.tsx"
      - "frontend/src/components/LargeMarkdownSafeEditor.tsx"
      - "frontend/src/components/MarkdownPreview.tsx"
      - "frontend/src/components/__tests__/FormatAwareEditorPane.test.tsx"
      - "frontend/src/lib/__tests__/markdownUserContent.test.ts"
      - ".github/workflows/issue-355-content-format-ci.yml"
  pull_request:
    paths:
      - "backend/src/lib/markdownUserContent.ts"
      - "backend/src/routes/notes.ts"
      - "backend/src/routes/export.ts"
      - "backend/tests/markdown-user-content.test.ts"
      - "frontend/src/lib/editorMode.ts"
      - "frontend/src/lib/noteEditorRouting.ts"
      - "frontend/src/lib/markdownUserContent.ts"
      - "frontend/src/lib/markdownInternalMarkers.ts"
      - "frontend/src/lib/contentFormat.ts"
      - "frontend/src/lib/api.impl.ts"
      - "frontend/src/lib/api.ts"
      - "frontend/src/components/FormatAwareEditorPane.tsx"
      - "frontend/src/components/MarkdownEditorImpl.tsx"
      - "frontend/src/components/LargeMarkdownSafeEditor.tsx"
      - "frontend/src/components/MarkdownPreview.tsx"
      - "frontend/src/components/__tests__/FormatAwareEditorPane.test.tsx"
      - "frontend/src/lib/__tests__/markdownUserContent.test.ts"
      - ".github/workflows/issue-355-content-format-ci.yml"

permissions:
  contents: read

jobs:
  backend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: backend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: backend/package-lock.json
      - run: npm ci
      - run: node --import tsx --test tests/markdown-user-content.test.ts
      - run: npm run build:tsc

  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: >-
          npm run test:run --
          src/lib/__tests__/markdownUserContent.test.ts
          src/components/__tests__/FormatAwareEditorPane.test.tsx
      - run: npx tsc -b
'''
write(".github/workflows/issue-355-content-format-ci.yml", permanent_ci)

# Remove the one-shot mutation machinery from the final feature commit.
for temporary in [
    ".github/scripts/issue355_rework.py",
    ".github/workflows/issue-355-rework.yml",
]:
    target = ROOT / temporary
    if target.exists():
        target.unlink()

print("Issue #355 rework applied successfully")
