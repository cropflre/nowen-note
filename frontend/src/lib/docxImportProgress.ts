import type { DocxArchiveStats } from "@/lib/docxImportSafety";

export type DocxImportStage =
  | "read"
  | "preflight"
  | "parse"
  | "images"
  | "convert"
  | "create"
  | "upload"
  | "save"
  | "verify"
  | "complete";

export interface DocxImportMetrics {
  originalBytes?: number;
  archiveStats?: DocxArchiveStats;
  imageCount?: number;
  uploadedImages?: number;
  htmlChars?: number;
  contentChars?: number;
  contentTextChars?: number;
  parseDurationMs?: number;
  totalDurationMs?: number;
  mammothWarnings?: string[];
}

export interface DocxImportProgressUpdate {
  stage: DocxImportStage;
  percent: number;
  message: string;
  metrics?: Partial<DocxImportMetrics>;
}

export interface DocxImportUiState extends DocxImportProgressUpdate {
  status: "running" | "error" | "success";
  fileName: string;
  fileSize: number;
  metrics: DocxImportMetrics;
  error?: string;
  canRetry: boolean;
}

export interface ManagedDocxImportContext {
  signal: AbortSignal;
  report: (update: DocxImportProgressUpdate) => void;
}

type Listener = (state: DocxImportUiState | null) => void;
type Executor<T> = (context: ManagedDocxImportContext) => Promise<T>;

interface ActiveTask<T = unknown> {
  file: File;
  executor: Executor<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  controller: AbortController | null;
  lastError: Error | null;
  attempt: number;
}

let state: DocxImportUiState | null = null;
let activeTask: ActiveTask | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  const snapshot = state ? { ...state, metrics: { ...state.metrics } } : null;
  listeners.forEach((listener) => listener(snapshot));
}

function setState(next: DocxImportUiState | null): void {
  state = next;
  emit();
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error || "Word 文档导入失败"));
}

function isAbortError(error: unknown): boolean {
  const value = error as { name?: string; code?: string } | null;
  return value?.name === "AbortError" || value?.code === "IMPORT_CANCELLED";
}

function report(update: DocxImportProgressUpdate): void {
  if (!state || state.status !== "running") return;
  setState({
    ...state,
    ...update,
    percent: Math.max(0, Math.min(100, update.percent)),
    metrics: { ...state.metrics, ...(update.metrics || {}) },
  });
}

async function executeActiveTask(): Promise<void> {
  const task = activeTask;
  if (!task) return;
  task.attempt += 1;
  task.lastError = null;
  const controller = new AbortController();
  task.controller = controller;
  setState({
    status: "running",
    fileName: task.file.name,
    fileSize: task.file.size,
    stage: "read",
    percent: 2,
    message: task.attempt > 1 ? `正在重试第 ${task.attempt} 次导入…` : "正在读取 Word 文档…",
    metrics: { originalBytes: task.file.size },
    canRetry: false,
  });

  try {
    const result = await task.executor({ signal: controller.signal, report });
    if (activeTask !== task) return;
    setState({
      ...(state || {
        fileName: task.file.name,
        fileSize: task.file.size,
        metrics: {},
      }),
      status: "success",
      stage: "complete",
      percent: 100,
      message: "Word 文档已安全导入并完成持久化校验",
      error: undefined,
      canRetry: false,
    });
    activeTask = null;
    task.resolve(result);
    window.setTimeout(() => {
      if (state?.status === "success") setState(null);
    }, 900);
  } catch (error) {
    if (activeTask !== task) return;
    const normalized = normalizeError(error);
    task.lastError = normalized;
    task.controller = null;
    const cancelled = isAbortError(error) || controller.signal.aborted;
    setState({
      ...(state || {
        fileName: task.file.name,
        fileSize: task.file.size,
        stage: "read",
        percent: 0,
        message: "",
        metrics: {},
      }),
      status: "error",
      message: cancelled ? "导入已取消，未完成数据已回滚" : "Word 文档导入失败",
      error: cancelled ? "用户取消了导入，可直接重试同一文件或关闭。" : normalized.message,
      canRetry: true,
    });
  }
}

export function subscribeDocxImportProgress(listener: Listener): () => void {
  listeners.add(listener);
  listener(state ? { ...state, metrics: { ...state.metrics } } : null);
  return () => {
    listeners.delete(listener);
  };
}

export function runManagedDocxImport<T>(file: File, executor: Executor<T>): Promise<T> {
  if (activeTask) {
    return Promise.reject(new Error("已有 Word 文档正在导入，请先完成或取消当前任务"));
  }
  return new Promise<T>((resolve, reject) => {
    activeTask = {
      file,
      executor,
      resolve: resolve as (value: unknown) => void,
      reject,
      controller: null,
      lastError: null,
      attempt: 0,
    };
    void executeActiveTask();
  });
}

export function cancelActiveDocxImport(): void {
  activeTask?.controller?.abort();
}

export function retryActiveDocxImport(): void {
  if (!activeTask || state?.status !== "error") return;
  void executeActiveTask();
}

export function dismissActiveDocxImport(): void {
  const task = activeTask;
  if (!task) {
    setState(null);
    return;
  }
  task.controller?.abort();
  activeTask = null;
  setState(null);
  task.reject(task.lastError || Object.assign(new Error("Word 文档导入已取消"), { code: "IMPORT_CANCELLED" }));
}
