import { analyzeMarkdown } from "@/lib/markdownAnalysis";

interface MarkdownAnalysisWorkerRequest {
  requestId: number;
  markdown: string;
}

interface MarkdownAnalysisWorkerResponse {
  requestId: number;
  result?: ReturnType<typeof analyzeMarkdown>;
  error?: string;
}

const workerScope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<MarkdownAnalysisWorkerRequest>) => void) | null;
  postMessage: (message: MarkdownAnalysisWorkerResponse) => void;
};

workerScope.onmessage = (event) => {
  const { requestId, markdown } = event.data;
  try {
    workerScope.postMessage({
      requestId,
      result: analyzeMarkdown(markdown),
    });
  } catch (error) {
    workerScope.postMessage({
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
