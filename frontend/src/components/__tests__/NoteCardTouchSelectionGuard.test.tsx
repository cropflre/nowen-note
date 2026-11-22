// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NoteCardTouchSelectionGuard from "@/components/NoteCardTouchSelectionGuard";
import { MOBILE_NOTE_CARD_TOUCH_RELEASE_DELAY_MS } from "@/components/MobileDrawerUxBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

beforeEach(async () => {
  document.body.innerHTML = `
    <div id="host"></div>
    <div id="card" class="group"><h3 class="note-card-title"><span id="title">标题</span></h3><p id="preview">正文</p></div>
    <div id="other" class="group"><h3 class="note-card-title"><span id="other-title">其他</span></h3></div>`;
  root = createRoot(document.querySelector("#host")!);
  await act(async () => root!.render(<NoteCardTouchSelectionGuard />));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const fire = (selector: string, type: string): Event => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  document.querySelector(selector)!.dispatchEvent(event);
  return event;
};

describe("NoteCardTouchSelectionGuard", () => {
  it("cancels text selection only inside the touched note card", () => {
    expect(fire("#preview", "selectstart").defaultPrevented).toBe(false);
    fire("#title", "touchstart");
    expect(fire("#preview", "selectstart").defaultPrevented).toBe(true);
    expect(fire("#other-title", "selectstart").defaultPrevented).toBe(false);
  });

  it("releases the card shortly after the touch ends and stops listening when unmounted", async () => {
    vi.useFakeTimers();
    fire("#title", "touchstart");
    fire("#title", "touchend");
    expect(fire("#title", "selectstart").defaultPrevented).toBe(true);
    vi.advanceTimersByTime(MOBILE_NOTE_CARD_TOUCH_RELEASE_DELAY_MS + 1);
    expect(fire("#title", "selectstart").defaultPrevented).toBe(false);

    fire("#title", "touchstart");
    await act(async () => root?.unmount());
    root = null;
    expect(fire("#title", "selectstart").defaultPrevented).toBe(false);
  });
});
