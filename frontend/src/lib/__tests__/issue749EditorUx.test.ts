import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CODE_BLOCK_LONG_COLLAPSE_LINES,
  normalizeCodeBlockCollapseMode,
  shouldCollapseCodeBlock,
} from "../codeBlockPresentation";
import { ALL_NOTE_ICONS, getVirtualIconRows, searchNoteIcons } from "../noteIconRegistry";
import { DEFAULT_USER_PREFERENCES, normalizeUserPreferences } from "../userPreferenceAccountCache";

const source = (relativePath: string) => readFileSync(path.resolve(__dirname, relativePath), "utf8");

describe("issue #749 editor UX", () => {
  it("keeps manual Markdown parsing on the existing rich-text parser path", () => {
    const tiptap = source("../../components/TiptapEditor.tsx");
    expect(tiptap).toContain("handleForceMarkdownConversion");
    expect(tiptap).toContain('t("tiptap.markdownForceConvert")');
    expect(tiptap).toContain("mdToFullHtml(text) || markdownToSimpleHtml(text)");
  });

  it("uses a display-only synced code-block collapse preference", () => {
    expect(DEFAULT_USER_PREFERENCES.codeBlockCollapseMode).toBe("long");
    expect(normalizeUserPreferences({ codeBlockCollapseMode: "collapsed" }).codeBlockCollapseMode).toBe("collapsed");
    expect(normalizeUserPreferences({ codeBlockCollapseMode: "invalid" }).codeBlockCollapseMode).toBe("long");
    expect(normalizeCodeBlockCollapseMode("expanded")).toBe("expanded");
    expect(shouldCollapseCodeBlock("expanded", 200)).toBe(false);
    expect(shouldCollapseCodeBlock("collapsed", 1)).toBe(true);
    expect(shouldCollapseCodeBlock("long", CODE_BLOCK_LONG_COLLAPSE_LINES - 1)).toBe(false);
    expect(shouldCollapseCodeBlock("long", CODE_BLOCK_LONG_COLLAPSE_LINES)).toBe(true);
    const rich = source("../../components/CodeBlockView.tsx");
    const markdown = source("../../components/MarkdownCodeBlock.tsx");
    expect(rich).toContain("CODE_BLOCK_WRAPPER_CLASS");
    expect(markdown).toContain("CODE_BLOCK_WRAPPER_CLASS");
    expect(markdown).toContain("setCollapseOverride(!collapsed)");
  });

  it("browses the complete icon registry through a bounded virtual window", () => {
    expect(ALL_NOTE_ICONS.length).toBeGreaterThan(150);
    expect(searchNoteIcons("开发").length).toBeGreaterThan(10);
    const iconWindow = getVirtualIconRows(ALL_NOTE_ICONS.length, 500, 224);
    expect(iconWindow.startRow).toBeGreaterThan(0);
    expect(iconWindow.endRow - iconWindow.startRow).toBeLessThan(12);
    expect(source("../../components/NoteIconPickerModal.tsx")).toContain('data-note-icon-browser=""');
  });

  it("provides an explicit root drop target and a clickable MD/RT conversion badge", () => {
    const tree = source("../../components/KnowledgeTreePanel.tsx");
    const editor = source("../../components/EditorPane.tsx");
    expect(tree).toContain('data-knowledge-tree-root-drop=""');
    expect(tree).toContain("knowledgeTreeApi.move(sourceId, { parentId: null })");
    expect(editor).toContain('data-note-format-switch=""');
    expect(editor).toContain("convertActiveNoteFormat({ noteId: activeNote.id, targetFormat })");
  });
});
