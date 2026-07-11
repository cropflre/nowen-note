import { getBaseUrl, getCurrentWorkspace } from "@/lib/api";

export type ReliableAskMode = "knowledge" | "current-note" | "selection";

export interface ReliableReference {
  id: string;
  title: string;
  kind?: "note" | "attachment";
  attachmentId?: string;
  attachmentFilename?: string;
  chunkIndex?: number;
  distance?: number;
  score?: number;
  rankReason?: string;
}

export interface ReliableDiagnostics {
  version: number;
  requestId: string;
  generatedAt: string;
  provider: string | null;
  model: string | null;
  apiHost: string | null;
  embeddingModel: string | null;
  mode: ReliableAskMode;
  scope: {
    workspaceId: string | null;
    notebookId: string | null;
    includeChildren: boolean;
    resolvedNotebookCount: number | null;
    currentNoteId: string | null;
  };
  retrieval: string[];
  context: {
    budgetChars: number;
    originalChars: number;
    includedChars: number;
    omittedChars: number;
    truncated: boolean;
    strategy: string;
    segments: Array<{ label: string; start: number; end: number }>;
  };
  index: ReliableStatus["index"];
  hits: Array<{
    id: string;
    noteId: string;
    title: string;
    kind: "note" | "attachment";
    attachmentId?: string | null;
    chunkIndex?: number;
    distance?: number;
    score?: number;
    rankReason: string;
    indexedAt?: string | null;
    preview: string;
    contextChars: number;
    truncated: boolean;
  }>;
  redacted: string[];
}

export interface ReliableStatus {
  enabled: boolean;
  provider: string | null;
  model: string | null;
  apiHost: string | null;
  embeddingModel: string | null;
  scope: {
    workspaceId: string | null;
    notebookCount: number | null;
  };
  index: {
    lastIndexedAt: string | null;
    newestSourceUpdatedAt: string | null;
    pending: number;
    processing: number;
    failed: number;
    totalNotes: number;
    indexedNotes: number;
    totalAttachments: number;
    indexedAttachments: number;
    configured: boolean;
    vectorAvailable: boolean;
    vectorDimension: number | null;
    stale: boolean;
  };
}

export interface ReliableAskParams {
  question: string;
  history?: Array<{ role: string; content: string }>;
  mode: ReliableAskMode;
  currentNoteId?: string;
  selectedText?: string;
  notebookId?: string;
  includeChildren?: boolean;
}

function authHeaders(json = false): HeadersInit {
  const token = localStorage.getItem("nowen-token") || "";
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function scopedPath(path: string): string {
  const workspace = getCurrentWorkspace();
  const query = workspace && workspace !== "personal"
    ? `?workspaceId=${encodeURIComponent(workspace)}`
    : "";
  return `${getBaseUrl()}/user-preferences/ai-reliable${path}${query}`;
}

async function parseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => ({}));
  const error = new Error(body?.error || `请求失败: ${response.status}`) as Error & {
    code?: string;
    status?: number;
  };
  error.code = body?.code;
  error.status = response.status;
  return error;
}

export async function getReliableAIStatus(): Promise<ReliableStatus> {
  const response = await fetch(scopedPath("/status"), {
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

export async function setReliableAIEnabled(enabled: boolean): Promise<ReliableStatus> {
  const response = await fetch(scopedPath("/config-enabled"), {
    method: "PUT",
    headers: authHeaders(true),
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw await parseError(response);
  return response.json();
}

interface ParsedEvent {
  event: string;
  data: string;
}

function parseEventBlock(block: string): ParsedEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim() || "message";
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

function consumeSSE(buffer: string, flush = false): { events: ParsedEvent[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = flush ? "" : parts.pop() || "";
  const complete = flush ? parts.filter(Boolean).concat(rest ? [rest] : []) : parts;
  return {
    events: complete.map(parseEventBlock).filter((value): value is ParsedEvent => !!value),
    rest,
  };
}

function messageText(data: string): string {
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.t === "string") return parsed.t;
    if (typeof parsed?.content === "string") return parsed.content;
  } catch {
    return data;
  }
  return "";
}

export async function reliableAsk(
  params: ReliableAskParams,
  callbacks: {
    onChunk?: (chunk: string) => void;
    onReferences?: (references: ReliableReference[]) => void;
    onDiagnostics?: (diagnostics: ReliableDiagnostics) => void;
  } = {},
): Promise<string> {
  const response = await fetch(scopedPath("/ask"), {
    method: "POST",
    headers: authHeaders(true),
    body: JSON.stringify(params),
  });
  if (!response.ok) throw await parseError(response);

  let output = "";
  const dispatch = (item: ParsedEvent): boolean => {
    if (item.event === "done" || item.data === "[DONE]") return true;
    if (item.event === "references") {
      try { callbacks.onReferences?.(JSON.parse(item.data)); } catch { /* malformed diagnostics must not break chat */ }
      return false;
    }
    if (item.event === "diagnostics") {
      try { callbacks.onDiagnostics?.(JSON.parse(item.data)); } catch { /* ignore */ }
      return false;
    }
    if (item.event === "error") throw new Error(item.data || "AI 请求失败");
    const text = messageText(item.data);
    if (text) {
      output += text;
      callbacks.onChunk?.(text);
    }
    return false;
  };

  if (!response.body || typeof response.body.getReader !== "function") {
    const parsed = consumeSSE(await response.text(), true);
    for (const item of parsed.events) {
      if (dispatch(item)) break;
    }
    return output;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  while (!finished) {
    const result = await reader.read();
    if (result.value) buffer += decoder.decode(result.value, { stream: !result.done });
    const parsed = consumeSSE(buffer, !!result.done);
    buffer = parsed.rest;
    for (const item of parsed.events) {
      if (dispatch(item)) {
        finished = true;
        break;
      }
    }
    if (result.done) break;
  }
  return output;
}

export function exportDiagnosticsFile(diagnostics: ReliableDiagnostics): void {
  const safe = JSON.stringify(diagnostics, null, 2);
  const blob = new Blob([safe], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `nowen-ai-diagnostics-${diagnostics.requestId}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
