import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const commonActions = ["undo", "redo", "heading1", "heading2", "bold", "bulletList", "insertImage"];
const editors = [
  {
    file: "TiptapEditor.tsx",
    marker: "data-mobile-editor-toolbar",
    actions: [...commonActions, "uploadLocalVideo", "firstLineIndent2"],
  },
  {
    file: "MarkdownEditorImpl.tsx",
    marker: "data-markdown-mobile-toolbar",
    actions: [...commonActions, "uploadLocalVideo"],
  },
];

function findButton(source: string, action: string): string | undefined {
  return Array.from(source.matchAll(/<ToolbarButton\b[\s\S]*?<\/ToolbarButton>/g))
    .map((match) => match[0])
    .find((button) => button.includes(`'tiptap.${action}'`) || button.includes(`"tiptap.${action}"`));
}

for (const { file, marker, actions } of editors) {
  const source = readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const compactStart = source.indexOf(`${marker}="compact"`);
  const expandedStart = source.indexOf(`${marker}="expanded"`);
  const compact = source.slice(compactStart, expandedStart);
  const expanded = source.slice(expandedStart, source.indexOf("</CollapsibleEditorToolbar>", expandedStart));

  describe(`${file} mobile toolbar`, () => {
    for (const action of actions) {
      it(`keeps ${action} in the compact row and hides only its desktop counterpart on mobile`, () => {
        expect(findButton(compact, action), "compact action must remain available").toBeDefined();
        expect(findButton(compact, action)).not.toContain("max-md:hidden");
        expect(findButton(expanded, action)).toContain('className="max-md:hidden"');
      });
    }

    it("keeps advanced actions available in the expanded mobile panel", () => {
      for (const action of ["heading3", "strikethrough", "orderedList", "taskList", "inlineCode"]) {
        expect(findButton(expanded, action)).toBeDefined();
        expect(findButton(expanded, action)).not.toContain("max-md:hidden");
      }
      expect(compact).toContain("setMobileToolbarExpanded");
      expect(expanded).toContain("max-md:max-h-[38vh]");
    });

    it("provides fixed mobile navigation/action slots around the scrollable format strip", () => {
      expect(compact).toContain('<MobileEditorToolbarSlot location="leading" />');
      expect(compact).toContain('<MobileEditorToolbarSlot location="trailing" />');
      expect(compact).toContain('data-mobile-editor-format-strip');
      expect(compact).toContain("overflow-x-auto");
    });

        if (file === "MarkdownEditorImpl.tsx") {
      it("hides source/preview/live counterparts on compact tablets but preserves split mode", () => {
        const modeGroup = expanded.slice(expanded.indexOf("MARKDOWN-PREVIEW-MODE-01"));
        const modes = Array.from(modeGroup.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((match) => match[0]);
        expect(modes).toHaveLength(3);
        expect(modes[0]).toContain("max-md:hidden");
        expect(modes[1]).toContain("max-md:hidden");
        expect(modes[2]).not.toContain("max-md:hidden");
        // The Live button inherits Source's class when MarkdownExperienceBridge creates it.
        const bridge = readFileSync(path.resolve(__dirname, "../MarkdownExperienceBridge.tsx"), "utf8");
        expect(bridge).toContain("button.className = sourceButton.className");
      });
    }
  });
}
