import {
  createEditorRuntimeDecision,
  type EditorRuntimeCapability,
  type EditorRuntimeDecision,
  type EditorRuntimeMode,
  withEditorRuntimeMode,
} from "@/lib/editorRuntimePolicy";
import { buildEditorComplexityProfile } from "@/lib/editorComplexityProfile";

export interface ActiveEditorRuntimeState {
  noteId: string | null;
  decision: EditorRuntimeDecision;
}

type Listener = () => void;

const DEFAULT_DECISION = createEditorRuntimeDecision(
  "normal",
  [],
  buildEditorComplexityProfile("", "tiptap-json"),
);

let state: ActiveEditorRuntimeState = {
  noteId: null,
  decision: DEFAULT_DECISION,
};
const listeners = new Set<Listener>();
let styleInstalled = false;
let longTaskObserverInstalled = false;
let recentLongTasks: number[] = [];

const STYLE_ID = "nowen-editor-runtime-style";

function installRuntimeStyle(): void {
  if (styleInstalled || typeof document === "undefined") return;
  styleInstalled = true;
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
html[data-nowen-editor-runtime-mode="viewport-optimized"] .ProseMirror .resizable-image-wrapper,
html[data-nowen-editor-runtime-mode="viewport-optimized"] .ProseMirror .code-block-wrapper,
html[data-nowen-editor-runtime-mode="viewport-optimized"] .ProseMirror table,
html[data-nowen-editor-runtime-mode="viewport-optimized"] .ProseMirror iframe,
html[data-nowen-editor-runtime-mode="viewport-optimized"] .ProseMirror video,
html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror .resizable-image-wrapper,
html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror .code-block-wrapper,
html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror table,
html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror iframe,
html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror video {
  content-visibility: auto;
  contain-intrinsic-size: auto 240px;
}

html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror .code-block-toolbar [data-codeblock-themepicker],
html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror .image-node-toolbar,
html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror .node-view-floating-toolbar {
  display: none !important;
}

html[data-nowen-editor-runtime-mode="lightweight-edit"] .ProseMirror,
html[data-nowen-editor-runtime-mode="viewport-optimized"] .ProseMirror {
  overflow-anchor: none;
}
`;
  document.head.appendChild(style);
}

function applyDocumentState(): void {
  if (typeof document === "undefined") return;
  installRuntimeStyle();
  document.documentElement.dataset.nowenEditorRuntimeMode = state.decision.mode;
  document.documentElement.dataset.nowenEditorRuntimeNote = state.noteId || "";
  document.documentElement.dataset.nowenEditorRuntimeReasons = state.decision.reasons.join(",");
}

function emit(): void {
  applyDocumentState();
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("nowen:editor-runtime-change", { detail: state }));
  }
}

export function setActiveEditorRuntimeDecision(
  noteId: string,
  decision: EditorRuntimeDecision,
): void {
  state = { noteId, decision };
  recentLongTasks = [];
  emit();
}

export function clearActiveEditorRuntimeDecision(noteId?: string): void {
  if (noteId && state.noteId !== noteId) return;
  state = { noteId: null, decision: DEFAULT_DECISION };
  recentLongTasks = [];
  emit();
}

export function getActiveEditorRuntimeState(): ActiveEditorRuntimeState {
  return state;
}

export function getActiveEditorRuntimeDecision(): EditorRuntimeDecision {
  return state.decision;
}

export function subscribeEditorRuntime(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isActiveEditorCapabilityEnabled(capability: EditorRuntimeCapability): boolean {
  return !state.decision.disabledCapabilities.includes(capability);
}

export function escalateActiveEditorRuntimeMode(
  mode: EditorRuntimeMode,
  reason: "initialization-timeout" | "runtime-long-task",
): EditorRuntimeDecision {
  const next = withEditorRuntimeMode(state.decision, mode, reason);
  if (next === state.decision) return state.decision;
  state = { ...state, decision: next };
  emit();
  return next;
}

function installLongTaskObserver(): void {
  if (longTaskObserverInstalled || typeof PerformanceObserver === "undefined" || typeof window === "undefined") {
    return;
  }
  longTaskObserverInstalled = true;

  try {
    const observer = new PerformanceObserver((list) => {
      const now = performance.now();
      for (const entry of list.getEntries()) {
        if (entry.duration < 200) continue;
        recentLongTasks.push(now);
      }
      recentLongTasks = recentLongTasks.filter((timestamp) => now - timestamp <= 5_000);

      if (state.decision.mode === "normal" && recentLongTasks.length >= 2) {
        escalateActiveEditorRuntimeMode("viewport-optimized", "runtime-long-task");
        recentLongTasks = [];
      } else if (state.decision.mode === "viewport-optimized" && recentLongTasks.length >= 3) {
        escalateActiveEditorRuntimeMode("lightweight-edit", "runtime-long-task");
        recentLongTasks = [];
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserverInstalled = false;
  }
}

if (typeof document !== "undefined") {
  applyDocumentState();
  installLongTaskObserver();
}
