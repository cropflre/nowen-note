import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PullToRefresh } from "../NoteList";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const haptic = vi.hoisted(() => ({
  light: vi.fn(),
  medium: vi.fn(),
  heavy: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  selection: vi.fn(),
}));

vi.mock("@/hooks/useCapacitor", () => ({ haptic }));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function dispatchTouch(target: Element, type: string, clientY: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", {
    configurable: true,
    value: type === "touchend" ? [] : [{ clientY }],
  });
  Object.defineProperty(event, "changedTouches", {
    configurable: true,
    value: [{ clientY }],
  });
  target.dispatchEvent(event);
}

describe("PullToRefresh", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function renderPullToRefresh(onRefresh = vi.fn().mockResolvedValue(undefined)) {
    await act(async () => {
      root.render(
        <PullToRefresh onRefresh={onRefresh}>
          <div data-note-list-scroll-viewport="virtual">列表</div>
        </PullToRefresh>,
      );
    });

    const pullRoot = host.firstElementChild;
    const viewport = host.querySelector<HTMLElement>("[data-note-list-scroll-viewport='virtual']");
    expect(pullRoot).not.toBeNull();
    expect(viewport).not.toBeNull();
    return { pullRoot: pullRoot!, viewport: viewport!, onRefresh };
  }

  async function pullDown(pullRoot: Element, startY: number, endY: number) {
    await act(async () => {
      dispatchTouch(pullRoot, "touchstart", startY);
    });
    await act(async () => {
      dispatchTouch(pullRoot, "touchmove", endY);
    });
    await act(async () => {
      dispatchTouch(pullRoot, "touchend", endY);
    });
  }

  it("scrollTop 大于 0 时下拉不触发刷新", async () => {
    const { pullRoot, viewport, onRefresh } = await renderPullToRefresh();
    viewport.scrollTop = 30;

    await pullDown(pullRoot, 0, 200);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("scrollTop 为 0 且下拉超过阈值时触发刷新", async () => {
    const { pullRoot, viewport, onRefresh } = await renderPullToRefresh();
    viewport.scrollTop = 0;

    await pullDown(pullRoot, 0, 200);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("刷新过程不调用 haptic", async () => {
    const { pullRoot, viewport } = await renderPullToRefresh();
    viewport.scrollTop = 0;

    await pullDown(pullRoot, 0, 200);

    expect(haptic.light).not.toHaveBeenCalled();
    expect(haptic.medium).not.toHaveBeenCalled();
    expect(haptic.success).not.toHaveBeenCalled();
    expect(haptic.error).not.toHaveBeenCalled();
  });
});
