import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(
  path.resolve(process.cwd(), "src/components/Sidebar.tsx"),
  "utf8",
);

describe("knowledge tree scrollbar contract", () => {
  it("keeps a stable visible scrollbar on the desktop tree only", () => {
    expect(sidebarSource).toContain('[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]');
    expect(sidebarSource).toContain("overflow-y: scroll !important");
    expect(sidebarSource).toContain("scrollbar-gutter: stable");
    expect(sidebarSource).toContain("scrollbar-color: var(--pm-scrollbar) transparent");
    expect(sidebarSource).toContain('variant === "desktop"');
    expect(sidebarSource).not.toContain('[data-sidebar-variant="mobile"] [data-swipe-blocker="knowledge-tree-scroll"]');
  });
});
