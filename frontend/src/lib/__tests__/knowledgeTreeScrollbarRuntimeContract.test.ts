import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("knowledge tree scrollbar runtime contract", () => {
  it("installs the bridge before the application renders", () => {
    const main = source("../../main.tsx");
    expect(main).toContain('import { installKnowledgeTreeScrollbarBridge } from "./lib/knowledgeTreeScrollbarBridge"');
    expect(main).toContain("installKnowledgeTreeScrollbarBridge();");
  });

  it("targets the real desktop tree scroll element and hides the unreliable native overlay", () => {
    const bridge = source("../knowledgeTreeScrollbarBridge.ts");
    expect(bridge).toContain('[data-sidebar-variant="desktop"] [data-swipe-blocker="knowledge-tree-scroll"]');
    expect(bridge).toContain("nowen-knowledge-tree-custom-scroll-track");
    expect(bridge).toContain("scrollbar-width: none !important");
    expect(bridge).toContain("setPointerCapture");
    expect(bridge).toContain('role", "scrollbar"');
  });

  it("keeps the custom track out of the mobile layout", () => {
    const bridge = source("../knowledgeTreeScrollbarBridge.ts");
    expect(bridge).toContain("@media (max-width: 767px)");
    expect(bridge).toContain("display: none !important");
  });
});
