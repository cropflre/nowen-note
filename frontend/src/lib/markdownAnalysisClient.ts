import {
  analyzeMarkdown,
  type MarkdownAnalysisResult,
} from "@/lib/markdownAnalysis";

interface WorkerLike {
  onmessage: ((event: MessageEvent<MarkdownAnalysisWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (message: MarkdownAnalysisWorkerRequest) => void;
  terminate: () => void;
}

interface MarkdownAnalysisWorkerRequest {
  requestId: number;
  markdown: string;
}

interface MarkdownAnalysisWorkerResponse {
  requestId: number;
  result?: MarkdownAnalysisResult;
  error?: string;
}

export interface MarkdownAnalysisControllerOptions {
  onResult: (payload: { requestId: number; result: MarkdownAnalysisResult }) => void;
  onError?: (error: Error) => void;
  workerFactory?: () => WorkerLike | null;
  fallbackDelayMs?: number;
}

export interface MarkdownAnalysisController {
  analyze: (markdown: string) => number;
  destroy: () => void;
}

function createDefaultWorker(): WorkerLike | null {
  if (typeof Worker === "undefined") return null;
  // Vite bundles this URL as a classic worker by default. Avoid `type: module` so the optimized
  // path also works in the older Chromium/WebView versions supported by the desktop/mobile apps.
  return new Worker(
    new URL("./markdownAnalysis.worker.ts", import.meta.url),
    { name: "nowen-markdown-analysis" },
  );
}

/**
 * Latest-request-wins controller for Markdown analysis.
 *
 * Worker responses may arrive out of order after rapid typing or note switching. Only the newest
 * request is published. If Worker construction/execution fails, the same analysis runs from a
 * delayed fallback task so editing and saving remain functional.
 */
export function createMarkdownAnalysisController({
  onResult,
  onError,
  workerFactory = createDefaultWorker,
  fallbackDelayMs = 32,
}: MarkdownAnalysisControllerOptions): MarkdownAnalysisController {
  let worker: WorkerLike | null = null;
  let destroyed = false;
  let latestRequestId = 0;
  let latestMarkdown = "";
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFallback = () => {
    if (fallbackTimer !== null) {
      globalThis.clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const runFallback = (requestId: number, markdown: string) => {
    clearFallback();
    fallbackTimer = globalThis.setTimeout(() => {
      fallbackTimer = null;
      if (destroyed || requestId !== latestRequestId) return;
      try {
        onResult({ requestId, result: analyzeMarkdown(markdown) });
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }, fallbackDelayMs);
  };

  try {
    worker = workerFactory();
  } catch (error) {
    onError?.(error instanceof Error ? error : new Error(String(error)));
    worker = null;
  }

  if (worker) {
    worker.onmessage = (event) => {
      if (destroyed || event.data.requestId !== latestRequestId) return;
      if (event.data.error || !event.data.result) {
        const error = new Error(event.data.error || "Markdown analysis worker returned no result");
        onError?.(error);
        runFallback(event.data.requestId, latestMarkdown);
        return;
      }
      onResult({ requestId: event.data.requestId, result: event.data.result });
    };
    worker.onerror = (event) => {
      if (destroyed) return;
      onError?.(new Error(event.message || "Markdown analysis worker failed"));
      worker?.terminate();
      worker = null;
      runFallback(latestRequestId, latestMarkdown);
    };
  }

  return {
    analyze(markdown) {
      if (destroyed) return latestRequestId;
      const requestId = ++latestRequestId;
      latestMarkdown = markdown;
      clearFallback();

      if (!worker) {
        runFallback(requestId, markdown);
        return requestId;
      }

      try {
        worker.postMessage({ requestId, markdown });
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error(String(error)));
        worker.terminate();
        worker = null;
        runFallback(requestId, markdown);
      }
      return requestId;
    },
    destroy() {
      destroyed = true;
      clearFallback();
      worker?.terminate();
      worker = null;
    },
  };
}
