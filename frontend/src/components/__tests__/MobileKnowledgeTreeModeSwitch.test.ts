import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const bridgeSource = readFileSync(path.resolve(__dirname, "../SidebarSearchExperienceBridge.tsx"), "utf8");
const settingsSource = readFileSync(path.resolve(__dirname, "../SettingsModal.tsx"), "utf8");
const helperSource = readFileSync(path.resolve(__dirname, "../../lib/mobileKnowledgeTreeViewMode.ts"), "utf8");
const compactCssSource = readFileSync(path.resolve(__dirname, "../../mobile-knowledge-tree-compact.css"), "utf8");
const zhSource = readFileSync(path.resolve(__dirname, "../../i18n/locales/zh-CN.json"), "utf8");
const enSource = readFileSync(path.resolve(__dirname, "../../i18n/locales/en.json"), "utf8");
const appSource = readFileSync(path.resolve(__dirname, "../../App.tsx"), "utf8");
const mainSource = readFileSync(path.resolve(__dirname, "../../main.tsx"), "utf8");

describe("mobile knowledge tree mode switch contract", () => {
  it("keeps both mobile directory modes without a switch in the content header", () => {
    expect(bridgeSource).toMatch(/<KnowledgeTreePanel[\s\S]*variant="mobile"[\s\S]*className=\{compact\s*\?\s*"nowen-mobile-tree-density"\s*:\s*undefined\}/);
    expect(bridgeSource).toContain('mode === "tree" && createPortal');
    expect(bridgeSource).toContain('surface.navigatorSurface.style.display = mode === "tree" ? "none" : ""');
    expect(bridgeSource).not.toContain("MOBILE_MODE_SWITCH_SLOT_ATTRIBUTE");
    expect(bridgeSource).not.toContain('aria-label="目录浏览方式"');
  });

  it("keeps browser and Android tree mode visibly compact", () => {
    expect(compactCssSource).toMatch(/--nowen-mobile-tree-root-folder-row-height:\s*\d+px/);
    expect(compactCssSource).toMatch(/--nowen-mobile-tree-folder-row-height:\s*\d+px/);
    expect(compactCssSource).toContain("--nowen-mobile-tree-note-row-height: 16px");
    expect(compactCssSource).toMatch(/\[data-knowledge-tree-node-id\]\s*\{[\s\S]*min-height:\s*var\(--nowen-mobile-tree-note-row-height\)\s*!important/);
    expect(compactCssSource).toContain("font-size: 11px !important");
    expect(compactCssSource).toContain("touch-action: manipulation");
  });

  it("exposes one clear tree-mode switch in Settings", () => {
    expect(settingsSource).toContain('const [mobileKnowledgeTreeMode, setMobileKnowledgeTreeMode]');
    expect(settingsSource).toContain('checked={mobileKnowledgeTreeMode === "tree"}');
    expect(settingsSource).toContain('saveMobileKnowledgeTreeViewMode(nextMode)');
    expect(settingsSource).toContain('t("settings.mobileKnowledgeTreeMode")');
    expect(settingsSource).toContain('t("settings.mobileKnowledgeTreeModeDesc")');
    expect(zhSource).toContain('"mobileKnowledgeTreeMode": "移动端使用树形目录"');
    expect(enSource).toContain('"mobileKnowledgeTreeMode": "Use tree view on mobile"');
  });

  it("persists the choice and keeps the new navigator as the default", () => {
    expect(helperSource).toContain('export type MobileKnowledgeTreeViewMode = "navigator" | "tree"');
    expect(helperSource).toContain('return value && VALID_MODES.has(value) ? value : "navigator"');
    expect(helperSource).toContain("MOBILE_KNOWLEDGE_TREE_VIEW_MODE_STORAGE_KEY");
    expect(helperSource).toContain("MOBILE_KNOWLEDGE_TREE_VIEW_MODE_CHANGED_EVENT");
  });

  it("mounts the portal bridge inside the authenticated AppProvider", () => {
    const providerStart = appSource.indexOf("<AppProvider>");
    const bridgeMount = appSource.indexOf("<SidebarSearchExperienceBridge />");
    const providerEnd = appSource.indexOf("</AppProvider>");

    expect(providerStart).toBeGreaterThanOrEqual(0);
    expect(bridgeMount).toBeGreaterThan(providerStart);
    expect(bridgeMount).toBeLessThan(providerEnd);
    expect(mainSource).not.toContain("<SidebarSearchExperienceBridge />");
  });
});