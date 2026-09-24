import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (name: string) => readFileSync(path.resolve(__dirname, `../${name}`), "utf8");

describe("desktop sidebar readability", () => {
  it("keeps primary tree labels readable in both desktop browsing modes", () => {
    const tree = source("KnowledgeTreePanel.tsx");
    const quick = source("MobileKnowledgeTreePanel.tsx");

    expect(tree).toContain('variant === "mobile" ? "gap-1.5 py-1 text-[13px] leading-5" : "gap-1.5 py-1.5 text-sm leading-5"');
    expect(tree).toContain('variant === "mobile" ? "text-tx-secondary" : "text-tx-primary"');
    expect(quick).toContain('variant === "mobile" ? "text-[15px]" : "text-sm font-medium"');
    expect(quick).toContain('variant === "mobile" ? "text-tx-secondary" : "text-tx-primary"');
  });

  it("uses larger desktop rail labels and more legible note previews", () => {
    const rail = source("NavRail.tsx");
    const notes = source("NoteList.tsx");

    expect(rail).toContain('isMobile ? "text-[10px]" : "text-[11px] font-medium"');
    expect(notes).toContain('note-card-preview text-[13px] text-tx-secondary');
    expect(notes).toContain('const ITEM_HEIGHT = 112');
    expect(notes).toContain('showNotebookLabel ? 124 : ITEM_HEIGHT');
  });
});
