import React, { useEffect } from "react";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownFencedCodeAuthoringExtension } from "@/lib/markdownFenceAuthoring";
import { markdownLivePreviewExtension } from "@/lib/markdownLivePreview";
import { attachMarkdownSplitScrollSync } from "@/lib/markdownScrollSync";
import { toast } from "@/lib/toast";

const LIVE_MODE_KEY = "nowen.markdown.live-preview.v1";
// Keep in sync with markdownLivePreview.tsx: buildDecorations skips larger documents.
const LIVE_PREVIEW_MAX_LENGTH = 350_000;
const ACTIVE_CLASSES = ["bg-accent-primary/10", "text-accent-primary"];
const INACTIVE_CLASSES = ["text-tx-tertiary", "hover:text-tx-secondary", "hover:bg-app-hover"];

interface EditorBridgeState {
  view: EditorView;
  authoringInstalled: boolean;
  liveCompartment: Compartment;
  liveInstalled: boolean;
  liveActive: boolean;
  splitPreviewRoot: HTMLElement | null;
  splitSourcePane: HTMLElement | null;
  splitPreviewPane: HTMLElement | null;
  splitCleanup: (() => void) | null;
}

interface ModeButtons {
  source: HTMLButtonElement;
  preview: HTMLButtonElement;
  split: HTMLButtonElement;
  live: HTMLButtonElement | null;
}

const states = new WeakMap<EditorView, EditorBridgeState>();

function readLivePreference(): boolean {
  try { return localStorage.getItem(LIVE_MODE_KEY) === "1"; } catch { return false; }
}

function writeLivePreference(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(LIVE_MODE_KEY, "1");
    else localStorage.removeItem(LIVE_MODE_KEY);
  } catch { /* Private browsing can disable storage; the active editor still works. */ }
}

function setButtonActive(button: HTMLButtonElement, active: boolean): void {
  for (const name of ACTIVE_CLASSES) button.classList.toggle(name, active);
  for (const name of INACTIVE_CLASSES) button.classList.toggle(name, !active);
  if (button.getAttribute("aria-pressed") !== String(active)) {
    button.setAttribute("aria-pressed", String(active));
  }
}

function getEditorView(host: HTMLElement): EditorView | null {
  const cmRoot = host.querySelector<HTMLElement>(".cm-editor");
  if (!cmRoot) return null;
  try { return EditorView.findFromDOM(cmRoot); } catch { return null; }
}

function getState(view: EditorView): EditorBridgeState {
  const existing = states.get(view);
  if (existing) return existing;
  const created: EditorBridgeState = {
    view,
    authoringInstalled: false,
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

function ensureFencedCodeAuthoring(state: EditorBridgeState): void {
  if (state.authoringInstalled) return;
  state.view.dispatch({ effects: StateEffect.appendConfig.of(markdownFencedCodeAuthoringExtension) });
  state.authoringInstalled = true;
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

function getEditorRoot(group: HTMLElement): HTMLElement | null {
  return group.closest<HTMLElement>("[data-markdown-mobile-editing-compact]");
}

// Never capture an EditorView in a button handler: the toolbar can survive a CodeMirror remount.
function getCurrentState(group: HTMLElement): EditorBridgeState | null {
  const root = getEditorRoot(group);
  const host = root?.querySelector<HTMLElement>(".nowen-md-editor");
  const view = host ? getEditorView(host) : null;
  if (!view) return null;
  const state = getState(view);
  ensureFencedCodeAuthoring(state);
  return state;
}

function getModeButtons(group: HTMLElement): ModeButtons | null {
  const all = Array.from(group.querySelectorAll<HTMLButtonElement>(":scope > button"));
  const native = all.filter((button) => button.dataset.nowenMarkdownLive !== "1");
  if (native.length < 3) return null;
  return {
    source: native[0],
    preview: native[1],
    split: native[2],
    live: all.find((button) => button.dataset.nowenMarkdownLive === "1") || null,
  };
}

export function findMarkdownModeGroup(editorRoot: HTMLElement): HTMLElement | null {
  const toolbar = editorRoot.querySelector<HTMLElement>('[data-markdown-mobile-toolbar="expanded"]')
    || editorRoot.querySelector<HTMLElement>(".sticky.top-0");
  if (!toolbar) return null;
  return Array.from(toolbar.querySelectorAll<HTMLElement>("div")).find((element) =>
    element.classList.contains("ml-auto")
    && element.querySelectorAll(":scope > button").length >= 3,
  ) || null;
}

function createLiveButton(sourceButton: HTMLButtonElement): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.nowenMarkdownLive = "1";
  button.className = sourceButton.className;
  button.title = document.documentElement.lang?.toLowerCase().startsWith("en") ? "Live preview" : "实时预览";
  button.setAttribute("aria-label", button.title);
  const icon = document.createElement("span");
  icon.setAttribute("aria-hidden", "true");
  icon.className = "text-[12px] leading-none";
  icon.textContent = "✦";
  const label = document.createElement("span");
  label.className = "hidden sm:inline";
  label.textContent = button.title;
  button.append(icon, label);
  setButtonActive(button, false);
  return button;
}

function paintLiveButtons(group: HTMLElement, active: boolean): void {
  const buttons = getModeButtons(group);
  if (!buttons?.live) return;
  setButtonActive(buttons.live, active);
  if (active) {
    setButtonActive(buttons.source, false);
    setButtonActive(buttons.preview, false);
    setButtonActive(buttons.split, false);
  }
}

function activateLive(group: HTMLElement): void {
  const state = getCurrentState(group);
  const buttons = getModeButtons(group);
  if (!state || !buttons?.live) {
    toast.error("实时预览尚未就绪，请稍后重试");
    return;
  }
  if (state.view.state.doc.length > LIVE_PREVIEW_MAX_LENGTH) {
    toast.info("文档过大，实时预览暂不可用；请使用预览或分屏模式");
    return;
  }
  // React owns the source/preview/split layout. Never defer a captured view: a mode switch can
  // replace the editor before setTimeout fires. Persist intent after the native click; the next
  // reconcile resolves the latest view and attaches the extension to that exact instance.
  if (getEditorRoot(group)?.querySelector(".nowen-md-preview")) {
    buttons.source.click();
    writeLivePreference(true);
    return;
  }
  try {
    setLivePreview(state, true);
    writeLivePreference(true);
    paintLiveButtons(group, true);
  } catch (error) {
    console.error("[markdown] failed to activate Live preview:", error);
    writeLivePreference(false);
    toast.error("实时预览启动失败，请重试或切换到普通预览");
  }
}

function bindModeButtons(group: HTMLElement, state: EditorBridgeState): void {
  let buttons = getModeButtons(group);
  if (!buttons) return;
  if (!buttons.live) {
    group.insertBefore(createLiveButton(buttons.source), buttons.preview);
    buttons = getModeButtons(group);
  }
  if (!buttons?.live) return;

  if (!buttons.live.dataset.nowenMarkdownBound) {
    buttons.live.dataset.nowenMarkdownBound = "1";
    // Only capture the toolbar; source buttons and CodeMirror are resolved anew for every click.
    buttons.live.addEventListener("click", () => activateLive(group));
  }
  for (const button of [buttons.source, buttons.preview, buttons.split]) {
    if (button.dataset.nowenMarkdownBridgeBound) continue;
    button.dataset.nowenMarkdownBridgeBound = "1";
    button.addEventListener("click", () => {
      const current = getCurrentState(group);
      if (current?.liveActive) setLivePreview(current, false);
      writeLivePreference(false);
      paintLiveButtons(group, false);
    });
  }

  if (readLivePreference()) {
    if (state.view.state.doc.length > LIVE_PREVIEW_MAX_LENGTH) {
      writeLivePreference(false);
      if (state.liveActive) setLivePreview(state, false);
      paintLiveButtons(group, false);
      toast.info("文档过大，已退出实时预览；可使用普通预览");
      return;
    }
    // Note switching can reset the React layout to the default preview/split mode without
    // invoking a native button. Restore source first, then let the next DOM pass enable Live.
    const buttonsNow = getModeButtons(group);
    if (getEditorRoot(group)?.querySelector(".nowen-md-preview") && buttonsNow) {
      buttonsNow.source.click();
      writeLivePreference(true);
      return;
    }
    if (!state.liveActive) setLivePreview(state, true);
    paintLiveButtons(group, true);
  } else {
    if (state.liveActive) setLivePreview(state, false);
    paintLiveButtons(group, false);
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
  const isSplit = !!(previewRoot && sourcePane && previewPane && sourcePane.style.width && previewPane.style.width);
  if (!isSplit) {
    clearSplitBinding(state);
    return;
  }
  if (state.splitPreviewRoot === previewRoot && state.splitCleanup) return;
  clearSplitBinding(state);
  sourcePane!.style.overflow = "hidden";
  previewPane!.style.overflow = "hidden";
  state.splitSourcePane = sourcePane;
  state.splitPreviewPane = previewPane;
  state.splitPreviewRoot = previewRoot;
  state.splitCleanup = attachMarkdownSplitScrollSync(state.view, previewRoot!);
}

function reconcileMarkdownEditors(): Set<EditorBridgeState> {
  const seen = new Set<EditorBridgeState>();
  for (const host of document.querySelectorAll<HTMLElement>(".nowen-md-editor")) {
    const view = getEditorView(host);
    if (!view) continue;
    const editorRoot = host.closest<HTMLElement>("[data-markdown-mobile-editing-compact]");
    if (!editorRoot) continue;
    const state = getState(view);
    seen.add(state);
    ensureFencedCodeAuthoring(state);
    const group = findMarkdownModeGroup(editorRoot);
    if (group) bindModeButtons(group, state);
    bindSplitScroll(host, editorRoot, state);
  }
  return seen;
}

/** Compatibility bridge for the 1.5.0 editor; a native React mode is a separate refactor. */
export default function MarkdownExperienceBridge() {
  useEffect(() => {
    let frame = 0;
    let tracked = new Set<EditorBridgeState>();
    const reconcile = () => {
      frame = 0;
      const current = reconcileMarkdownEditors();
      for (const old of tracked) if (!current.has(old)) clearSplitBinding(old);
      tracked = current;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(reconcile);
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
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("focus", schedule);
      for (const old of tracked) clearSplitBinding(old);
    };
  }, []);
  return null;
}
