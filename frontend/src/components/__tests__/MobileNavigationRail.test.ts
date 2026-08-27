import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relativePath: string) => readFileSync(path.resolve(__dirname, relativePath), "utf8");

describe("mobile navigation rail contract", () => {
  const appSource = source("../../App.tsx");
  const railSource = source("../NavRail.tsx");
  const sidebarSource = source("../Sidebar.tsx");
  const settingsSource = source("../SettingsModal.tsx");
  const preferenceSource = source("../../hooks/useMobileRailHidden.ts");
  const controlsSource = source("../../hooks/useMobileSidebarControlsCollapsed.ts");
  const quickTreeSource = source("../MobileKnowledgeTreePanel.tsx");
  const recursiveTreeSource = source("../KnowledgeTreePanel.tsx");

  it("uses a full-width mobile drawer and shows the shortcut rail by default", () => {
    expect(appSource).toContain("w-screen max-w-none");
    expect(appSource).toContain('!mobileRailHidden && <NavRail variant="mobile" />');
    expect(preferenceSource).toContain("return stored === null ? false");
    expect(preferenceSource).toContain("return false");
    expect(preferenceSource).toContain('nowen-mobile-rail-hidden');
  });

  it("uses the title icon to collapse the controls below it", () => {
    expect(railSource).toContain('const effectiveMode = variant === "mobile" ? "label" : railMode');
    expect(sidebarSource).toContain("setMobileControlsCollapsed(!mobileControlsCollapsed)");
    expect(sidebarSource).toContain('mobileControlsCollapsed ? <PanelTopOpen size={16} /> : <PanelTopClose size={16} />');
    expect(sidebarSource.indexOf("setMobileControlsCollapsed(!mobileControlsCollapsed)")).toBeLessThan(
      sidebarSource.indexOf('siteConfig.title || "nowen-note"'),
    );
    expect(sidebarSource).toContain('variant !== "mobile" || !mobileControlsCollapsed');
    expect(controlsSource).toContain("let collapsed = true");
    expect(quickTreeSource).toContain('controlsCollapsed && "hidden"');
    expect(recursiveTreeSource).toContain('controlsCollapsed && "hidden"');
    expect(quickTreeSource).toContain('(!controlsCollapsed || currentFolder)');
    expect(quickTreeSource).toContain('controlsCollapsed && "pt-1.5"');
    expect(recursiveTreeSource).toContain('controlsCollapsed && "pt-1.5"');
    expect(quickTreeSource).toContain('data-mobile-knowledge-tree-section-heading=""');
    expect(recursiveTreeSource).toContain('data-knowledge-tree-section-heading=""');
  });

  it("exposes the mobile rail preference in Settings", () => {
    expect(settingsSource).toContain('data-settings-switch="mobile-rail-hidden"');
    expect(settingsSource).toContain('t("settings.mobileRailHidden")');
    expect(settingsSource).toContain('t("settings.mobileRailHiddenDesc")');
  });

  it("shows the complete labeled shortcut rail in Android local mode", () => {
    expect(railSource).toContain("const items = localDeviceMode ? NAV_CONFIG : availableItems");
    expect(railSource).not.toContain('item.mode === "favorites" || item.mode === "trash"');
    for (const mode of ["favorites", "files", "trash", "diary", "tasks", "mindmaps", "ai-chat", "shares"]) {
      expect(railSource).toContain(`mode: "${mode}"`);
    }
    expect(railSource).toContain('t("sidebar.loginAndSync")');
  });

  it("keeps Settings reachable when the mobile rail is hidden", () => {
    expect(sidebarSource).toContain("const [mobileRailHidden, setMobileRailHidden] = useMobileRailHidden()");
    expect(sidebarSource).toContain("{mobileRailHidden && (");
    expect(sidebarSource).toContain('data-mobile-sidebar-settings=""');
    expect(sidebarSource).toContain('window.dispatchEvent(new CustomEvent("nowen:open-settings"))');
    expect(appSource).toContain('window.addEventListener("nowen:open-settings", onOpen)');
    expect(appSource).toContain('<SettingsModal onClose={() => setSettingsOpen(false)} />');
  });
});
