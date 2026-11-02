import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FullscreenImageViewer from "../FullscreenImageViewer";

vi.mock("@/hooks/useAttachmentImageRenderSource", () => ({
  useAttachmentImageRenderSource: (src: string) => ({ renderSrc: src, renderKey: src, onLoad() {}, onError() {} }),
}));
vi.mock("../MotionPhotoOverlay", () => ({ MotionPhotoOverlay: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n: { language: "zh-CN" } }) }));

let root: Root;
const image = () => document.querySelector<HTMLImageElement>("[data-nowen-image-viewer-image]")!;
const stage = () => image().parentElement!.parentElement!;
const transform = () => image().parentElement!.style.transform;
const click = (label: string) => act(() => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
// jsdom has no PointerEvent; assign fields explicitly for React's pointer handlers.
function touch(type: string, id: number, x: number, y: number, target: Element = stage()) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerId: { value: id }, pointerType: { value: "touch" } });
  act(() => target.dispatchEvent(event));
}
function mount(images = [{ src: "/first.png" }, { src: "/second.png" }]) {
  const onClose = vi.fn();
  const onIndexChange = vi.fn();
  act(() => root.render(<FullscreenImageViewer open images={images} onClose={onClose} onIndexChange={onIndexChange} />));
  Object.defineProperties(stage(), {
    clientWidth: { value: 400, configurable: true }, clientHeight: { value: 800, configurable: true },
    getBoundingClientRect: { value: () => ({ left: 0, top: 0, width: 400, height: 800 }), configurable: true },
  });
  Object.defineProperties(image(), {
    naturalWidth: { value: 1200, configurable: true }, naturalHeight: { value: 2400, configurable: true },
    offsetWidth: { value: 400, configurable: true }, offsetHeight: { value: 800, configurable: true },
  });
  act(() => image().dispatchEvent(new Event("load")));
  return { onClose, onIndexChange };
}
function swipe(dx: number) {
  touch("pointerdown", 1, 200, 400, image());
  touch("pointermove", 1, 200 + dx, 400);
  touch("pointerup", 1, 200 + dx, 400);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });

describe("FullscreenImageViewer gestures", () => {
  it("swipes only unzoomed galleries and stops at both ends", () => {
    const { onClose } = mount();
    // App's document-level sidebar swipe listener skips only this DOM boundary.
    expect(stage().closest("[data-swipe-blocker]")).not.toBeNull();
    swipe(90);
    expect(image().getAttribute("src")).toBe("/first.png");
    swipe(-90);
    expect(image().getAttribute("src")).toBe("/second.png");
    swipe(-90);
    expect(image().getAttribute("src")).toBe("/second.png");
    swipe(90);
    expect(image().getAttribute("src")).toBe("/first.png");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pans on both axes after zooming and never swipes at a zoomed boundary", () => {
    mount();
    click("放大图片");
    touch("pointerdown", 1, 200, 400, image());
    touch("pointermove", 1, 900, 1200);
    expect(transform()).toContain("translate3d(50px, 100px, 0)");
    touch("pointerup", 1, 900, 1200);
    expect(image().getAttribute("src")).toBe("/first.png");
  });

  it("keeps the pinch focus anchored and hands the remaining finger over to panning", () => {
    mount();
    touch("pointerdown", 1, 150, 300, image());
    touch("pointerdown", 2, 250, 300, image());
    touch("pointermove", 2, 350, 300);
    expect(transform()).toContain("translate3d(50px, 100px, 0) scale(2)");
    touch("pointerup", 2, 350, 300);
    touch("pointermove", 1, 100, 250);
    expect(transform()).toContain("translate3d(0px, 50px, 0) scale(2)");
    touch("pointerup", 1, 100, 250);
  });

  it("cancels a lost capture so the next drag is not mistaken for a pinch", () => {
    mount();
    click("放大图片");
    touch("pointerdown", 1, 200, 400, image());
    touch("lostpointercapture", 1, 200, 400);
    touch("pointerdown", 2, 200, 400, image());
    touch("pointermove", 2, 230, 440);
    expect(transform()).toContain("translate3d(30px, 40px, 0) scale(1.25)");
  });

  it("ignores pointercancel and long drags returning to their start as taps", () => {
    const { onClose } = mount();
    touch("pointerdown", 1, 200, 400);
    touch("pointermove", 1, 300, 400);
    touch("pointermove", 1, 200, 400);
    touch("pointerup", 1, 200, 400);
    expect(onClose).not.toHaveBeenCalled();
    touch("pointerdown", 2, 200, 400);
    touch("pointercancel", 2, 200, 400);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refreshes fit ratio after viewport rotation so 1:1 remains accurate", () => {
    mount();
    Object.defineProperty(image(), "offsetWidth", { value: 600, configurable: true });
    Object.defineProperty(image(), "offsetHeight", { value: 1200, configurable: true });
    act(() => window.dispatchEvent(new Event("resize")));
    expect(document.querySelector('[aria-label="在适应窗口和原始比例之间切换"]')!.textContent).toBe("50%");
    click("在适应窗口和原始比例之间切换");
    expect(transform()).toContain("scale(2)");
  });

  it("can reach 1:1 for very long images fitted below one percent", () => {
    mount();
    Object.defineProperty(image(), "offsetWidth", { value: 4, configurable: true });
    act(() => image().dispatchEvent(new Event("load")));
    click("在适应窗口和原始比例之间切换");
    expect(transform()).toContain("scale(300)");
    expect(document.querySelector('[aria-label="在适应窗口和原始比例之间切换"]')!.textContent).toBe("100%");
  });

  it("keeps a small image at 1:1 when fit already matches its original size", () => {
    mount();
    Object.defineProperty(image(), "naturalWidth", { value: 400, configurable: true });
    act(() => image().dispatchEvent(new Event("load")));
    click("在适应窗口和原始比例之间切换");
    expect(transform()).toContain("scale(1)");
  });

  it("keeps the percentage accurate after a sub-percent fit change on long images", () => {
    mount();
    Object.defineProperty(image(), "offsetWidth", { value: 4, configurable: true });
    act(() => image().dispatchEvent(new Event("load")));
    Object.defineProperty(image(), "offsetWidth", { value: 5, configurable: true });
    act(() => window.dispatchEvent(new Event("resize")));
    click("在适应窗口和原始比例之间切换");
    expect(transform()).toContain("scale(240)");
    expect(document.querySelector('[aria-label="在适应窗口和原始比例之间切换"]')!.textContent).toBe("100%");
  });
});
