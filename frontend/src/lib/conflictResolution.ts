import type { Note } from "@/types";
import { api } from "@/lib/api";
import {
  discardNoteQueueItems,
  type OfflineQueueItem,
} from "@/lib/offlineQueue";
import { clearDraft, loadDraft } from "@/lib/draftStorage";
import { clearOfflineNoteSnapshot } from "@/lib/offlineRead";
import { clearNoteSyncConflict } from "@/lib/noteSyncSafety";

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

/**
 * Generate a stable RFC4122-shaped UUID from the queue item id. If a request reaches the server
 * but the response is lost, a retry addresses the same copy instead of creating duplicates.
 */
export function getConflictCopyId(itemId: string): string {
  const bytes = new Uint8Array(16);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let index = 0; index < itemId.length; index += 1) {
    const code = itemId.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (code + index), 0x85ebca6b) >>> 0;
  }
  for (let index = 0; index < 16; index += 1) {
    h1 = Math.imul(h1 ^ (h1 >>> 13), 0x5bd1e995) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 15), 0x27d4eb2d) >>> 0;
    bytes[index] = ((index % 2 === 0 ? h1 : h2) >>> ((index % 4) * 8)) & 0xff;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
  const updated = await api.updateNoteConfirmed(item.noteId, {
    title: local.title,
    content: local.content,
    contentText: local.contentText,
    contentFormat: local.contentFormat || remote.contentFormat,
    version: remote.version,
  });
  if (typeof updated.version !== "number" || updated.version <= remote.version) {
    throw new Error("服务器尚未确认此设备版本，请保持页面打开后重试。");
  }
  clearResolvedConflict(item.noteId);
  return { note: updated };
}

async function createOrLoadConflictCopy(
  item: OfflineQueueItem,
  remote: Note,
  local: ConflictPayload,
): Promise<Note> {
  const copyId = getConflictCopyId(item.id);
  try {
    return await api.createNoteConfirmed({
      id: copyId,
      notebookId: remote.notebookId,
      workspaceId: remote.workspaceId,
      title: formatConflictCopyTitle(local.title),
      content: local.content,
      contentText: local.contentText,
      contentFormat: local.contentFormat || remote.contentFormat,
    });
  } catch (error) {
    const details = error as { status?: number; code?: string };
    if (details.status !== 409 || details.code !== "NOTE_ID_CONFLICT") throw error;
    // The previous request may have committed successfully while its response was lost. Because
    // the id is deterministic for this conflict, loading it is safe and makes retry idempotent.
    return api.getNote(copyId);
  }
}

async function useServerVersion(
  item: OfflineQueueItem,
  remote: Note,
  local: ConflictPayload,
): Promise<ConflictResolutionResult> {
  let conflictCopy: Note | undefined;
  if (!sameContent(local, remote)) {
    conflictCopy = await createOrLoadConflictCopy(item, remote, local);
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
