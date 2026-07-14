import type { Note } from "@/types";
import { api } from "@/lib/api";
import {
  discardNoteQueueItems,
  type OfflineQueueItem,
} from "@/lib/offlineQueue";
import { clearDraft, loadDraft } from "@/lib/draftStorage";
import { clearOfflineNoteSnapshot } from "@/lib/offlineRead";
import {
  clearNoteSyncConflict,
  runWithNoteConflictResolution,
} from "@/lib/noteSyncSafety";

export type ConflictResolutionChoice = "keep-local" | "use-server";

export interface ConflictResolutionResult {
  note: Note;
  conflictCopy?: Note;
}

type ConflictPayload = {
  title: string;
  content: string;
  contentText: string;
  contentFormat?: Note["contentFormat"];
};

function payloadFromQueue(item: OfflineQueueItem): Partial<ConflictPayload> {
  const payload = item.localPayload || item.body || {};
  return {
    title: typeof payload.title === "string" ? payload.title : undefined,
    content: typeof payload.content === "string" ? payload.content : undefined,
    contentText: typeof payload.contentText === "string" ? payload.contentText : undefined,
    contentFormat: typeof payload.contentFormat === "string"
      ? payload.contentFormat as Note["contentFormat"]
      : undefined,
  };
}

export function getConflictLocalPayload(
  item: OfflineQueueItem,
  remote: Note,
): ConflictPayload {
  const queued = payloadFromQueue(item);
  const draft = loadDraft(item.noteId);
  return {
    title: draft?.title ?? queued.title ?? remote.title,
    content: draft?.content ?? queued.content ?? remote.content,
    contentText: draft?.contentText ?? queued.contentText ?? remote.contentText,
    contentFormat: queued.contentFormat ?? remote.contentFormat,
  };
}

function sameContent(local: ConflictPayload, remote: Note): boolean {
  return local.title === remote.title
    && local.content === remote.content
    && local.contentText === remote.contentText
    && (local.contentFormat || remote.contentFormat) === remote.contentFormat;
}

function formatConflictCopyTitle(title: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `${title || "未命名笔记"}（冲突副本 ${stamp}）`;
}

function clearResolvedConflict(noteId: string): void {
  discardNoteQueueItems([noteId]);
  clearDraft(noteId);
  clearNoteSyncConflict(noteId);
  clearOfflineNoteSnapshot(noteId);
}

async function keepLocalVersion(
  item: OfflineQueueItem,
  remote: Note,
  local: ConflictPayload,
): Promise<ConflictResolutionResult> {
  const updated = await runWithNoteConflictResolution(item.noteId, () => api.updateNote(item.noteId, {
    title: local.title,
    content: local.content,
    contentText: local.contentText,
    contentFormat: local.contentFormat || remote.contentFormat,
    version: remote.version,
  }));
  clearResolvedConflict(item.noteId);
  return { note: updated };
}

async function useServerVersion(
  item: OfflineQueueItem,
  remote: Note,
  local: ConflictPayload,
): Promise<ConflictResolutionResult> {
  let conflictCopy: Note | undefined;
  if (!sameContent(local, remote)) {
    // The local copy must be acknowledged by the server before the conflict marker is removed.
    // If creation fails, every local artifact remains intact and the user can retry safely.
    conflictCopy = await api.createNote({
      notebookId: remote.notebookId,
      workspaceId: remote.workspaceId,
      title: formatConflictCopyTitle(local.title),
      content: local.content,
      contentText: local.contentText,
      contentFormat: local.contentFormat || remote.contentFormat,
    });
  }
  clearResolvedConflict(item.noteId);
  return { note: remote, conflictCopy };
}

export async function resolveNoteConflict(
  item: OfflineQueueItem,
  choice: ConflictResolutionChoice,
): Promise<ConflictResolutionResult> {
  if (!(item.conflict || item.errorCode === "VERSION_CONFLICT")) {
    throw new Error("该项目不是版本冲突，不能使用冲突处理流程。");
  }

  const remote = await api.getNote(item.noteId);
  const local = getConflictLocalPayload(item, remote);

  if (choice === "keep-local") {
    return keepLocalVersion(item, remote, local);
  }
  return useServerVersion(item, remote, local);
}
