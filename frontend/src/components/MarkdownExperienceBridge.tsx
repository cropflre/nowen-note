import React, { useEffect } from "react";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownLivePreviewExtension } from "@/lib/markdownLivePreview";
import { attachMarkdownSplitScrollSync } from "@/lib/markdownScrollSync";

const LIVE_MODE_KEY = "nowen.markdown.live-preview.v1";
const ACTIVE_CLASSES = ["bg-accent-primary/10", "text-accent-primary"];
const INACTIVE_CLASSES = ["text-tx-tertiary", "hover:text-tx-secondary", "hover:bg-app-hover"];

interface EditorBridgeState {
  view: EditorView;
  liveCompartment: Compartment;
  liveInstalled: boolean;
  liveActive: boolean;
  splitPreviewRoot: HTMLElement | null;
  splitSourcePane: HTMLElement | null;
  splitPreviewPane: HTMLElement | null;
  splitCleanup: (() => void) | null;
}

const states = new WeakMap<EditorView, EditorBridgeState>();

function setButtonActive(button: HTMLButtonElement, active: boolean): void {
  for (const className of ACTIVE_CLASSES) button.classList.toggle(className, active);
  for (const className of INACTIVE_CLASSES) button.classList.toggle(className, !active);
  button.setAttribute("aria-pressed", String(active));
}

function getEditorView(host: HTMLElement): EditorView | null {
  const cmRoot = host.querySelector<HTMLElement>(".cm-editor");
  if (!cmRoot) return null;
  try {
    return EditorView.findFromDOM(cmRoot);
  } catch {
    return null;
  }
}

function getState(view: EditorView): EditorBridgeState {
  const existing = states.get(view);
  if (existing) return existing;
  const created: EditorBridgeState = {
    view,
    liveCompartment: new Compartment(),
    liveInstalled: false,
    liveActive: false,
    splitPreviewRoot: null,
    splitSourcePane: null,
    splitPreviewPane: null,
    splitCleanup: null,
  };
  states.set(view, created);
  return created;
}

function setLivePreview(state: EditorBridgeState, active: boolean): void {
  if (state.liveActive === active && state.liveInstalled) return;
  if (!state.liveInstalled) {
    state.view.dispatch({
      effects: StateEffect.appendConfig.of(
        state.liveCompartment.of(active ? markdownLivePreviewExtension : []),
      ),
    });
    state.liveInstalled = true;
  } else {
    state.view.dispatch({
      effects: state.liveCompartment.reconfigure(active ? markdownLivePreviewExtension : []),
    });
  }
  state.liveActive = active;
}

function findModeGroup(editorRoot: HTMLElement): HTMLElement | null {
  const toolbar = editorRoot.querySelector<HTMLElement>(".sticky.top-0");
  if (!toolbar) return null;
  return Array.from(toolbar.querySelectorAll<HTMLElement>("div")).find((element) => {
    return element.classList.contains("ml-auto") && element.querySelectorAll(":scope > button").length >= 3;
  }) || null;
}

function createLiveButton(sourceButton: HTMLButtonElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.nowenMarkdownLive = "1";
  button.className = sourceButton.className;
  button.title = document.documentElement.lang?.toLowerCase().startsWith("en") ? "Live preview" : "实时预览";
  button.innerHTML = [
    '<span aria-hidden="true" class="text-[12px] leading-none">✦</span>',
    `<span class="hidden sm:inline">${button.title}</span>`,
  ].join("");
  setButtonActive(button, false);
  return button;
}

function bindModeButtons(group: HTMLElement, state: EditorBridgeState): void {
  const allButtons = Array.from(group.querySelectorAll<HTMLButtonElement>(":scope > button"));
  let liveButton = allButtons.find((button) => button.dataset.nowenMarkdownLive === "1") || null;
  const nativeButtons = allButtons.filter((button) => button.dataset.nowenMarkdownLive !== "1");
  const sourceButton = nativeButtons[0];
  const previewButton = nativeButtons[1];
  const splitButton = nativeButtons[2];
  if (!sourceButton || !previewButton || !splitButton) return;

  if (!liveButton) {
    liveButton = createLiveButton(sourceButton);
    group.insertBefore(liveButton, previewButton);
  }

  if (!liveButton.dataset.nowenMarkdownBound) {
    liveButton.dataset.nowenMarkdownBound = "1";
    liveButton.addEventListener("click", () => {
      // Keep React in source layout, then replace only inactive Markdown blocks.
      sourceButton.click();
      window.setTimeout(() => {
        setLivePreview(state, true);
        localStorage.setItem(LIVE_MODE_KEY, "1");
        setButtonActive(sourceButton, false);
        setButtonActive(previewButton, false);
        setButtonActive(splitButton, false);
        setButtonActive(liveButton!, true);
      }, 0);
    });
  }

  for (const button of nativeButtons) {
    if (button.dataset.nowenMarkdownBridgeBound) continue;
    button.dataset.nowenMarkdownBridgeBound = "1";
    button.addEventListener("click", () => {
      setLivePreview(state, false);
      localStorage.removeItem(LIVE_MODE_KEY);
      setButtonActive(liveButton!, false);
    });
  }

  if (localStorage.getItem(LIVE_MODE_KEY) === "1") {
    if (!state.liveActive) {
      sourceButton.click();
      window.setTimeout(() => {
        setLivePreview(state, true);
        // sourceButton.click() intentionally passes through the native-mode listener,
        // so restore the remembered live mode after that synchronous listener runs.
        localStorage.setItem(LIVE_MODE_KEY, "1");
      }, 0);
    }
    setButtonActive(sourceButton, false);
    setButtonActive(previewButton, false);
    setButtonActive(splitButton, false);
    setButtonActive(liveButton, true);
  } else {
    if (state.liveActive) setLivePreview(state, false);
    setButtonActive(liveButton, false);
  }
}

function clearSplitBinding(state: EditorBridgeState): void {
  state.splitCleanup?.();
  state.splitCleanup = null;
  state.splitPreviewRoot = null;
  if (state.splitSourcePane?.style.overflow === "hidden") state.splitSourcePane.style.removeProperty("overflow");
  if (state.splitPreviewPane?.style.overflow === "hidden") state.splitPreviewPane.style.removeProperty("overflow");
  state.splitSourcePane = null;
  state.splitPreviewPane = null;
}

function bindSplitScroll(host: HTMLElement, editorRoot: HTMLElement, state: EditorBridgeState): void {
  const previewRoot = editorRoot.querySelector<HTMLElement>(".nowen-md-preview");
  const sourcePane = host.parentElement;
  const previewPane = previewRoot?.parentElement || null;
  const isSplit = !!(
    previewRoot &&
    sourcePane &&
    previewPane &&
    sourcePane.style.width &&
    previewPane.style.width
  );

  if (!isSplit) {
    clearSplitBinding(state);
    return;
  }

  // CodeMirror and MarkdownPreview own scrolling; parent overflow caused duplicate bars.
  if (sourcePane!.style.overflow !== "hidden") sourcePane!.style.overflow = "hidden";
  if (previewPane!.style.overflow !== "hidden") previewPane!.style.overflow = "hidden";

  if (state.splitPreviewRoot === previewRoot && state.splitCleanup) return;
  clearSplitBinding(state);
  sourcePane!.style.overflow = "hidden";
  previewPane!.style.overflow = "hidden";
  state.splitSourcePane = sourcePane;
  state.splitPreviewPane = previewPane;
  state.splitPreviewRoot = previewRoot;
  state.splitCleanup = attachMarkdownSplitScrollSync(state.view, previewRoot!);
}

function reconcileMarkdownEditors(): void {
  for (const host of document.querySelectorAll<HTMLElement>(".nowen-md-editor")) {
    const view = getEditorView(host);
    if (!view) continue;
    const editorRoot = host.closest<HTMLElement>(".flex.flex-col.h-full.overflow-hidden");
    if (!editorRoot) continue;
    const state = getState(view);
    const modeGroup = findModeGroup(editorRoot);
    if (modeGroup) bindModeButtons(modeGroup, state);
    bindSplitScroll(host, editorRoot, state);
  }
}

/** Runtime integration kept outside the 1,800-line editor to reduce regression risk. */
export default function MarkdownExperienceBridge() {
  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reconcileMarkdownEditors);
    };

    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("focus", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", schedule);
    };
  }, []);

  return null;
}
