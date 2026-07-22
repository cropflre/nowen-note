export type PhaseBPerfEvent = {
  type:
    | "sidebar-render"
    | "notebook-item-render"
    | "build-notebook-tree"
    | "long-task"
    | "create-click"
    | "create-request-start"
    | "create-response"
    | "create-state-dispatch"
    | "create-input-focused"
    | "browser-interaction";
  durationMs?: number;
  notebookId?: string;
  detail?: Record<string, string | number | boolean | null>;
  timestamp?: number;
};

declare global {
  var __NOWEN_PHASE_B_PERF_EVENTS__: PhaseBPerfEvent[] | undefined;
  var __NOWEN_PHASE_B_PERF_SINK__: ((event: PhaseBPerfEvent) => void) | undefined;
}

export const PHASE_B_PERF_ENABLED = import.meta.env.MODE === "test"
  || import.meta.env.VITE_PHASE_B_PERF === "1";

const MAX_BROWSER_EVENTS = 100_000;
const browserEvents: PhaseBPerfEvent[] = [];
const createTraceByNotebookId = new Map<string, string>();
let exposeTimer: number | null = null;

export function rememberPhaseBCreateTrace(notebookId: string, traceId: string): void {
  if (!PHASE_B_PERF_ENABLED) return;
  createTraceByNotebookId.set(notebookId, traceId);
}

export function takePhaseBCreateTrace(notebookId: string): string | undefined {
  if (!PHASE_B_PERF_ENABLED) return undefined;
  const traceId = createTraceByNotebookId.get(notebookId);
  createTraceByNotebookId.delete(notebookId);
  return traceId;
}

export function forgetPhaseBCreateTrace(notebookId: string): void {
  if (!PHASE_B_PERF_ENABLED) return;
  createTraceByNotebookId.delete(notebookId);
}

function exposeBrowserEvents(): void {
  if (import.meta.env.VITE_PHASE_B_PERF !== "1" || typeof document === "undefined" || exposeTimer !== null) return;
  exposeTimer = window.setTimeout(() => {
    exposeTimer = null;
    let output = document.getElementById("nowen-phase-b-perf-data");
    if (!output) {
      output = document.createElement("script");
      output.id = "nowen-phase-b-perf-data";
      output.setAttribute("type", "application/json");
      document.head.appendChild(output);
    }
    output.textContent = JSON.stringify(browserEvents.slice(-MAX_BROWSER_EVENTS));
  }, 25);
}

export function recordPhaseBPerfEvent(event: PhaseBPerfEvent): void {
  if (!PHASE_B_PERF_ENABLED) return;
  const timestamped = { ...event, timestamp: event.timestamp ?? performance.now() };
  globalThis.__NOWEN_PHASE_B_PERF_SINK__?.(timestamped);
  if (import.meta.env.VITE_PHASE_B_PERF !== "1") return;
  browserEvents.push(timestamped);
  if (browserEvents.length > MAX_BROWSER_EVENTS) browserEvents.splice(0, 20_000);
  globalThis.__NOWEN_PHASE_B_PERF_EVENTS__ = browserEvents;
  exposeBrowserEvents();
}

export function installPhaseBLongTaskObserver(): () => void {
  if (!PHASE_B_PERF_ENABLED || typeof PerformanceObserver === "undefined") return () => undefined;
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        recordPhaseBPerfEvent({
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
  return () => observer?.disconnect();
}

export function installPhaseBBrowserInteractionObserver(): () => void {
  if (!PHASE_B_PERF_ENABLED || typeof document === "undefined") return () => undefined;
  const eventTypes = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "focusin"];
  const handleEvent = (event: Event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    recordPhaseBPerfEvent({
      type: "browser-interaction",
      detail: {
        name: event.type,
        eventTimestamp: event.timeStamp,
        target: target?.tagName.toLowerCase() || "unknown",
      },
    });
  };
  eventTypes.forEach((type) => document.addEventListener(type, handleEvent, true));
  return () => {
    eventTypes.forEach((type) => document.removeEventListener(type, handleEvent, true));
    if (exposeTimer !== null) {
      window.clearTimeout(exposeTimer);
      exposeTimer = null;
    }
  };
}
