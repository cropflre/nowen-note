import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(__dirname, "../TiptapEditor.tsx"), "utf8");

describe("rich-text mind map toolbar routing", () => {
  it("opens the native picker instead of inserting a Mermaid code block", () => {
    const toolbarStart = source.indexOf('<ToolbarButton onClick={insertMermaid}');
    const toolbarEnd = source.indexOf('<ToolbarButton onClick={insertMath}', toolbarStart);
    const toolbar = source.slice(toolbarStart, toolbarEnd);

    expect(toolbarStart).toBeGreaterThanOrEqual(0);
    expect(toolbarEnd).toBeGreaterThan(toolbarStart);
    expect(toolbar).toContain('nowen:open-mindmap-insert');
    expect(toolbar).toContain('title={t(\'tiptap.insertMindMap\')}');
    expect(toolbar).not.toContain('onClick={insertMindMap}');
  });
});
