import {
  createEditorPerformanceCollector,
  EDITOR_PERFORMANCE_PLATFORMS,
  EDITOR_PERFORMANCE_SCENARIOS,
  type EditorPerformanceLifecycleSnapshot,
  type EditorPerformancePlatform,
  type EditorPerformanceRun,
  type EditorPerformanceScenario,
} from "@/lib/editorPerformanceProtocol";

export interface EditorPerformanceMemoryMetrics {
  heapBytes: number;
}

export interface EditorPerformanceMemoryAdapter {
  getMemoryMetrics(): Promise<EditorPerformanceMemoryMetrics>;
}

export interface EditorPerformanceHarnessDriver {
  openScenario(scenario: EditorPerformanceScenario): Promise<void>;
  waitUntilInteractive(): Promise<void>;
  performInput(index: number): Promise<void>;
  scrollToEnd(): Promise<void>;
  switchNote?(index: number): Promise<void>;
  closeScenario(): Promise<void>;
  readDomNodeCount(): Promise<number>;
  readNodeViewCount(): Promise<number>;
  readLifecycleSnapshot(): Promise<EditorPerformanceLifecycleSnapshot>;
  readMarkdownRenderMatches?(): Promise<boolean>;
}

export interface EditorPerformanceHarnessRequest {
  platform: EditorPerformancePlatform;
  scenario: EditorPerformanceScenario;
  driver: EditorPerformanceHarnessDriver;
  memoryAdapter?: EditorPerformanceMemoryAdapter;
  inputSampleCount?: number;
  clock?: () => number;
}

interface EditorPerformancePlatformTarget {
  performance?: { memory?: { usedJSHeapSize?: number } };
  nowenDesktop?: {
    getEditorPerformanceMetrics?: () => Promise<EditorPerformanceMemoryMetrics>;
  };
  Capacitor?: {
    Plugins?: {
      EditorPerformance?: {
        getMemoryMetrics?: () => Promise<EditorPerformanceMemoryMetrics>;
      };
    };
  };
}

export interface EditorPerformanceGlobalTarget {
  __NOWEN_EDITOR_PERF__?: EditorPerformanceGlobalEntry;
}

export type EditorPerformanceGlobalEntry = (
  request: EditorPerformanceHarnessRequest,
) => Promise<EditorPerformanceRun>;

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function requireDriverMethod(
  driver: EditorPerformanceHarnessDriver,
  method: keyof EditorPerformanceHarnessDriver,
): void {
  if (typeof driver?.[method] !== "function") throw new Error(`driver.${method} is required`);
}

function validateLifecycleSnapshot(value: unknown): EditorPerformanceLifecycleSnapshot {
  if (!value || typeof value !== "object") throw new Error("lifecycle snapshot is missing or invalid");
  const snapshot = value as Partial<EditorPerformanceLifecycleSnapshot>;
  if (!isFiniteNonNegative(snapshot.workers)
      || !isFiniteNonNegative(snapshot.nodeViews)
      || !isFiniteNonNegative(snapshot.mediaRequests)) {
    throw new Error("lifecycle snapshot is missing or invalid");
  }
  return {
    workers: snapshot.workers,
    nodeViews: snapshot.nodeViews,
    mediaRequests: snapshot.mediaRequests,
  };
}

function validateRequest(request: EditorPerformanceHarnessRequest): number {
  if (!EDITOR_PERFORMANCE_PLATFORMS.includes(request.platform)) throw new Error("platform is missing or invalid");
  if (!EDITOR_PERFORMANCE_SCENARIOS.includes(request.scenario)) throw new Error("scenario is missing or invalid");
  const inputSampleCount = request.inputSampleCount ?? 20;
  if (!Number.isInteger(inputSampleCount) || inputSampleCount <= 0) {
    throw new Error("inputSampleCount must be a positive integer");
  }
  for (const method of [
    "openScenario",
    "waitUntilInteractive",
    "performInput",
    "scrollToEnd",
    "closeScenario",
    "readDomNodeCount",
    "readNodeViewCount",
    "readLifecycleSnapshot",
  ] as const) {
    requireDriverMethod(request.driver, method);
  }
  if (request.scenario === "switch-20-and-close") requireDriverMethod(request.driver, "switchNote");
  if (request.scenario === "markdown-2.4mb") requireDriverMethod(request.driver, "readMarkdownRenderMatches");
  return inputSampleCount;
}

function defaultPlatformTarget(): EditorPerformancePlatformTarget {
  if (typeof window !== "undefined") return window as unknown as EditorPerformancePlatformTarget;
  return globalThis as unknown as EditorPerformancePlatformTarget;
}

/** 解析各平台的四阶段 heap 指标来源；桥接未实现时明确失败。 */
export function createEditorPerformancePlatformAdapter(
  platform: EditorPerformancePlatform,
  target: EditorPerformancePlatformTarget = defaultPlatformTarget(),
): EditorPerformanceMemoryAdapter {
  if (platform === "web") {
    return {
      async getMemoryMetrics() {
        const heapBytes = target.performance?.memory?.usedJSHeapSize;
        if (!isFiniteNonNegative(heapBytes)) {
          throw new Error("performance.memory.usedJSHeapSize is unavailable");
        }
        return { heapBytes };
      },
    };
  }
  if (platform === "electron") {
    return {
      async getMemoryMetrics() {
        const getMetrics = target.nowenDesktop?.getEditorPerformanceMetrics;
        if (typeof getMetrics !== "function") {
          throw new Error("nowenDesktop.getEditorPerformanceMetrics is unavailable");
        }
        return getMetrics.call(target.nowenDesktop);
      },
    };
  }
  return {
    async getMemoryMetrics() {
      const plugin = target.Capacitor?.Plugins?.EditorPerformance;
      if (typeof plugin?.getMemoryMetrics !== "function") {
        throw new Error("Capacitor.Plugins.EditorPerformance.getMemoryMetrics is unavailable");
      }
      return plugin.getMemoryMetrics.call(plugin);
    },
  };
}

/** 实际编排一个性能场景；任何能力或指标缺失都会拒绝本次采集。 */
export async function runEditorPerformanceScenario(
  request: EditorPerformanceHarnessRequest,
): Promise<EditorPerformanceRun> {
  const inputSampleCount = validateRequest(request);
  const memoryAdapter = request.memoryAdapter || createEditorPerformancePlatformAdapter(request.platform);
  if (typeof memoryAdapter.getMemoryMetrics !== "function") {
    throw new Error("memoryAdapter.getMemoryMetrics is required");
  }
  const rawClock = request.clock || (() => performance.now());
  let lastClock = Number.NEGATIVE_INFINITY;
  const clock = () => {
    const value = rawClock();
    if (!Number.isFinite(value) || value < lastClock) throw new Error("clock must be finite and monotonic");
    lastClock = value;
    return value;
  };
  const collector = createEditorPerformanceCollector(request.platform, request.scenario, clock);
  const readHeap = async () => {
    const metrics = await memoryAdapter.getMemoryMetrics();
    if (!isFiniteNonNegative(metrics?.heapBytes)) throw new Error("heapBytes is missing or invalid");
    return metrics.heapBytes;
  };
  const readPeaks = async () => {
    const [domNodes, nodeViews] = await Promise.all([
      request.driver.readDomNodeCount(),
      request.driver.readNodeViewCount(),
    ]);
    if (!isFiniteNonNegative(domNodes)) throw new Error("DOM node count is missing or invalid");
    if (!isFiniteNonNegative(nodeViews)) throw new Error("NodeView count is missing or invalid");
    collector.recordDomNodes(domNodes);
    collector.recordNodeViews(nodeViews);
  };
  let scenarioOpened = false;
  let closeAttempted = false;
  const closeOnce = async () => {
    if (!scenarioOpened || closeAttempted) return;
    closeAttempted = true;
    await request.driver.closeScenario();
  };

  try {
    if (collector.finish().longTaskObservationSupported !== true) {
      throw new Error("Long Task observation is unavailable");
    }
    collector.recordHeap("before", await readHeap());
    const interactiveStarted = clock();
    await request.driver.openScenario(request.scenario);
    scenarioOpened = true;
    await request.driver.waitUntilInteractive();
    collector.recordFirstInteractive(clock() - interactiveStarted);
    collector.recordHeap("opened", await readHeap());
    await readPeaks();

    for (let index = 0; index < inputSampleCount; index += 1) {
      const finishInput = collector.inputStarted();
      await request.driver.performInput(index);
      finishInput();
      await readPeaks();
    }

    await request.driver.scrollToEnd();
    collector.recordHeap("scrolled", await readHeap());
    await readPeaks();

    if (request.scenario === "switch-20-and-close") {
      const baseline = validateLifecycleSnapshot(await request.driver.readLifecycleSnapshot());
      collector.recordLifecycleBaseline(baseline.workers, baseline.nodeViews, baseline.mediaRequests);
      for (let index = 0; index < 20; index += 1) {
        const finishSwitch = collector.noteSwitchStarted();
        await request.driver.switchNote!(index);
        finishSwitch();
        const snapshot = validateLifecycleSnapshot(await request.driver.readLifecycleSnapshot());
        collector.recordSwitchLifecycle(snapshot.workers, snapshot.nodeViews, snapshot.mediaRequests);
        await readPeaks();
      }
    }

    let markdownRenderMatches: boolean | undefined;
    if (request.scenario === "markdown-2.4mb") {
      markdownRenderMatches = await request.driver.readMarkdownRenderMatches!();
      if (typeof markdownRenderMatches !== "boolean") {
        throw new Error("markdown render match result is missing or invalid");
      }
    }

    await closeOnce();
    collector.recordHeap("after", await readHeap());
    const afterClose = validateLifecycleSnapshot(await request.driver.readLifecycleSnapshot());
    collector.recordLifecycle(afterClose.workers, afterClose.nodeViews, afterClose.mediaRequests);
    return collector.finish(markdownRenderMatches);
  } catch (error) {
    try {
      await closeOnce();
    } catch {
      // 清理失败不能覆盖最初的采集错误。
    }
    throw error;
  } finally {
    collector.dispose();
  }
}

/** 只安装显式调用入口，不会自动打开笔记或启动性能场景。 */
export function installEditorPerformanceGlobal(
  target: EditorPerformanceGlobalTarget = window as unknown as EditorPerformanceGlobalTarget,
): EditorPerformanceGlobalEntry {
  const entry: EditorPerformanceGlobalEntry = (request) => runEditorPerformanceScenario(request);
  target.__NOWEN_EDITOR_PERF__ = entry;
  return entry;
}
