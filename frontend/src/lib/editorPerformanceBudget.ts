export type EditorPerformanceTarget = "desktop" | "android-low-power";

export interface EditorPerformanceSample {
  inputLatencyMs: number[];
  longTaskMs: number[];
  heapBeforeBytes?: number;
  heapAfterBytes?: number;
  activeWorkersAfterClose?: number;
  activeMediaRequestsAfterClose?: number;
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

/** Deterministic acceptance gate for reports captured by browser/Electron/Android harnesses. */
export function evaluateEditorPerformanceBudget(
  sample: EditorPerformanceSample,
  target: EditorPerformanceTarget,
): EditorPerformanceBudgetResult {
  const budget = TARGETS[target];
  const p50 = percentile(sample.inputLatencyMs, 0.5);
  const p95 = percentile(sample.inputLatencyMs, 0.95);
  const longestTask = sample.longTaskMs.length ? Math.max(...sample.longTaskMs) : 0;
  const heapGrowthBytes = Math.max(0, (sample.heapAfterBytes || 0) - (sample.heapBeforeBytes || 0));
  const heapAllowance = Math.max(64 * 1024 * 1024, (sample.heapBeforeBytes || 0) * 0.2);
  const failures: string[] = [];

  if (!sample.inputLatencyMs.length) failures.push("input latency sample is empty");
  if (p50 > budget.p50) failures.push(`input p50 ${p50}ms exceeds ${budget.p50}ms`);
  if (p95 > budget.p95) failures.push(`input p95 ${p95}ms exceeds ${budget.p95}ms`);
  if (longestTask > 200) failures.push(`longest task ${longestTask}ms exceeds 200ms`);
  if (heapGrowthBytes > heapAllowance) failures.push("heap growth exceeds 20% or 64 MiB allowance");
  if ((sample.activeWorkersAfterClose || 0) > 0) failures.push("workers remain active after note close");
  if ((sample.activeMediaRequestsAfterClose || 0) > 0) failures.push("media requests remain active after note close");

  return { passed: failures.length === 0, metrics: { p50, p95, longestTask, heapGrowthBytes }, failures };
}
