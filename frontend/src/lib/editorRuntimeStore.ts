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
const NOTICE_ID = "nowen-editor-runtime-notice";

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

#${NOTICE_ID} {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 70;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(520px, calc(100vw - 32px));
  padding: 9px 10px 9px 12px;
  border: 1px solid color-mix(in srgb, var(--color-accent-primary, #3b82f6) 35%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--color-app-elevated, #fff) 94%, transparent);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.16);
  color: var(--color-tx-primary, #111827);
  backdrop-filter: blur(12px);
  font-size: 12px;
  line-height: 1.35;
}
#${NOTICE_ID}[hidden] { display: none !important; }
#${NOTICE_ID}[data-mode="lightweight-edit"] {
  border-color: color-mix(in srgb, #f59e0b 45%, transparent);
}
#${NOTICE_ID} .nowen-runtime-copy { min-width: 0; }
#${NOTICE_ID} .nowen-runtime-title { display: block; font-weight: 650; }
#${NOTICE_ID} .nowen-runtime-detail {
  display: block;
  margin-top: 1px;
  color: var(--color-tx-secondary, #6b7280);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${NOTICE_ID} button {
  flex: none;
  border: 1px solid color-mix(in srgb, var(--color-accent-primary, #3b82f6) 35%, transparent);
  border-radius: 8px;
  padding: 5px 8px;
  background: color-mix(in srgb, var(--color-accent-primary, #3b82f6) 10%, transparent);
  color: var(--color-accent-primary, #2563eb);
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}
#${NOTICE_ID} button:hover { background: color-mix(in srgb, var(--color-accent-primary, #3b82f6) 18%, transparent); }
@media (max-width: 767px) {
  #${NOTICE_ID} {
    right: 10px;
    bottom: calc(10px + env(safe-area-inset-bottom));
    max-width: calc(100vw - 20px);
  }
  #${NOTICE_ID} .nowen-runtime-detail { display: none; }
}
`;
  document.head.appendChild(style);
}

function runtimeNoticeCopy(mode: EditorRuntimeMode): {
  title: string;
  detail: string;
  action: string;
} {
  const language = typeof navigator !== "undefined"
    ? (document.documentElement.lang || navigator.language || "").toLowerCase()
    : "";
  const zh = language.startsWith("zh");

  if (mode === "lightweight-edit") {
    return zh
      ? {
          title: "轻量编辑模式",
          detail: "已暂停代码高亮、全文实时分析和复杂节点工具栏，正文仍可编辑保存。",
          action: "尝试完整模式",
        }
      : {
          title: "Lightweight editing",
          detail: "Syntax highlighting and whole-document analysis are paused; editing and saving remain available.",
          action: "Try full mode",
        };
  }

  return zh
    ? {
        title: "视口优化模式",
        detail: "图片和代码块仅在接近可见区域时加载，正文功能保持不变。",
        action: "恢复完整模式",
      }
    : {
        title: "Viewport optimized",
        detail: "Images and code highlighting load near the visible area while editing remains unchanged.",
        action: "Restore full mode",
      };
}

function ensureRuntimeNotice(): HTMLDivElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  const existing = document.getElementById(NOTICE_ID);
  if (existing instanceof HTMLDivElement) return existing;

  const notice = document.createElement("div");
  notice.id = NOTICE_ID;
  notice.hidden = true;
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");

  const copy = document.createElement("span");
  copy.className = "nowen-runtime-copy";
  const title = document.createElement("span");
  title.className = "nowen-runtime-title";
  title.dataset.runtimeTitle = "";
  const detail = document.createElement("span");
  detail.className = "nowen-runtime-detail";
  detail.dataset.runtimeDetail = "";
  copy.append(title, detail);

  const action = document.createElement("button");
  action.type = "button";
  action.dataset.runtimeAction = "";
  action.addEventListener("click", () => {
    requestActiveEditorRuntimeMode("normal");
  });

  notice.append(copy, action);
  document.body.appendChild(notice);
  return notice;
}

function updateRuntimeNotice(): void {
  const notice = ensureRuntimeNotice();
  if (!notice) return;
  const mode = state.decision.mode;
  const visible = mode === "viewport-optimized" || mode === "lightweight-edit";
  notice.hidden = !visible;
  if (!visible) return;

  notice.dataset.mode = mode;
  const copy = runtimeNoticeCopy(mode);
  const title = notice.querySelector<HTMLElement>("[data-runtime-title]");
  const detail = notice.querySelector<HTMLElement>("[data-runtime-detail]");
  const action = notice.querySelector<HTMLButtonElement>("[data-runtime-action]");
  if (title) title.textContent = copy.title;
  if (detail) detail.textContent = copy.detail;
  if (action) action.textContent = copy.action;
}

function applyDocumentState(): void {
  if (typeof document === "undefined") return;
  installRuntimeStyle();
  document.documentElement.dataset.nowenEditorRuntimeMode = state.decision.mode;
  document.documentElement.dataset.nowenEditorRuntimeNote = state.noteId || "";
  document.documentElement.dataset.nowenEditorRuntimeReasons = state.decision.reasons.join(",");
  updateRuntimeNotice();
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

/**
 * Session-only user override. Emergency readonly cannot be bypassed here because Tiptap/Y.js were
 * intentionally never mounted. For editable modes the user may retry full mode; long-task
 * monitoring remains active and will degrade again if the main thread becomes unsafe.
 */
export function requestActiveEditorRuntimeMode(
  mode: Exclude<EditorRuntimeMode, "emergency-readonly">,
): EditorRuntimeDecision {
  if (state.decision.mode === "emergency-readonly") return state.decision;
  const reasons = state.decision.reasons.filter(
    (reason) => reason !== "runtime-long-task" && reason !== "initialization-timeout",
  );
  const next = createEditorRuntimeDecision(mode, reasons, state.decision.profile);
  if (next.mode === state.decision.mode) return state.decision;
  state = { ...state, decision: next };
  recentLongTasks = [];
  emit();
  return next;
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
