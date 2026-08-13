// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  ANDROID_DRAWER_SAFE_AREA_CSS,
  annotateMobileDrawerControls,
  getNoteCardSelectionRoot,
  getSidebarSearchInput,
  isMobileDrawerViewport,
  shouldCloseDrawerAfterSearchBlur,
  shouldCloseDrawerOnSearchEnter,
  shouldSuppressNoteCardSelection,
} from "@/components/MobileDrawerUxBridge";

describe("MobileDrawerUxBridge helpers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("treats phone widths as the default-open drawer surface", () => {
    expect(isMobileDrawerViewport(360)).toBe(true);
    expect(isMobileDrawerViewport(767)).toBe(true);
    expect(isMobileDrawerViewport(768)).toBe(false);
    expect(isMobileDrawerViewport(Number.NaN)).toBe(false);
  });

  it("keeps Android label mode wide enough without clipping CJK glyphs", () => {
    expect(ANDROID_DRAWER_SAFE_AREA_CSS).toContain("width: 72px !important");
    expect(ANDROID_DRAWER_SAFE_AREA_CSS).toContain("line-height: 1.35 !important");
    expect(ANDROID_DRAWER_SAFE_AREA_CSS).toContain("text-overflow: clip !important");
  });

  it("只限制导航项宽度，不影响导航栏内打开的弹窗按钮", () => {
    expect(ANDROID_DRAWER_SAFE_AREA_CSS).toContain("[data-mobile-drawer-rail-item]");
    expect(ANDROID_DRAWER_SAFE_AREA_CSS).not.toContain("[data-mobile-drawer-rail].w-16 button {");
    expect(ANDROID_DRAWER_SAFE_AREA_CSS).not.toContain("[data-mobile-drawer-rail].w-16 button > span:last-child");
  });

  it("closes on a committed Enter but not while an IME is composing", () => {
    expect(shouldCloseDrawerOnSearchEnter({ key: "Enter", isComposing: false, keyCode: 13 }, "测试")).toBe(true);
    expect(shouldCloseDrawerOnSearchEnter({ key: "Enter", isComposing: true, keyCode: 13 }, "ce shi")).toBe(false);
    expect(shouldCloseDrawerOnSearchEnter({ key: "Enter", isComposing: false, keyCode: 229 }, "测试")).toBe(false);
    expect(shouldCloseDrawerOnSearchEnter({ key: "Enter", isComposing: false, keyCode: 13 }, "   ")).toBe(false);
    expect(shouldCloseDrawerOnSearchEnter({ key: "ArrowDown", isComposing: false, keyCode: 40 }, "测试")).toBe(false);
  });

  it("recognizes only the sidebar search input", () => {
    const search = document.createElement("input");
    search.setAttribute("data-sidebar-search", "");
    const ordinary = document.createElement("input");

    expect(getSidebarSearchInput(search)).toBe(search);
    expect(getSidebarSearchInput(ordinary)).toBeNull();
    expect(getSidebarSearchInput(document.createElement("button"))).toBeNull();
  });

  it("keeps the drawer open when the search bridge restores focus", () => {
    const input = document.createElement("input");

    expect(shouldCloseDrawerAfterSearchBlur("关键词", input, input)).toBe(false);
    expect(shouldCloseDrawerAfterSearchBlur("关键词", input, document.body)).toBe(true);
    expect(shouldCloseDrawerAfterSearchBlur("", input, document.body)).toBe(false);
  });

  it("marks menu headers and the mobile rail close control for safe-area styling", () => {
    document.body.innerHTML = `
      <header id="note-header"><button id="menu"><svg class="lucide lucide-menu"></svg></button></header>
      <div id="rail" class="flex md:hidden h-full">
        <button id="close"><svg class="lucide lucide-x"></svg></button>
        <button><svg class="lucide lucide-settings"></svg></button>
      </div>
    `;

    annotateMobileDrawerControls(document);

    expect(document.querySelector("#menu")?.hasAttribute("data-mobile-drawer-trigger")).toBe(true);
    expect(document.querySelector("#note-header")?.hasAttribute("data-mobile-safe-topbar")).toBe(true);
    expect(document.querySelector("#rail")?.hasAttribute("data-mobile-drawer-rail")).toBe(true);
    expect(document.querySelector("#close")?.hasAttribute("data-mobile-drawer-close")).toBe(true);
  });

  it("targets only the touched note card when suppressing mobile long-press selection", () => {
    document.body.innerHTML = `
      <div id="card" class="group">
        <div>
          <h3 class="note-card-title"><span id="title-child">标题</span></h3>
          <p id="preview">正文预览</p>
        </div>
      </div>
      <div id="other" class="group"><span id="unrelated">其他内容</span></div>
    `;

    const card = document.querySelector<HTMLElement>("#card")!;
    const titleChild = document.querySelector("#title-child")!;
    const preview = document.querySelector("#preview")!;
    const unrelated = document.querySelector("#unrelated")!;

    expect(getNoteCardSelectionRoot(titleChild)).toBe(card);
    expect(getNoteCardSelectionRoot(preview)).toBe(card);
    expect(getNoteCardSelectionRoot(unrelated)).toBeNull();
    expect(shouldSuppressNoteCardSelection(preview, card)).toBe(true);
    expect(shouldSuppressNoteCardSelection(unrelated, card)).toBe(false);
    expect(shouldSuppressNoteCardSelection(preview, null)).toBe(false);
  });
});
