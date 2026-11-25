// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import ShortcutRuntimeBridge from "@/components/ShortcutRuntimeBridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const received: unknown[] = [];
const record = (event: Event) => received.push((event as CustomEvent).detail);

beforeEach(async () => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  host = document.createElement("div");
  document.body.appendChild(host);
  window.addEventListener("nowen:format", record);
  root = createRoot(host);
  await act(async () => root!.render(<ShortcutRuntimeBridge />));
});

afterEach(async () => {
  window.removeEventListener("nowen:format", record);
  await act(async () => root?.unmount());
  host?.remove();
  document.body.innerHTML = "";
  received.length = 0;
});

function editorTarget(className: string): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.contentEditable = "true";
  document.body.appendChild(element);
  return element;
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("ShortcutRuntimeBridge alignment shortcuts (Issue #915)", () => {
  it("routes Ctrl+E, Ctrl+L and Ctrl+Shift+E inside the rich-text editor", () => {
    const editor = editorTarget("ProseMirror");
    const center = press(editor, "e");
    const left = press(editor, "l");
    const code = press(editor, "E", { shiftKey: true });
    expect(received).toEqual([{ align: "center" }, { align: "left" }, { mark: "code" }]);
    // Consumed before Tiptap's own Mod-E (inline code) and the browser's address-bar shortcuts.
    expect([center.defaultPrevented, left.defaultPrevented, code.defaultPrevented]).toEqual([true, true, true]);
  });

  it("leaves Ctrl+L and Ctrl+E alone outside editors", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = press(input, "l");
    expect(received).toEqual([]);
    expect(event.defaultPrevented).toBe(false);
  });
});
