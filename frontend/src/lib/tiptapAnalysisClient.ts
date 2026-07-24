import {
  analyzeTiptapDocument,
  type TiptapAnalysisResult,
  type TiptapJsonNode,
} from "@/lib/tiptapAnalysis";

interface WorkerRequest { requestId: number; doc: TiptapJsonNode }
interface WorkerResponse { requestId: number; result?: TiptapAnalysisResult; error?: string }
interface WorkerLike {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage: (message: WorkerRequest) => void;
  terminate: () => void;
}

export interface TiptapAnalysisController {
  analyze: (doc: TiptapJsonNode) => number;
  destroy: () => void;
}

function createDefaultWorker(): WorkerLike | null {
  if (typeof Worker === "undefined") return null;
  return new Worker(new URL("./tiptapAnalysis.worker.ts", import.meta.url), {
    name: "nowen-tiptap-analysis",
  });
}

/** Latest-request-wins worker controller; destruction invalidates every pending result. */
export function createTiptapAnalysisController(options: {
  onResult: (payload: { requestId: number; result: TiptapAnalysisResult }) => void;
  onError?: (error: Error) => void;
  workerFactory?: () => WorkerLike | null;
  fallbackDelayMs?: number;
}): TiptapAnalysisController {
  const workerFactory = options.workerFactory || createDefaultWorker;
  const fallbackDelayMs = options.fallbackDelayMs ?? 32;
  let worker: WorkerLike | null = null;
  let destroyed = false;
  let latestRequestId = 0;
  let latestDoc: TiptapJsonNode = { type: "doc" };
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const clearFallback = () => {
    if (fallbackTimer !== null) globalThis.clearTimeout(fallbackTimer);
    fallbackTimer = null;
  };
  const fallback = (requestId: number, doc: TiptapJsonNode) => {
    clearFallback();
    fallbackTimer = globalThis.setTimeout(() => {
      fallbackTimer = null;
      if (destroyed || requestId !== latestRequestId) return;
      try {
        options.onResult({ requestId, result: analyzeTiptapDocument(doc) });
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }, fallbackDelayMs);
  };

  try {
    worker = workerFactory();
  } catch (error) {
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
  if (worker) {
    worker.onmessage = (event) => {
      if (destroyed || event.data.requestId !== latestRequestId) return;
      if (!event.data.result || event.data.error) {
        options.onError?.(new Error(event.data.error || "Tiptap analysis worker returned no result"));
        fallback(event.data.requestId, latestDoc);
        return;
      }
      options.onResult({ requestId: event.data.requestId, result: event.data.result });
    };
    worker.onerror = (event) => {
      if (destroyed) return;
      options.onError?.(new Error(event.message || "Tiptap analysis worker failed"));
      worker?.terminate();
      worker = null;
      fallback(latestRequestId, latestDoc);
    };
  }

  return {
    analyze(doc) {
      if (destroyed) return latestRequestId;
      const requestId = ++latestRequestId;
      latestDoc = doc;
      clearFallback();
      if (!worker) fallback(requestId, doc);
      else {
        try {
          worker.postMessage({ requestId, doc });
        } catch (error) {
          options.onError?.(error instanceof Error ? error : new Error(String(error)));
          worker.terminate();
          worker = null;
          fallback(requestId, doc);
        }
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
