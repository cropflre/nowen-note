// @vitest-environment jsdom

import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import MarkdownExperienceBridge from "../MarkdownExperienceBridge";
import { toast } from "@/lib/toast";

vi.mock("@/lib/toast", () => ({ toast: { info: vi.fn(), error: vi.fn() } }));

const PREF_KEY = "nowen.markdown.live-preview.v1";
const SAMPLE = "# Rendered heading\n\nEditing paragraph";
const views: EditorView[] = [];
let bridgeRoot: Root | null = null;
let bridgeHost: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  if (!globalThis.ResizeObserver) {
    (globalThis as any).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) =>
      globalThis.setTimeout(() => callback(Date.now()), 0) as unknown as number;
    globalThis.cancelAnimationFrame = (id: number) => globalThis.clearTimeout(id);
  }
  if (!globalThis.matchMedia) {
    globalThis.matchMedia = (() => ({ matches: false, media: "", onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
      dispatchEvent: () => false })) as typeof globalThis.matchMedia;
  }
});

afterEach(async () => {
  if (bridgeRoot) await act(async () => { bridgeRoot?.unmount(); });
  bridgeRoot = null;
  bridgeHost = null;
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
  localStorage.clear();
  vi.clearAllMocks();
});

function buildView(host: HTMLElement, text = SAMPLE): EditorView {
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: text,
      selection: { anchor: Math.max(0, text.length - 2) },
      extensions: [markdown()],
    }),
  });
  views.push(view);
  return view;
}

function buildEditor(text = SAMPLE) {
  const shell = document.createElement("section");
  shell.setAttribute("data-markdown-mobile-editing-compact", "false");
  shell.className = "flex flex-col h-full overflow-hidden";
  const toolbar = document.createElement("div");
  toolbar.setAttribute("data-markdown-mobile-toolbar", "expanded");
  const group = document.createElement("div");
  group.className = "ml-auto hidden items-center sm:flex";
  toolbar.appendChild(group);
  shell.appendChild(toolbar);
  const sourcePane = document.createElement("div");
  const editorHost = document.createElement("div");
  editorHost.className = "nowen-md-editor h-full";
  sourcePane.appendChild(editorHost);
  shell.appendChild(sourcePane);

  let previewPane: HTMLElement | null = null;
  const show = (mode: "source" | "preview" | "split") => {
    previewPane?.remove();
    previewPane = null;
    if (mode !== "source") {
      previewPane = document.createElement("div");
      const preview = document.createElement("div");
      preview.className = "nowen-md-preview";
      previewPane.appendChild(preview);
      shell.appendChild(previewPane);
    }
    sourcePane.classList.toggle("hidden", mode === "preview");
  };
  const native = (["source", "preview", "split"] as const).map((mode) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = mode;
    button.addEventListener("click", () => show(mode));
    group.appendChild(button);
    return button;
  });
  document.body.appendChild(shell);
  const view = buildView(editorHost, text);
  bridgeHost = document.createElement("div");
  document.body.appendChild(bridgeHost);
  bridgeRoot = createRoot(bridgeHost);
  act(() => bridgeRoot?.render(<MarkdownExperienceBridge />));
  return { shell, group, editorHost, view, native, show };
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 65)); });
}

function liveButton(group: HTMLElement): HTMLButtonElement {
  const button = group.querySelector<HTMLButtonElement>('[data-nowen-markdown-live="1"]');
  if (!button) throw new Error("Live button was not registered");
  return button;
}

describe("MarkdownExperienceBridge real mode interactions (#773)", () => {
  it("clicks Live and actually renders a CodeMirror preview; native modes turn it off", async () => {
    const { group, view, native } = buildEditor();
    await settle();
    const live = liveButton(group);
    expect(group.querySelectorAll('[data-nowen-markdown-live="1"]')).toHaveLength(1);
    live.click();
    await settle();
    expect(live.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(PREF_KEY)).toBe("1");
    expect(view.dom.querySelector(".cm-live-preview-block")).not.toBeNull();
    native[0].click();
    await settle();
    expect(localStorage.getItem(PREF_KEY)).toBeNull();
    expect(live.getAttribute("aria-pressed")).toBe("false");
    expect(view.dom.querySelector(".cm-live-preview-block")).toBeNull();
    expect(view.state.doc.toString()).toBe(SAMPLE);
  });

  it("switches from a preview layout to Live without losing the CodeMirror instance", async () => {
    const { shell, group, view, native } = buildEditor();
    await settle();
    native[1].click();
    await settle();
    expect(shell.querySelector(".nowen-md-preview")).not.toBeNull();
    liveButton(group).click();
    await settle();
    expect(shell.querySelector(".nowen-md-preview")).toBeNull();
    expect(liveButton(group).getAttribute("aria-pressed")).toBe("true");
    expect(view.dom.querySelector(".cm-live-preview-block")).not.toBeNull();
    expect(view.state.doc.toString()).toBe(SAMPLE);
  });

  it("targets a replacement CodeMirror under the same toolbar, without duplicate bindings", async () => {
    const { group, editorHost, view, native } = buildEditor();
    await settle();
    const live = liveButton(group);
    live.click();
    await settle();
    native[0].click();
    await settle();
    view.destroy();
    views.splice(views.indexOf(view), 1);
    editorHost.replaceChildren();
    const replacement = buildView(editorHost);
    await settle();
    expect(group.querySelectorAll('[data-nowen-markdown-live="1"]')).toHaveLength(1);
    expect(liveButton(group)).toBe(live);
    live.click();
    await settle();
    expect(replacement.dom.querySelector(".cm-live-preview-block")).not.toBeNull();
    expect(localStorage.getItem(PREF_KEY)).toBe("1");
  });

  it("does not pretend Live is active for documents beyond the decoration limit", async () => {
    const { group, view } = buildEditor("x".repeat(350_001));
    await settle();
    liveButton(group).click();
    await settle();
    expect(localStorage.getItem(PREF_KEY)).toBeNull();
    expect(liveButton(group).getAttribute("aria-pressed")).toBe("false");
    expect(view.dom.querySelector(".cm-live-preview-block")).toBeNull();
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining("文档过大"));
  });
});
