import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useContextMenu } from "@/hooks/useContextMenu";
import ContextMenu, { type ContextMenuItem } from "../ContextMenu";

vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: { notebooks: [] } }), useAppActions: () => ({}) }));
vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/lib/exportService", () => ({ exportSingleNote: vi.fn(), exportSingleNoteAsImage: vi.fn(), exportSingleNoteAsPDF: vi.fn() }));
vi.mock("@/lib/toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
const translate = (key: string) => key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate, i18n: { language: "zh" } }) }));

const items: ContextMenuItem[] = [
  ...Array.from({ length: 16 }, (_, i) => ({ id: `item-${i}`, label: `操作 ${i}` })),
  { id: "more", label: "更多", children: [{ id: "export", label: "导出原件" }] },
];
const action = vi.fn();
function Harness() {
  const { menu, menuRef, openMenuAt, closeMenu } = useContextMenu();
  return <>
    <button id="open" onClick={() => openMenuAt(370, 700, "notebook", "notebook")}>打开</button>
    <ContextMenu {...menu} items={items} menuRef={menuRef} onAction={(id) => { action(id); closeMenu(); }} />
  </>;
}

describe("笔记管理菜单的可视区域与滚动", () => {
  let root: Root;
  let host: HTMLDivElement;
  let viewport: EventTarget & { height: number; width: number; offsetTop: number; offsetLeft: number };
  async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(20); }); }
  function menu() { return document.querySelector<HTMLElement>('[data-context-menu-id]'); }

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("innerWidth", 390);
    viewport = Object.assign(new EventTarget(), { height: 800, width: 390, offsetTop: 0, offsetLeft: 0 });
    vi.stubGlobal("visualViewport", viewport);
    action.mockClear();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Harness />));
    await act(async () => host.querySelector<HTMLButtonElement>("#open")!.click());
    await settle();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("菜单内部滚动不关闭，末项仍可选择", async () => {
    // 旧实现没有标记，先按原有固定定位结构定位以复现滚动即关闭。
    const rootMenu = menu() || host.querySelector<HTMLElement>('[style*="position: fixed"]')!;
    await act(async () => rootMenu.dispatchEvent(new Event("scroll")));
    expect(host.textContent).toContain("操作 15");
    const last = Array.from(host.querySelectorAll("button")).find((button) => button.textContent === "操作 15")!;
    await act(async () => last.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(action).toHaveBeenCalledWith("item-15");
  });

  it.each(["scroll", "mousedown", "escape"])("外部 %s 仍然关闭菜单", async (event) => {
    await act(async () => {
      if (event === "escape") document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      else document.body.dispatchEvent(new Event(event, { bubbles: true }));
    });
    expect(host.textContent).not.toContain("操作 15");
  });

  it("跟随缩小后的可视区域限高，桌面宽度也保留滚动", async () => {
    viewport.height = 300;
    viewport.width = 1000;
    viewport.offsetTop = 20;
    viewport.dispatchEvent(new Event("resize"));
    await settle();
    expect(menu()!.style.maxHeight).toBe("284px");
    expect(menu()!.className).toContain("overflow-y-auto");
    expect(menu()!.className).not.toContain("sm:overflow-visible");
    expect(Number.parseFloat(menu()!.style.top)).toBeGreaterThanOrEqual(28);
  });

  it("桌面子菜单放到滚动容器外，滚动和点击不会被误判为菜单外部", async () => {
    const parent = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
    await act(async () => parent.click());
    await settle();
    const submenu = document.querySelector<HTMLElement>('[data-context-menu-submenu]')!;
    expect(submenu).not.toBeNull();
    expect(host.contains(submenu)).toBe(false);
    await act(async () => {
      submenu.dispatchEvent(new Event("scroll"));
      submenu.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(menu()).not.toBeNull();
    await act(async () => submenu.querySelector("button")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(action).toHaveBeenCalledWith("export");
  });
});
