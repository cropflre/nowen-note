import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("knowledge tree scrollbar runtime contract", () => {
  it("installs the bridge before the application renders", () => {
    const main = source("../../main.tsx");
    const runtime = source("../coreRuntimeInstallers.ts");
    const install = 'installOptionalRuntime("knowledge-tree-scrollbar", installKnowledgeTreeScrollbarBridge);';
    // The startup installer was split into a deferred chunk to keep the login entry small.
    // Still require the bridge to be installed before rendering any application route.
    expect(runtime).toContain('import { installKnowledgeTreeScrollbarBridge } from "./knowledgeTreeScrollbarBridge"');
    expect(runtime).toContain(install);
    expect(main).toContain('import("./lib/coreRuntimeInstallers")');
    expect(main).toContain("installCoreRuntime(installOptionalRuntime, reportBootError);");
    expect(main.indexOf("installCoreRuntime(installOptionalRuntime, reportBootError);"))
      .toBeLessThan(main.indexOf("() => renderApplication(),"));
    expect(main).toContain("if (!coreRuntimeInstalled) {");
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

  it("lets the desktop sidebar request reconciliation without observing the whole document", () => {
    const bridge = source("../knowledgeTreeScrollbarBridge.ts");
    const sidebar = source("../../components/Sidebar.tsx");

    expect(bridge).toContain("export function refreshKnowledgeTreeScrollbars");
    expect(bridge).not.toContain("rootObserver.observe(document.body");
    expect(bridge).toContain("parentObserver.observe(parent, { childList: true })");
    expect(sidebar).toContain('import { refreshKnowledgeTreeScrollbars } from "@/lib/knowledgeTreeScrollbarBridge"');
    expect(sidebar).toContain("refreshKnowledgeTreeScrollbars();");
  });

  it("constrains the tree panel to the remaining sidebar height", () => {
    const sidebar = source("../../components/Sidebar.tsx");

    expect(sidebar).toContain(
      '<div className="flex min-h-0 flex-1 overflow-hidden">',
    );
  });

  it("lets long tree titles shrink within a narrow sidebar", () => {
    const tree = source("../../components/KnowledgeTreePanel.tsx");

    expect(tree).toContain(
      '"relative flex min-h-0 min-w-0 flex-1 flex-col"',
    );
  });

  it("keeps the tree viewport vertical-only when the sidebar narrows", () => {
    const tree = source("../../components/KnowledgeTreePanel.tsx");

    expect(tree).toContain(
      '"relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-1 pb-3"',
    );
  });

  it("uses the quiet pill visual treatment on web and desktop", () => {
    const bridge = source("../knowledgeTreeScrollbarBridge.ts");
    const sidebar = source("../../components/Sidebar.tsx");

    expect(bridge).toContain("left: 2.5px");
    expect(bridge).toContain("right: 2.5px");
    expect(bridge).toContain("opacity: 0.58");
    expect(bridge).toContain("left: 1.5px");
    expect(bridge).toContain("right: 1.5px");
    expect(bridge).toContain("opacity: 0;");
    expect(bridge).toContain('.${TRACK_CLASS}[data-scrollable="false"]:hover');
    expect(sidebar).toContain("border: 2.5px solid transparent");
    expect(sidebar).toContain("border-width: 1.5px");
  });
});
