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

describe("EditorPane mobile header", () => {
  it("pins lock toggle before search and keeps it out of the mobile more menu", () => {
    const header = mobileHeaderSource();
    const lockButton = header.indexOf("onClick={toggleLock}");
    const searchButton = header.indexOf("nowen:open-search");
    const moreMenu = header.slice(header.indexOf("{showMobileMenu && ("));

    expect(lockButton).toBeGreaterThanOrEqual(0);
    expect(searchButton).toBeGreaterThan(lockButton);
    expect(moreMenu).not.toContain("toggleLock()");
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
});
