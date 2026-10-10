import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editorPaneSource = readFileSync(
  path.resolve(__dirname, "../EditorPane.tsx"),
  "utf8",
);

function mobileHeaderSource() {
  const start = editorPaneSource.indexOf("{/* Mobile Editor Header");
  const end = editorPaneSource.indexOf("{/* Mobile Outline Panel");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return editorPaneSource.slice(start, end);
}

function desktopToolbarSource() {
  const start = editorPaneSource.indexOf("onClick={toggleLock}");
  const end = editorPaneSource.indexOf("{SHOW_EDITOR_MODE_TOGGLE && (", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return editorPaneSource.slice(start, end);
}

function desktopToolbarWithMoreButtonSource() {
  const start = editorPaneSource.indexOf("onClick={toggleLock}");
  const end = editorPaneSource.indexOf("{showDesktopMoreMenu && (", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return editorPaneSource.slice(start, end);
}

function mobileMoreMenuSource() {
  const start = editorPaneSource.indexOf("{showMobileMenu && (");
  const end = editorPaneSource.indexOf("{/* Mobile Outline Panel", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return editorPaneSource.slice(start, end);
}

function desktopMoreMenuSource() {
  const start = editorPaneSource.indexOf("{showDesktopMoreMenu && (");
  const end = editorPaneSource.indexOf("</AnimatePresence>", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return editorPaneSource.slice(start, end);
}

describe("EditorPane mobile header", () => {
  it("keeps lock management in the mobile menu without adding a duplicate header row", () => {
    const header = mobileHeaderSource();
    const moreMenu = mobileMoreMenuSource();

    expect(header).not.toContain("onClick={toggleLock}");
    expect(header).toContain("nowen:open-search");
    expect(moreMenu).toContain("toggleLock(); setShowMobileMenu(false)");
    expect(header).toContain("mobileTitlePinned");
  });

  it("closes note search before opening either mobile menu trigger", () => {
    const start = editorPaneSource.indexOf("<MobileEditorToolbarPortal location=\"trailing\">");
    const source = editorPaneSource.slice(start, editorPaneSource.indexOf("{showMobileMenu && (", start));
    const triggers = Array.from(source.matchAll(/<Button\b[\s\S]*?<\/Button>/g))
      .map((match) => match[0])
      .filter((button) => button.includes("data-mobile-note-menu-trigger"));

    expect(triggers).toHaveLength(3);
    for (const trigger of triggers) expect(trigger).toContain("nowen:close-search");
  });

  it("lets both note management menus scroll within the available viewport", () => {
    for (const menu of [mobileMoreMenuSource(), desktopMoreMenuSource()]) {
      expect(menu).toContain("overflow-y-auto");
      expect(menu).toContain("overscroll-contain");
      expect(menu).toContain("noteMenuViewport.height");
    }
  });

  it("keeps desktop action titles matched with their buttons", () => {
    const toolbar = desktopToolbarSource();
    const shareStart = toolbar.lastIndexOf("setShowShareModal(true)");
    const shareButton = toolbar.slice(
      shareStart,
      toolbar.indexOf("<Share2", shareStart),
    );

    expect(shareStart).toBeGreaterThanOrEqual(0);
    expect(shareButton).toContain("title={t('editor.shareNote')}");
    expect(shareButton).not.toContain("deleteNote");
  });

  it("exposes the HTML edit switch in the desktop toolbar before the more menu", () => {
    const toolbar = desktopToolbarWithMoreButtonSource();
    const switchButton = toolbar.indexOf("handleToggleHtmlPreviewMode");
    const moreButton = toolbar.indexOf("setShowDesktopMoreMenu");

    expect(switchButton).toBeGreaterThanOrEqual(0);
    expect(moreButton).toBeGreaterThan(switchButton);
    expect(toolbar).toContain("editor.htmlPreview.switchToEditTooltip");
    expect(toolbar).toContain("<Pencil");
  });

  it("places the split document action in both more menus", () => {
    const mobileMenu = mobileMoreMenuSource();
    const desktopMenu = desktopMoreMenuSource();

    expect(mobileMenu).toContain("onSplitDocument");
    expect(mobileMenu).toContain("<Scissors");
    expect(desktopMenu).toContain("onSplitDocument");
    expect(desktopMenu).toContain("<Scissors");
  });
});
