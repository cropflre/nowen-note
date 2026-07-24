import { getCodeBlockAutoLanguageSubset } from "@/lib/codeBlockLowlight";
import { isActiveEditorCapabilityEnabled } from "@/lib/editorRuntimeStore";

export type PhaseAPerfEvent = {
  type:
    | "code-block-render"
    | "code-block-permission-state-update"
    | "tiptap-editor-render"
    | "tiptap-transaction"
    | "tiptap-plain-text"
    | "tiptap-word-stats"
    | "tiptap-headings"
    | "tiptap-on-update"
    | "tiptap-parse-content"
    | "prosemirror-dispatch"
    | "lowlight-highlight"
    | "highlight-task-created"
    | "highlight-task-cancelled"
    | "highlight-task-executed"
    | "highlight-task-stale"
    | "highlight-task-applied"
    | "highlight-queue-depth"
    | "highlight-viewport-range"
    | "app-context-dispatch"
    | "react-commit"
    | "keydown-to-paint"
    | "long-task";
  blockId?: string;
  durationMs?: number;
  detail?: Record<string, string | number | boolean | null>;
  timestamp?: number;
};

declare global {
  // Test-only hook. Vite replaces MODE at build time and removes this branch in production.
  var __NOWEN_PHASE_A_PERF_SINK__: ((event: PhaseAPerfEvent) => void) | undefined;
  var __NOWEN_PHASE_A_PERF_EVENTS__: PhaseAPerfEvent[] | undefined;
  var __NOWEN_PHASE_A_PERF_OBSERVERS_INSTALLED__: boolean | undefined;
}

const phaseAPerfEnabled = import.meta.env.MODE === "test" || import.meta.env.VITE_PHASE_A_PERF === "1";
const MAX_BROWSER_EVENTS = 5_000;
let lastBeforeInputAt: number | null = null;
const browserEvents: PhaseAPerfEvent[] = [];
let exposeTimer: number | null = null;
let browserObserverUsers = 0;
let removeBrowserObservers: (() => void) | null = null;

export function isPhaseAPerfEnabled(): boolean {
  return phaseAPerfEnabled;
}

function scheduleBrowserExposure(): void {
  if (import.meta.env.VITE_PHASE_A_PERF !== "1" || typeof document === "undefined" || exposeTimer !== null) return;
  exposeTimer = window.setTimeout(() => {
    exposeTimer = null;
    let output = document.getElementById("nowen-phase-a-perf-data");
    if (!output) {
      output = document.createElement("script");
      output.id = "nowen-phase-a-perf-data";
      output.setAttribute("type", "application/json");
      document.head.appendChild(output);
    }
    output.textContent = JSON.stringify(browserEvents.slice(-500));
  }, 50);
}

export function recordPhaseAPerfEvent(event: PhaseAPerfEvent): void {
  if (!phaseAPerfEnabled) return;
  const timestamped = { ...event, timestamp: event.timestamp ?? performance.now() };
  globalThis.__NOWEN_PHASE_A_PERF_SINK__?.(timestamped);
  if (import.meta.env.VITE_PHASE_A_PERF === "1") {
    browserEvents.push(timestamped);
    if (browserEvents.length > MAX_BROWSER_EVENTS) browserEvents.splice(0, 1_000);
    globalThis.__NOWEN_PHASE_A_PERF_EVENTS__ = browserEvents;
    scheduleBrowserExposure();
  }
}

export function recordPhaseATransaction(): void {
  if (!phaseAPerfEnabled || lastBeforeInputAt === null) return;
  recordPhaseAPerfEvent({ type: "tiptap-transaction", durationMs: performance.now() - lastBeforeInputAt });
  lastBeforeInputAt = null;
}

export function installPhaseABrowserObservers(): () => void {
  if (!phaseAPerfEnabled || typeof window === "undefined") return () => undefined;
  browserObserverUsers += 1;
  if (!globalThis.__NOWEN_PHASE_A_PERF_OBSERVERS_INSTALLED__) {
    globalThis.__NOWEN_PHASE_A_PERF_OBSERVERS_INSTALLED__ = true;
    const pendingAnimationFrames = new Set<number>();
    const handleBeforeInput = () => {
      lastBeforeInputAt = performance.now();
    };
    const handleKeyDown = () => {
      const startedAt = performance.now();
      const firstFrame = requestAnimationFrame(() => {
        pendingAnimationFrames.delete(firstFrame);
        const secondFrame = requestAnimationFrame(() => {
          pendingAnimationFrames.delete(secondFrame);
          recordPhaseAPerfEvent({ type: "keydown-to-paint", durationMs: performance.now() - startedAt });
        });
        pendingAnimationFrames.add(secondFrame);
      });
      pendingAnimationFrames.add(firstFrame);
    };
    window.addEventListener("beforeinput", handleBeforeInput, true);
    window.addEventListener("keydown", handleKeyDown, true);

    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== "undefined") {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            recordPhaseAPerfEvent({
              type: "long-task",
              durationMs: entry.duration,
              detail: { startTime: entry.startTime },
            });
          }
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        observer = null;
      }
    }

    removeBrowserObservers = () => {
      window.removeEventListener("beforeinput", handleBeforeInput, true);
      window.removeEventListener("keydown", handleKeyDown, true);
      for (const frame of pendingAnimationFrames) cancelAnimationFrame(frame);
      pendingAnimationFrames.clear();
      observer?.disconnect();
      lastBeforeInputAt = null;
      globalThis.__NOWEN_PHASE_A_PERF_OBSERVERS_INSTALLED__ = false;
    };
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    browserObserverUsers = Math.max(0, browserObserverUsers - 1);
    if (browserObserverUsers !== 0) return;
    removeBrowserObservers?.();
    removeBrowserObservers = null;
    if (exposeTimer !== null) {
      window.clearTimeout(exposeTimer);
      exposeTimer = null;
    }
  };
}

type InstrumentedEditor<TTransaction> = {
  view: { dispatch: (transaction: TTransaction) => void };
};

export function installPhaseAEditorTransactionInstrumentation<TTransaction>(editor: InstrumentedEditor<TTransaction>): () => void {
  if (!phaseAPerfEnabled) return () => undefined;
  const view = editor.view;
  const originalDispatch = view.dispatch;
  const instrumentedDispatch = (transaction: TTransaction) => {
    const startedAt = performance.now();
    try {
      return originalDispatch.call(view, transaction);
    } finally {
      recordPhaseAPerfEvent({ type: "prosemirror-dispatch", durationMs: performance.now() - startedAt });
    }
  };
  view.dispatch = instrumentedDispatch;
  return () => {
    if (view.dispatch === instrumentedDispatch) view.dispatch = originalDispatch;
  };
}

type LowlightAutoOptions = { subset?: string[] } | null | undefined;

/**
 * Wrap lowlight once for diagnostics, runtime capability control, and stable automatic detection.
 *
 * Lightweight mode keeps code blocks editable but returns an empty highlight tree, avoiding a
 * synchronous full-code parse on every transaction. The wrapper reads the current capability at
 * call time, so a long-task-triggered runtime downgrade takes effect without remounting Tiptap.
 */
export function instrumentPhaseALowlight<T extends {
  highlight: (language: string, code: string) => unknown;
  highlightAuto: (code: string, options?: LowlightAutoOptions) => unknown;
  listLanguages?: () => string[];
}>(instance: T): T {
  if ((instance as T & { __nowenPhaseAInstrumented?: boolean }).__nowenPhaseAInstrumented) return instance;
  const marked = instance as T & { __nowenPhaseAInstrumented?: boolean };
  marked.__nowenPhaseAInstrumented = true;
  const highlight = instance.highlight.bind(instance);
  const highlightAuto = instance.highlightAuto.bind(instance);
  const emptyResult = () => ({ children: [] });

  instance.highlight = ((language: string, code: string) => {
    if (!isActiveEditorCapabilityEnabled("syntax-highlight")) return emptyResult();
    const startedAt = performance.now();
    try {
      return highlight(language, code);
    } finally {
      recordPhaseAPerfEvent({
        type: "lowlight-highlight",
        durationMs: performance.now() - startedAt,
        detail: { mode: "explicit", language, codeLength: code.length },
      });
    }
  }) as T["highlight"];
  instance.highlightAuto = ((code: string, options?: LowlightAutoOptions) => {
    if (!isActiveEditorCapabilityEnabled("syntax-highlight")) return emptyResult();
    const startedAt = performance.now();
    try {
      const subset = options?.subset || (
        typeof instance.listLanguages === "function"
          ? getCodeBlockAutoLanguageSubset({ listLanguages: instance.listLanguages.bind(instance) })
          : undefined
      );
      return highlightAuto(code, subset ? { ...(options || {}), subset } : options);
    } finally {
      recordPhaseAPerfEvent({
        type: "lowlight-highlight",
        durationMs: performance.now() - startedAt,
        detail: { mode: "auto", language: "auto", codeLength: code.length },
      });
    }
  }) as T["highlightAuto"];
  return instance;
}
