import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CollapsibleEditorToolbar, {
  EDITOR_TOOLBAR_COLLAPSED_KEY,
  EditorToolbarExpandSlot,
  EditorToolbarHost,
} from "@/components/CollapsibleEditorToolbar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

describe("CollapsibleEditorToolbar", () => {
  let root: Root;

  beforeEach(() => {
    localStorage.removeItem(EDITOR_TOOLBAR_COLLAPSED_KEY);
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    localStorage.removeItem(EDITOR_TOOLBAR_COLLAPSED_KEY);
  });

  const toggleButton = () => document.querySelector<HTMLButtonElement>("button[aria-expanded]")!;

  it("collapses and expands without remounting formatting controls", () => {
    act(() => root.render(<CollapsibleEditorToolbar><button>Bold</button></CollapsibleEditorToolbar>));
    const control = document.querySelector("button:not([aria-expanded])")!;
    const controls = document.getElementById(toggleButton().getAttribute("aria-controls")!)!;
    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");

    act(() => toggleButton().click());
    expect(toggleButton().getAttribute("aria-label")).toBe("tiptap.expandToolbar");
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(controls.className).toBe("md:hidden");
    expect(document.querySelector("button:not([aria-expanded])")).toBe(control);
    expect(localStorage.getItem(EDITOR_TOOLBAR_COLLAPSED_KEY)).toBe("true");

    act(() => toggleButton().click());
    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
    expect(controls.className).toBe("");
    expect(localStorage.getItem(EDITOR_TOOLBAR_COLLAPSED_KEY)).toBe("false");
  });

  it("restores the device preference when switching editors", () => {
    act(() => root.render(<CollapsibleEditorToolbar key="rich-text">Rich text</CollapsibleEditorToolbar>));
    act(() => toggleButton().click());
    act(() => root.render(<CollapsibleEditorToolbar key="markdown">Markdown</CollapsibleEditorToolbar>));
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[data-editor-toolbar-collapsed="true"]')).not.toBeNull();
  });

  it("updates all mounted toolbars when the preference changes", () => {
    act(() => root.render(<>
      <CollapsibleEditorToolbar>First editor</CollapsibleEditorToolbar>
      <CollapsibleEditorToolbar>Second editor</CollapsibleEditorToolbar>
    </>));
    act(() => toggleButton().click());
    expect(document.querySelectorAll('[data-editor-toolbar-collapsed="true"]')).toHaveLength(2);

    act(() => {
      localStorage.setItem(EDITOR_TOOLBAR_COLLAPSED_KEY, "false");
      window.dispatchEvent(new StorageEvent("storage", { key: EDITOR_TOOLBAR_COLLAPSED_KEY }));
    });
    expect(document.querySelectorAll('[data-editor-toolbar-collapsed="false"]')).toHaveLength(2);
  });

  it("moves the restore button to the tab bar and keeps the toolbar controls mounted", () => {
    act(() => root.render(
      <EditorToolbarHost>
        <EditorToolbarExpandSlot location="tabs" />
        <CollapsibleEditorToolbar><button>Bold</button></CollapsibleEditorToolbar>
      </EditorToolbarHost>,
    ));
    const control = document.querySelector("button:not([aria-expanded])");
    const slot = document.querySelector('[data-editor-toolbar-expand-slot="tabs"]')!;
    expect(slot.children).toHaveLength(0);

    act(() => toggleButton().click());
    expect(slot.contains(toggleButton())).toBe(true);
    expect(document.querySelector("button:not([aria-expanded])")).toBe(control);
    expect(toggleButton().textContent).toBe("");

    act(() => toggleButton().click());
    expect(slot.children).toHaveLength(0);
    expect(document.querySelector('[data-editor-toolbar-collapsed="false"]')?.contains(toggleButton())).toBe(true);
  });

  it("keeps a usable restore button when the tab bar is replaced by the header", () => {
    const render = (location: "tabs" | "header") => (
      <EditorToolbarHost>
        <EditorToolbarExpandSlot key={location} location={location} />
        <CollapsibleEditorToolbar>Controls</CollapsibleEditorToolbar>
      </EditorToolbarHost>
    );
    act(() => root.render(render("tabs")));
    act(() => toggleButton().click());
    act(() => root.render(render("header")));
    expect(document.querySelector('[data-editor-toolbar-expand-slot="tabs"]')).toBeNull();
    expect(document.querySelector('[data-editor-toolbar-expand-slot="header"]')?.contains(toggleButton())).toBe(true);
    act(() => toggleButton().click());
    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
  });

  it("scopes restore buttons to their own editor in split view", () => {
    localStorage.setItem(EDITOR_TOOLBAR_COLLAPSED_KEY, "true");
    act(() => root.render(<>
      <EditorToolbarHost>
        <EditorToolbarExpandSlot location="tabs" />
        <CollapsibleEditorToolbar>Primary controls</CollapsibleEditorToolbar>
      </EditorToolbarHost>
      <EditorToolbarHost>
        <EditorToolbarExpandSlot location="header" />
        <CollapsibleEditorToolbar>Secondary controls</CollapsibleEditorToolbar>
      </EditorToolbarHost>
    </>));
    const slots = document.querySelectorAll('[data-editor-toolbar-expand-slot]');
    expect(slots).toHaveLength(2);
    for (const slot of slots) {
      const button = slot.querySelector("button")!;
      const controls = document.getElementById(button.getAttribute("aria-controls")!)!;
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(controls).not.toBeNull();
    }
    expect(slots[0].querySelector("button")?.getAttribute("aria-controls"))
      .not.toBe(slots[1].querySelector("button")?.getAttribute("aria-controls"));
  });
});
