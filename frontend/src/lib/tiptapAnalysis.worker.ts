import { analyzeTiptapDocument, type TiptapJsonNode } from "@/lib/tiptapAnalysis";

interface Request { requestId: number; doc: TiptapJsonNode }
interface Response {
  requestId: number;
  result?: ReturnType<typeof analyzeTiptapDocument>;
  error?: string;
}

const workerScope = globalThis as typeof globalThis & {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Response) => void;
};

workerScope.onmessage = (event) => {
  try {
    workerScope.postMessage({
      requestId: event.data.requestId,
      result: analyzeTiptapDocument(event.data.doc),
    });
  } catch (error) {
    workerScope.postMessage({
      requestId: event.data.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
