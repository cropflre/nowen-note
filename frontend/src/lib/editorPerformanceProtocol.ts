import {
  evaluateEditorPerformanceBudget,
  type EditorPerformanceSample,
  type EditorPerformanceTarget,
} from "@/lib/editorPerformanceBudget";

export type EditorPerformancePlatform = "web" | "electron" | "android";
export type EditorPerformanceScenario =
  | "markdown-2.4mb"
  | "tiptap-20000"
  | "tiptap-50000"
  | "list-batch-100"
  | "media-100"
  | "media-500"
  | "code-100"
  | "code-500"
  | "switch-20-and-close";

export const EDITOR_PERFORMANCE_PLATFORMS: EditorPerformancePlatform[] = ["web", "electron", "android"];
export const EDITOR_PERFORMANCE_SCENARIOS: EditorPerformanceScenario[] = [
  "markdown-2.4mb",
  "tiptap-20000",
  "tiptap-50000",
  "list-batch-100",
  "media-100",
  "media-500",
  "code-100",
  "code-500",
  "switch-20-and-close",
];

export interface EditorPerformanceLifecycleSnapshot {
  workers: number;
  nodeViews: number;
  mediaRequests: number;
}

export interface EditorPerformanceRun extends EditorPerformanceSample {
  platform: EditorPerformancePlatform;
  scenario: EditorPerformanceScenario;
  longTaskObservationSupported: boolean;
  firstInteractiveMs: number;
  noteSwitchMs: number[];
  lifecycleBaseline?: EditorPerformanceLifecycleSnapshot;
  lifecycleSnapshots: EditorPerformanceLifecycleSnapshot[];
  markdownRenderMatches?: boolean;
  editorMode: "monolithic" | "windowed";
  sectionCount: number;
  peakMountedSections: number;
}

export interface EditorPerformanceMatrixResult {
  passed: boolean;
  missing: string[];
  failed: Array<{ platform: EditorPerformancePlatform; scenario: EditorPerformanceScenario; failures: string[] }>;
}

function targetFor(platform: EditorPerformancePlatform): EditorPerformanceTarget {
  return platform === "android" ? "android-low-power" : "desktop";
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isLifecycleSnapshot(value: unknown): value is EditorPerformanceLifecycleSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<EditorPerformanceLifecycleSnapshot>;
  return isFiniteNonNegative(snapshot.workers)
    && isFiniteNonNegative(snapshot.nodeViews)
    && isFiniteNonNegative(snapshot.mediaRequests);
}

function validateSwitchLifecycle(run: EditorPerformanceRun): string[] {
  const failures: string[] = [];
  if (!Array.isArray(run.noteSwitchMs)
      || run.noteSwitchMs.length !== 20
      || !run.noteSwitchMs.every(isFiniteNonNegative)) {
    failures.push("noteSwitchMs requires 20 valid samples");
  }
  if (!isLifecycleSnapshot(run.lifecycleBaseline)) {
    failures.push("lifecycleBaseline is missing or invalid");
  }
  if (!Array.isArray(run.lifecycleSnapshots)
      || run.lifecycleSnapshots.length !== 20
      || !run.lifecycleSnapshots.every(isLifecycleSnapshot)) {
    failures.push("lifecycleSnapshots requires 20 valid snapshots");
  }
  if (!isLifecycleSnapshot(run.lifecycleBaseline)
      || !Array.isArray(run.lifecycleSnapshots)
      || run.lifecycleSnapshots.length !== 20
      || !run.lifecycleSnapshots.every(isLifecycleSnapshot)) {
    return failures;
  }

  const resources = [
    ["workers", "worker"],
    ["nodeViews", "NodeView"],
    ["mediaRequests", "media request"],
  ] as const;
  for (const [field, label] of resources) {
    const baseline = run.lifecycleBaseline[field];
    const values = run.lifecycleSnapshots.map((snapshot) => snapshot[field]);
    const growsMonotonically = values.some((value) => value > baseline)
      && values.every((value, index) => index === 0 || value >= values[index - 1]);
    if (growsMonotonically) failures.push(`${label} count grows monotonically from baseline`);
    if (values[values.length - 1] > baseline) failures.push(`${label} count did not return to baseline`);
  }
  return failures;
}

/** 对 Web、Electron、Android 的固定矩阵执行 fail-closed 签收。 */
export function evaluateEditorPerformanceMatrix(runs: EditorPerformanceRun[]): EditorPerformanceMatrixResult {
  const byKey = new Map<string, EditorPerformanceRun>();
  const duplicateKeys = new Set<string>();
  for (const run of runs) {
    const key = `${run.platform}:${run.scenario}`;
    if (byKey.has(key)) duplicateKeys.add(key);
    else byKey.set(key, run);
  }
  const missing: string[] = [];
  const failed: EditorPerformanceMatrixResult["failed"] = [];
  for (const platform of EDITOR_PERFORMANCE_PLATFORMS) {
    for (const scenario of EDITOR_PERFORMANCE_SCENARIOS) {
      const run = byKey.get(`${platform}:${scenario}`);
      if (!run) {
        missing.push(`${platform}:${scenario}`);
        continue;
      }
      if (duplicateKeys.has(`${platform}:${scenario}`)) {
        failed.push({ platform, scenario, failures: ["duplicate platform:scenario run"] });
        continue;
      }
      const budget = evaluateEditorPerformanceBudget(run, targetFor(platform));
      const failures = [...budget.failures];
      if (run.longTaskObservationSupported !== true) failures.push("longTaskObservationSupported must be true");
      if (!isFiniteNonNegative(run.firstInteractiveMs)) failures.push("firstInteractiveMs is missing or invalid");
      if (run.editorMode !== "monolithic" && run.editorMode !== "windowed") {
        failures.push("editorMode is missing or invalid");
      }
      if (!Number.isInteger(run.sectionCount) || run.sectionCount < 1) {
        failures.push("sectionCount is missing or invalid");
      }
      if (
        !Number.isInteger(run.peakMountedSections)
        || run.peakMountedSections < 1
        || (Number.isInteger(run.sectionCount) && run.peakMountedSections > run.sectionCount)
      ) {
        failures.push("peakMountedSections is missing or invalid");
      }
      if (scenario === "switch-20-and-close") failures.push(...validateSwitchLifecycle(run));
      if (scenario === "markdown-2.4mb" && run.markdownRenderMatches !== true) failures.push("markdown segmented render mismatch");
      if (failures.length > 0) failed.push({ platform, scenario, failures });
    }
  }
  return { passed: missing.length === 0 && failed.length === 0, missing, failed };
}

export interface EditorPerformanceCollector {
  inputStarted(): () => void;
  noteSwitchStarted(): () => void;
  recordHeap(stage: "before" | "opened" | "scrolled" | "after", bytes: number): void;
  recordDomNodes(count: number): void;
  recordNodeViews(count: number): void;
  recordEditorWindow(mode: "monolithic" | "windowed", sectionCount: number, mountedSections: number): void;
  recordFirstInteractive(ms: number): void;
  recordLifecycleBaseline(workers: number, nodeViews: number, mediaRequests: number): void;
  recordSwitchLifecycle(workers: number, nodeViews: number, mediaRequests: number): void;
  recordLifecycle(workers: number, nodeViews: number, mediaRequests: number): void;
  finish(markdownRenderMatches?: boolean): EditorPerformanceRun;
  dispose(): void;
}

/** 浏览器壳、Electron 和 Android WebView 共用的无框架采集器。 */
export function createEditorPerformanceCollector(
  platform: EditorPerformancePlatform,
  scenario: EditorPerformanceScenario,
  clock: () => number = () => performance.now(),
): EditorPerformanceCollector {
  const inputLatencyMs: number[] = [];
  const noteSwitchMs: number[] = [];
  const longTaskMs: number[] = [];
  const lifecycleSnapshots: EditorPerformanceLifecycleSnapshot[] = [];
  const heap: Record<"before" | "opened" | "scrolled" | "after", number> = {
    before: Number.NaN,
    opened: Number.NaN,
    scrolled: Number.NaN,
    after: Number.NaN,
  };
  let firstInteractiveMs = Number.NaN;
  let peakDomNodes = Number.NaN;
  let peakNodeViews = Number.NaN;
  let editorMode: "monolithic" | "windowed" | undefined;
  let sectionCount = Number.NaN;
  let peakMountedSections = Number.NaN;
  let lifecycleBaseline: EditorPerformanceLifecycleSnapshot | undefined;
  let activeWorkersAfterClose = Number.NaN;
  let activeNodeViewsAfterClose = Number.NaN;
  let activeMediaRequestsAfterClose = Number.NaN;
  let observer: PerformanceObserver | null = null;
  let longTaskObservationSupported = false;
  if (typeof PerformanceObserver !== "undefined") {
    const supportedEntryTypes = PerformanceObserver.supportedEntryTypes;
    const longTaskEntryTypeAvailable = !Array.isArray(supportedEntryTypes)
      || supportedEntryTypes.includes("longtask");
    if (longTaskEntryTypeAvailable) {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTaskMs.push(entry.duration);
        });
        observer.observe({ entryTypes: ["longtask"] });
        longTaskObservationSupported = true;
      } catch {
        observer?.disconnect();
        observer = null;
      }
    }
  }
  const startSample = (target: number[]) => {
    const started = clock();
    return () => target.push(Math.max(0, clock() - started));
  };
  const snapshot = (workers: number, nodeViews: number, mediaRequests: number) => ({
    workers,
    nodeViews,
    mediaRequests,
  });
  return {
    inputStarted: () => startSample(inputLatencyMs),
    noteSwitchStarted: () => startSample(noteSwitchMs),
    recordHeap: (stage, bytes) => { if (Number.isFinite(bytes) && bytes >= 0) heap[stage] = bytes; },
    recordDomNodes: (count) => {
      if (isFiniteNonNegative(count)) peakDomNodes = Number.isNaN(peakDomNodes) ? count : Math.max(peakDomNodes, count);
    },
    recordNodeViews: (count) => {
      if (isFiniteNonNegative(count)) peakNodeViews = Number.isNaN(peakNodeViews) ? count : Math.max(peakNodeViews, count);
    },
    recordEditorWindow: (mode, totalSections, mountedSections) => {
      if (mode !== "monolithic" && mode !== "windowed") return;
      if (!Number.isInteger(totalSections) || totalSections < 1) return;
      if (!Number.isInteger(mountedSections) || mountedSections < 1 || mountedSections > totalSections) return;
      editorMode = mode;
      sectionCount = totalSections;
      peakMountedSections = Number.isNaN(peakMountedSections)
        ? mountedSections
        : Math.max(peakMountedSections, mountedSections);
    },
    recordFirstInteractive: (ms) => { firstInteractiveMs = ms; },
    recordLifecycleBaseline: (workers, nodeViews, mediaRequests) => {
      lifecycleBaseline = snapshot(workers, nodeViews, mediaRequests);
    },
    recordSwitchLifecycle: (workers, nodeViews, mediaRequests) => {
      lifecycleSnapshots.push(snapshot(workers, nodeViews, mediaRequests));
    },
    recordLifecycle: (workers, nodeViews, mediaRequests) => {
      activeWorkersAfterClose = workers;
      activeNodeViewsAfterClose = nodeViews;
      activeMediaRequestsAfterClose = mediaRequests;
    },
    finish: (markdownRenderMatches) => ({
      platform,
      scenario,
      inputLatencyMs: [...inputLatencyMs],
      longTaskMs: [...longTaskMs],
      longTaskObservationSupported,
      noteSwitchMs: [...noteSwitchMs],
      firstInteractiveMs,
      peakDomNodes,
      peakNodeViews,
      heapBeforeBytes: heap.before,
      heapOpenedBytes: heap.opened,
      heapScrolledBytes: heap.scrolled,
      heapAfterBytes: heap.after,
      activeWorkersAfterClose,
      activeNodeViewsAfterClose,
      activeMediaRequestsAfterClose,
      lifecycleBaseline: lifecycleBaseline ? { ...lifecycleBaseline } : undefined,
      lifecycleSnapshots: lifecycleSnapshots.map((value) => ({ ...value })),
      markdownRenderMatches,
      editorMode: editorMode as "monolithic" | "windowed",
      sectionCount,
      peakMountedSections,
    }),
    dispose: () => observer?.disconnect(),
  };
}
