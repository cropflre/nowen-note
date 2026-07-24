import type { EditorPerformanceRun } from "@/lib/editorPerformanceProtocol";

export type Issue210Platform = "web" | "electron";
export type Issue210MediaPhase = "unmarked" | "first-open" | "second-open" | "video-seek";

export interface Issue210SelectionSnapshot {
  anchorPath: string;
  anchorOffset: number;
  focusPath: string;
  focusOffset: number;
}

export interface Issue210EditorSnapshot {
  editorInstanceId: string | null;
  noteId: string | null;
  selection: Issue210SelectionSnapshot | null;
  scrollTop: number | null;
}

export interface Issue210SaveStabilitySample {
  url: string;
  method: string;
  status: number;
  startedAt: number;
  durationMs: number;
  before: Issue210EditorSnapshot;
  after: Issue210EditorSnapshot;
  instanceStable: boolean;
  selectionStable: boolean;
  scrollDeltaPx: number | null;
  layoutShiftDelta: number;
}

export interface Issue210MediaResourceSample {
  phase: Issue210MediaPhase;
  name: string;
  initiatorType: string;
  startTime: number;
  durationMs: number;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  responseStatus: number | null;
  fromCache: boolean;
}

export interface Issue210SignoffSnapshot {
  schemaVersion: 1;
  platform: Issue210Platform;
  capturedAt: string;
  userAgent: string;
  layoutShiftTotal: number;
  saveSamples: Issue210SaveStabilitySample[];
  mediaResources: Issue210MediaResourceSample[];
  performanceRuns: EditorPerformanceRun[];
}

export interface Issue210SignoffApi {
  reset(): void;
  markMediaPhase(phase: Issue210MediaPhase): void;
  recordPerformanceRun(run: EditorPerformanceRun): void;
  snapshot(): Issue210SignoffSnapshot;
  download(filename?: string): void;
}

declare global {
  interface Window {
    __NOWEN_ISSUE_210_SIGNOFF__?: Issue210SignoffApi;
    __NOWEN_ISSUE_210_SIGNOFF_INSTALLED__?: boolean;
  }
}

const editorIds = new WeakMap<Element, string>();
let editorSequence = 0;

function isEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (import.meta.env.VITE_ISSUE_210_SIGNOFF === "1") return true;
  try {
    const query = new URLSearchParams(window.location.search);
    if (query.get("issue210Perf") === "1") return true;
    return localStorage.getItem("nowen.issue210.signoff") === "1";
  } catch {
    return false;
  }
}

function resolvePlatform(): Issue210Platform {
  try {
    const desktop = (window as unknown as { nowenDesktop?: { isDesktop?: boolean } }).nowenDesktop;
    return desktop?.isDesktop ? "electron" : "web";
  } catch {
    return "web";
  }
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function findActiveEditor(): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const closest = active.closest<HTMLElement>(".ProseMirror, .cm-editor");
    if (closest) return closest;
  }
  return document.querySelector<HTMLElement>(
    '.ProseMirror[contenteditable="true"], .cm-editor',
  );
}

function editorInstanceId(editor: Element | null): string | null {
  if (!editor) return null;
  const existing = editorIds.get(editor);
  if (existing) return existing;
  const id = `editor-${++editorSequence}`;
  editorIds.set(editor, id);
  return id;
}

function nodePath(root: Node, target: Node | null): string | null {
  if (!target || (root !== target && !root.contains(target))) return null;
  if (root === target) return "root";
  const indexes: number[] = [];
  let current: Node | null = target;
  while (current && current !== root) {
    const parent: ParentNode | null = current.parentNode;
    if (!parent) return null;
    const index = Array.prototype.indexOf.call(parent.childNodes, current) as number;
    if (index < 0) return null;
    indexes.push(index);
    current = parent as Node;
  }
  return current === root ? indexes.reverse().join(".") : null;
}

function captureSelection(editor: HTMLElement | null): Issue210SelectionSnapshot | null {
  if (!editor) return null;
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) return null;
  const anchorPath = nodePath(editor, selection.anchorNode);
  const focusPath = nodePath(editor, selection.focusNode);
  if (anchorPath === null || focusPath === null) return null;
  return {
    anchorPath,
    anchorOffset: selection.anchorOffset,
    focusPath,
    focusOffset: selection.focusOffset,
  };
}

function findScrollContainer(editor: HTMLElement | null): HTMLElement | null {
  let current = editor?.parentElement || null;
  while (current) {
    const style = window.getComputedStyle(current);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY)
      && current.scrollHeight > current.clientHeight + 1;
    if (scrollable) return current;
    current = current.parentElement;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

function captureEditorState(): Issue210EditorSnapshot {
  const editor = findActiveEditor();
  const noteHost = editor?.closest<HTMLElement>("[data-note-id]");
  const scroller = findScrollContainer(editor);
  return {
    editorInstanceId: editorInstanceId(editor),
    noteId: noteHost?.dataset.noteId || null,
    selection: captureSelection(editor),
    scrollTop: scroller ? scroller.scrollTop : null,
  };
}

export function areIssue210SelectionsEqual(
  first: Issue210SelectionSnapshot | null,
  second: Issue210SelectionSnapshot | null,
): boolean {
  if (first === null || second === null) return first === second;
  return first.anchorPath === second.anchorPath
    && first.anchorOffset === second.anchorOffset
    && first.focusPath === second.focusPath
    && first.focusOffset === second.focusOffset;
}

function requestUrl(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url;
  return String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

export function isIssue210NoteSaveRequest(url: string, method: string): boolean {
  if (method !== "PUT" && method !== "PATCH") return false;
  try {
    const parsed = new URL(url, window.location.href);
    return /\/api\/notes\/[^/]+(?:\/blocks)?\/?$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function afterTwoPaints(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}

function normalizeRun(run: EditorPerformanceRun): EditorPerformanceRun {
  return JSON.parse(JSON.stringify(run)) as EditorPerformanceRun;
}

export function installIssue210SignoffRuntime(): Issue210SignoffApi | null {
  if (!isEnabled()) return null;
  if (window.__NOWEN_ISSUE_210_SIGNOFF_INSTALLED__) {
    return window.__NOWEN_ISSUE_210_SIGNOFF__ || null;
  }
  window.__NOWEN_ISSUE_210_SIGNOFF_INSTALLED__ = true;

  const platform = resolvePlatform();
  let mediaPhase: Issue210MediaPhase = "unmarked";
  let layoutShiftTotal = 0;
  const saveSamples: Issue210SaveStabilitySample[] = [];
  const mediaResources: Issue210MediaResourceSample[] = [];
  const performanceRuns: EditorPerformanceRun[] = [];
  const resourceKeys = new Set<string>();

  let layoutObserver: PerformanceObserver | null = null;
  let resourceObserver: PerformanceObserver | null = null;

  if (typeof PerformanceObserver !== "undefined") {
    try {
      layoutObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const value = (entry as PerformanceEntry & { value?: number }).value;
          if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            layoutShiftTotal += value;
          }
        }
      });
      layoutObserver.observe({ type: "layout-shift", buffered: true });
    } catch {
      layoutObserver = null;
    }

    try {
      resourceObserver = new PerformanceObserver((list) => {
        for (const raw of list.getEntries()) {
          const entry = raw as PerformanceResourceTiming & { responseStatus?: number };
          if (!entry.name.includes("/api/attachments/")) continue;
          const key = `${entry.name}|${entry.startTime}|${entry.duration}`;
          if (resourceKeys.has(key)) continue;
          resourceKeys.add(key);
          const transferSize = finiteNonNegative(entry.transferSize);
          const encodedBodySize = finiteNonNegative(entry.encodedBodySize);
          const decodedBodySize = finiteNonNegative(entry.decodedBodySize);
          const responseStatus = Number.isFinite(entry.responseStatus)
            ? Number(entry.responseStatus)
            : null;
          mediaResources.push({
            phase: mediaPhase,
            name: entry.name,
            initiatorType: entry.initiatorType || "unknown",
            startTime: finiteNonNegative(entry.startTime),
            durationMs: finiteNonNegative(entry.duration),
            transferSize,
            encodedBodySize,
            decodedBodySize,
            responseStatus,
            fromCache: transferSize === 0 && (encodedBodySize > 0 || decodedBodySize > 0),
          });
        }
      });
      resourceObserver.observe({ type: "resource", buffered: true });
    } catch {
      resourceObserver = null;
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    if (!isIssue210NoteSaveRequest(url, method)) return originalFetch(input, init);

    const before = captureEditorState();
    const layoutBefore = layoutShiftTotal;
    const startedAt = performance.now();
    try {
      const response = await originalFetch(input, init);
      afterTwoPaints(() => {
        const after = captureEditorState();
        const scrollDeltaPx = before.scrollTop === null || after.scrollTop === null
          ? null
          : after.scrollTop - before.scrollTop;
        saveSamples.push({
          url,
          method,
          status: response.status,
          startedAt,
          durationMs: Math.max(0, performance.now() - startedAt),
          before,
          after,
          instanceStable: before.editorInstanceId !== null
            && before.editorInstanceId === after.editorInstanceId,
          selectionStable: areIssue210SelectionsEqual(before.selection, after.selection),
          scrollDeltaPx,
          layoutShiftDelta: Math.max(0, layoutShiftTotal - layoutBefore),
        });
      });
      return response;
    } catch (error) {
      afterTwoPaints(() => {
        const after = captureEditorState();
        saveSamples.push({
          url,
          method,
          status: 0,
          startedAt,
          durationMs: Math.max(0, performance.now() - startedAt),
          before,
          after,
          instanceStable: before.editorInstanceId !== null
            && before.editorInstanceId === after.editorInstanceId,
          selectionStable: areIssue210SelectionsEqual(before.selection, after.selection),
          scrollDeltaPx: before.scrollTop === null || after.scrollTop === null
            ? null
            : after.scrollTop - before.scrollTop,
          layoutShiftDelta: Math.max(0, layoutShiftTotal - layoutBefore),
        });
      });
      throw error;
    }
  }) as typeof window.fetch;

  const snapshot = (): Issue210SignoffSnapshot => ({
    schemaVersion: 1,
    platform,
    capturedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    layoutShiftTotal,
    saveSamples: saveSamples.map((sample) => JSON.parse(JSON.stringify(sample)) as Issue210SaveStabilitySample),
    mediaResources: mediaResources.map((sample) => ({ ...sample })),
    performanceRuns: performanceRuns.map(normalizeRun),
  });

  const api: Issue210SignoffApi = {
    reset() {
      saveSamples.length = 0;
      mediaResources.length = 0;
      performanceRuns.length = 0;
      resourceKeys.clear();
      layoutShiftTotal = 0;
      mediaPhase = "unmarked";
      performance.clearResourceTimings?.();
    },
    markMediaPhase(phase) {
      mediaPhase = phase;
    },
    recordPerformanceRun(run) {
      if (!run || run.platform !== platform) {
        throw new Error(`performance run platform must match ${platform}`);
      }
      const index = performanceRuns.findIndex((item) => item.scenario === run.scenario);
      const copy = normalizeRun(run);
      if (index >= 0) performanceRuns[index] = copy;
      else performanceRuns.push(copy);
    },
    snapshot,
    download(filename) {
      const payload = JSON.stringify(snapshot(), null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename || `issue-210-${platform}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    },
  };

  window.__NOWEN_ISSUE_210_SIGNOFF__ = api;
  window.addEventListener("beforeunload", () => {
    layoutObserver?.disconnect();
    resourceObserver?.disconnect();
  }, { once: true });
  return api;
}
