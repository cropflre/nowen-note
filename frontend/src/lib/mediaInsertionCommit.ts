import { emitMediaUploadLifecycle } from "@/lib/mediaUploadLifecycle";

export interface MediaInsertionResult {
  attachmentId: string;
  url: string;
  previewUrl?: string;
  filename?: string;
}

type PendingCommit = {
  noteId: string;
  file: File | Blob;
  filename: string;
  result: MediaInsertionResult;
  timer: number;
  onSuccess?: () => void;
  onFailure?: () => void;
};

const pendingCommits = new Map<string, PendingCommit>();
const SAVE_CONFIRM_TIMEOUT_MS = 30_000;

function attachmentIdFromUrl(url: string): string {
  try {
    const pathname = new URL(url, "http://localhost/").pathname;
    return pathname.match(/\/attachments\/([^/]+)$/)?.[1] || "";
  } catch {
    return "";
  }
}

function matchesVideoNode(node: unknown, attachmentId: string): boolean {
  if (!node || typeof node !== "object") return false;
  const value = node as { type?: unknown; attrs?: Record<string, unknown>; content?: unknown };
  if (value.type === "video" && value.attrs?.kind === "file") {
    if (value.attrs.attachmentId === attachmentId) return true;
    if (typeof value.attrs.src === "string" && attachmentIdFromUrl(value.attrs.src) === attachmentId) return true;
  }
  return Array.isArray(value.content) && value.content.some((child) => matchesVideoNode(child, attachmentId));
}

/** Inspect the content accepted by the note save path, never another editor's DOM. */
export function hasCommittedMediaInsertion(result: MediaInsertionResult, content: string): boolean {
  const attachmentId = result.attachmentId || attachmentIdFromUrl(result.url);
  if (!attachmentId || !content) return false;
  if (content.trimStart().startsWith("{")) {
    try {
      return matchesVideoNode(JSON.parse(content), attachmentId);
    } catch {
      // A Markdown note can also begin with a literal `{`.
    }
  }
  const videoReferences = content.matchAll(/@\[video\]\(([^\s)]+)/g);
  for (const match of videoReferences) {
    if (attachmentIdFromUrl(match[1]) === attachmentId) return true;
  }
  return false;
}

function keyFor(noteId: string, result: MediaInsertionResult): string {
  return `${noteId}\u0000${result.attachmentId || result.url}`;
}

function clearPending(key: string): PendingCommit | undefined {
  const pending = pendingCommits.get(key);
  if (pending) window.clearTimeout(pending.timer);
  pendingCommits.delete(key);
  return pending;
}

/** Called only after the target note's content write succeeds or is durably queued offline. */
export function confirmMediaNotePersistence(noteId: string, content: string, disposition: "saved" | "queued" = "saved"): void {
  if (typeof window === "undefined") return;
  for (const [key, pending] of pendingCommits) {
    if (pending.noteId !== noteId || !hasCommittedMediaInsertion(pending.result, content)) continue;
    clearPending(key);
    pending.onSuccess?.();
    emitMediaUploadLifecycle({
      phase: "success",
      file: pending.file,
      filename: pending.filename,
      mediaType: "video",
      noteId,
      result: pending.result,
      queued: disposition === "queued",
    });
  }
}

/** An uploaded file is not a completed editor operation until its note write is acknowledged. */
export function scheduleMediaInsertionCommit(options: {
  noteId: string;
  file: File | Blob;
  filename: string;
  result: MediaInsertionResult;
  onSuccess?: () => void;
  onFailure?: () => void;
}): void {
  if (typeof window === "undefined") return;
  const key = keyFor(options.noteId, options.result);
  clearPending(key);
  const timer = window.setTimeout(() => {
    const pending = clearPending(key);
    if (!pending) return;
    pending.onFailure?.();
    emitMediaUploadLifecycle({
      phase: "error",
      file: pending.file,
      filename: pending.filename,
      mediaType: "video",
      noteId: pending.noteId,
      result: pending.result,
      error: "视频已上传，但正文插入或保存确认失败。点击“重试失败项”会复用已上传文件重新插入，也可从附件库手动插入。",
    });
  }, SAVE_CONFIRM_TIMEOUT_MS);
  pendingCommits.set(key, { ...options, timer });
}
