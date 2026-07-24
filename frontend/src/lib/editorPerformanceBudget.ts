export type EditorPerformanceTarget = "desktop" | "android-low-power";

export interface EditorPerformanceSample {
  inputLatencyMs: number[];
  longTaskMs: number[];
  peakDomNodes: number;
  peakNodeViews: number;
  heapBeforeBytes: number;
  heapOpenedBytes: number;
  heapScrolledBytes: number;
  heapAfterBytes: number;
  activeWorkersAfterClose: number;
  activeNodeViewsAfterClose: number;
  activeMediaRequestsAfterClose: number;
}

export interface EditorPerformanceBudgetResult {
  passed: boolean;
  metrics: { p50: number; p95: number; longestTask: number; heapGrowthBytes: number };
  failures: string[];
}

const TARGETS = {
  desktop: { p50: 16, p95: 50 },
  "android-low-power": { p50: 33, p95: 100 },
} as const;

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNonNegativeArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNonNegative);
}

/** 对浏览器、Electron、Android 采集结果执行确定性签收。 */
export function evaluateEditorPerformanceBudget(
  sample: EditorPerformanceSample,
  target: EditorPerformanceTarget,
): EditorPerformanceBudgetResult {
  const budget = TARGETS[target];
  const failures: string[] = [];
  const numericFields = [
    "peakDomNodes",
    "peakNodeViews",
    "heapBeforeBytes",
    "heapOpenedBytes",
    "heapScrolledBytes",
    "heapAfterBytes",
    "activeWorkersAfterClose",
    "activeNodeViewsAfterClose",
    "activeMediaRequestsAfterClose",
  ] as const;

  const validInputLatency = isFiniteNonNegativeArray(sample.inputLatencyMs);
  const validLongTasks = isFiniteNonNegativeArray(sample.longTaskMs);
  if (!validInputLatency) failures.push("inputLatencyMs is missing or invalid");
  if (!validLongTasks) failures.push("longTaskMs is missing or invalid");
  for (const field of numericFields) {
    if (!isFiniteNonNegative(sample[field])) failures.push(`${field} is missing or invalid`);
  }

  const inputLatencyMs = validInputLatency ? sample.inputLatencyMs : [];
  const longTaskMs = validLongTasks ? sample.longTaskMs : [];
  const p50 = percentile(inputLatencyMs, 0.5);
  const p95 = percentile(inputLatencyMs, 0.95);
  const longestTask = longTaskMs.length ? Math.max(...longTaskMs) : 0;
  const heapBeforeBytes = isFiniteNonNegative(sample.heapBeforeBytes) ? sample.heapBeforeBytes : 0;
  const heapStages = [sample.heapOpenedBytes, sample.heapScrolledBytes, sample.heapAfterBytes]
    .filter(isFiniteNonNegative);
  const heapGrowthBytes = Math.max(0, ...heapStages.map((bytes) => bytes - heapBeforeBytes));
  const heapAllowance = Math.max(64 * 1024 * 1024, heapBeforeBytes * 0.2);

  if (validInputLatency && !sample.inputLatencyMs.length) failures.push("input latency sample is empty");
  if (p50 > budget.p50) failures.push(`input p50 ${p50}ms exceeds ${budget.p50}ms`);
  if (p95 > budget.p95) failures.push(`input p95 ${p95}ms exceeds ${budget.p95}ms`);
  if (longestTask > 200) failures.push(`longest task ${longestTask}ms exceeds 200ms`);
  if (heapGrowthBytes > heapAllowance) failures.push("heap growth exceeds max(64 MiB, 20% of baseline) allowance");
  if (isFiniteNonNegative(sample.activeWorkersAfterClose) && sample.activeWorkersAfterClose > 0) {
    failures.push("workers remain active after note close");
  }
  if (isFiniteNonNegative(sample.activeNodeViewsAfterClose) && sample.activeNodeViewsAfterClose > 0) {
    failures.push("NodeViews remain active after note close");
  }
  if (isFiniteNonNegative(sample.activeMediaRequestsAfterClose) && sample.activeMediaRequestsAfterClose > 0) {
    failures.push("media requests remain active after note close");
  }

  return { passed: failures.length === 0, metrics: { p50, p95, longestTask, heapGrowthBytes }, failures };
}
