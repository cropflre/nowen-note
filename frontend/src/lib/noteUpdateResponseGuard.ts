import type { Note } from "@/types";
import { api } from "@/lib/api";
import { NOTE_SYNC_PENDING_EVENT } from "@/lib/noteSyncSafety";

const INSTALL_KEY = "__NOWEN_NOTE_UPDATE_RESPONSE_GUARD_V1__" as const;

type GuardedWindow = Window & typeof globalThis & {
  [INSTALL_KEY]?: () => void;
};

export function isCompleteNoteUpdateResponse(value: unknown, noteId?: string): value is Note {
  const note = value as Partial<Note> | null;
  return !!note &&
    typeof note.id === "string" && note.id.length > 0 &&
    (!noteId || note.id === noteId) &&
    typeof note.title === "string" &&
    typeof note.content === "string" &&
    typeof note.contentText === "string" &&
    typeof note.version === "number" && Number.isFinite(note.version) &&
    typeof note.updatedAt === "string";
}

function pendingError(noteId: string): Error {
  const error = new Error(
    "修改已进入离线队列，但尚未得到服务端完整确认。当前笔记不会被不完整响应替换。",
  ) as Error & { code?: string; queued?: boolean; noteId?: string };
  error.code = "OFFLINE_WRITE_QUEUED";
  error.queued = true;
  error.noteId = noteId;
  return error;
}

/**
 * api.ts returns a partial optimistic object when a retryable PUT is queued offline.
 * That object is useful as an internal queue acknowledgement but is not a Note detail and
 * must never reach callers that replace activeNote wholesale.
 */
export function installNoteUpdateResponseGuard(): void {
  if (typeof window === "undefined") return;
  const guardedWindow = window as GuardedWindow;
  if (guardedWindow[INSTALL_KEY]) return;

  const originalUpdateNote = api.updateNote.bind(api);
  (api as any).updateNote = async (noteId: string, data: Partial<Note>): Promise<Note> => {
    const result = await originalUpdateNote(noteId, data);
    if (isCompleteNoteUpdateResponse(result, noteId)) return result;

    window.dispatchEvent(new CustomEvent(NOTE_SYNC_PENDING_EVENT, {
      detail: {
        noteId,
        queued: true,
        responseIncomplete: true,
      },
    }));
    throw pendingError(noteId);
  };

  guardedWindow[INSTALL_KEY] = () => {
    (api as any).updateNote = originalUpdateNote;
    delete guardedWindow[INSTALL_KEY];
  };
}
