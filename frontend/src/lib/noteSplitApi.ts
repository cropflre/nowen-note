import type { Note } from "@/types";
import { getBaseUrl } from "@/lib/api.impl";
import type { NoteSplitHeadingLevel } from "@/lib/noteSplit";

export interface SplitNoteResult {
  operationId: string;
  sourceNote: Note;
  createdNotes: Note[];
  headingLevel: NoteSplitHeadingLevel;
  preservePreamble: boolean;
  selectedSectionIndexes: number[];
  retainedSectionCount: number;
  totalSectionCount: number;
  canUndo: boolean;
}

export interface UndoSplitNoteResult {
  sourceNote: Note;
  removedNoteIds: string[];
  operationId: string;
  undone: boolean;
}

export class NoteSplitRequestError extends Error {
  code?: string;
  status?: number;
  currentVersion?: number;
}

async function splitJson<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 60_000);
  const token = localStorage.getItem("nowen-token");
  try {
    const response = await fetch(`${getBaseUrl()}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = new NoteSplitRequestError(
        typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`,
      );
      error.code = typeof payload.code === "string" ? payload.code : undefined;
      error.status = response.status;
      error.currentVersion = typeof payload.currentVersion === "number" ? payload.currentVersion : undefined;
      throw error;
    }
    return payload as T;
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      const timeoutError = new NoteSplitRequestError("拆分操作超时，请检查服务器状态后重试");
      timeoutError.code = "NOTE_SPLIT_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function splitMarkdownNote(
  noteId: string,
  input: {
    version: number;
    headingLevel: NoteSplitHeadingLevel;
    sectionIndexes: number[];
    targetNotebookId?: string | null;
    preservePreamble: boolean;
  },
): Promise<SplitNoteResult> {
  return splitJson<SplitNoteResult>(`/notes/${encodeURIComponent(noteId)}/split`, input);
}

export function undoMarkdownNoteSplit(
  noteId: string,
  operationId: string,
): Promise<UndoSplitNoteResult> {
  return splitJson<UndoSplitNoteResult>(
    `/notes/${encodeURIComponent(noteId)}/split/${encodeURIComponent(operationId)}/undo`,
    {},
  );
}
