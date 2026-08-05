import type { Note } from "@/types";
import { api } from "@/lib/api";
import {
  discardResolvedQueueItems,
  getQueue,
  type OfflineQueueItem,
} from "@/lib/offlineQueue";
import * as draftStorage from "@/lib/draftStorage";
import { clearOfflineNoteSnapshot } from "@/lib/offlineRead";
import { clearNoteSyncConflict } from "@/lib/noteSyncSafety";

export type ConflictResolutionChoice = "keep-local" | "use-server";
export const NOTE_CONFLICT_AUTO_RESOLVED_EVENT = "nowen:note-conflict-auto-resolved";
const DELETE_GUARD_INSTALL_KEY = "__NOWEN_CONFLICT_COPY_DELETE_GUARD_V1__" as const;
const PENDING_STATUS_BRIDGE_INSTALL_KEY = "__NOWEN_PENDING_SYNC_STATUS_BRIDGE_V1__" as const;
const NOTE_SYNC_PENDING_EVENT_NAME = "nowen:note-sync-pending";
const OFFLINE_QUEUED_EVENT_NAME = "nowen:offline-queued";

export interface NoteConflictAutoResolvedDetail {
  note: Note;
  resolvedLocal: {
    title: string;
    content: string;
    contentText: string;
  };
}

export function shouldPersistPendingConflictSnapshot(
  snapshot: { content: string; contentText: string; title?: string },
  currentTitle: string,
  detail: NoteConflictAutoResolvedDetail,
): boolean {
  const snapshotTitle = snapshot.title ?? currentTitle;
  const matchesResolvedLocal = snapshot.content === detail.resolvedLocal.content
    && snapshotTitle === detail.resolvedLocal.title;
  const matchesServer = snapshot.content === detail.note.content
    && snapshotTitle === detail.note.title;
  return !matchesResolvedLocal && !matchesServer;
}

export interface ConflictResolutionResult {
  note: Note;
  conflictCopy?: Note;
  resolvedLocal: NoteConflictAutoResolvedDetail["resolvedLocal"];
}

export interface AutoConflictResolutionResult {
  attempted: number;
  resolved: number;
  failed: number;
  failures: Array<{ noteId: string; message: string }>;
}

type ConflictPayload = {
  title: string;
  content: string;
  contentText: string;
  contentFormat?: Note["contentFormat"];
};

type DraftStorageCompatibility = {
  clearDraft: (noteId: string) => unknown;
  forceClearDraft?: (noteId: string) => void;
};

type ConflictBridgeWindow = Window & typeof globalThis & {
  [DELETE_GUARD_INSTALL_KEY]?: () => void;
  [PENDING_STATUS_BRIDGE_INSTALL_KEY]?: () => void;
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
  const draft = draftStorage.loadDraft(item.noteId);
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

function sameConflictCopyContent(copy: Note, local: ConflictPayload, remote: Note): boolean {
  return copy.content === local.content
    && copy.contentText === local.contentText
    && copy.contentFormat === (local.contentFormat || remote.contentFormat);
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

function clearResolvedConflict(item: OfflineQueueItem): boolean {
  const cleanup = discardResolvedQueueItems(item);
  if (!cleanup.discarded || cleanup.remainingForNote) return false;
  // This is an explicit conflict resolution, not an asynchronous autosave ACK.
  // Production always exposes forceClearDraft. The compatibility view models older
  // Vitest mocks where only clearDraft exists, without weakening production behavior.
  const storage = draftStorage as unknown as DraftStorageCompatibility;
  const clearResolvedDraft = "forceClearDraft" in storage
    && typeof storage.forceClearDraft === "function"
    ? storage.forceClearDraft
    : storage.clearDraft;
  clearResolvedDraft(item.noteId);
  clearNoteSyncConflict(item.noteId);
  clearOfflineNoteSnapshot(item.noteId);
  return true;
}

/**
 * When a user deletes a generated conflict copy, discard the source conflict generation too.
 * Otherwise the next sync pass recreates the same copy and makes deletion appear broken.
 */
export function discardConflictStateForDeletedCopy(copyId: string): string | null {
  const item = getQueue().find(
    (queued) => queued.type === "updateNote"
      && (queued.conflict || queued.errorCode === "VERSION_CONFLICT")
      && getConflictCopyId(queued.id) === copyId,
  );
  if (!item) return null;
  return clearResolvedConflict(item) ? item.noteId : null;
}

/**
 * Conflict copies are ordinary notes in the tree, so the regular trash action is the only reliable
 * place to learn that the user intentionally discarded one. Install an outer API guard after App
 * lazy-load: a confirmed trash write clears the source conflict generation and prevents sync from
 * recreating the same deterministic copy.
 */
export function installConflictCopyDeletionGuard(): void {
  if (typeof window === "undefined" || typeof (api as any).updateNote !== "function") return;
  const guardedWindow = window as ConflictBridgeWindow;
  if (guardedWindow[DELETE_GUARD_INSTALL_KEY]) return;

  const originalUpdateNote = api.updateNote.bind(api);
  (api as any).updateNote = async (noteId: string, data: Partial<Note>): Promise<Note> => {
    const updated = await originalUpdateNote(noteId, data);
    if ((data as Partial<Note>).isTrashed === 1) {
      discardConflictStateForDeletedCopy(noteId);
    }
    return updated;
  };

  guardedWindow[DELETE_GUARD_INSTALL_KEY] = () => {
    (api as any).updateNote = originalUpdateNote;
    delete guardedWindow[DELETE_GUARD_INSTALL_KEY];
  };
}

/**
 * EditorPane historically reports every resolved update Promise as "saved" and resets it to idle
 * two seconds later. Pending conflict/offline responses are deliberately resolved so autosave does
 * not enter its failure/requeue loop, therefore reassert the existing global "queued" UI event
 * after both transitions while the note still has a durable queue item.
 */
export function installPendingSyncStatusBridge(): void {
  if (typeof window === "undefined") return;
  const guardedWindow = window as ConflictBridgeWindow;
  if (guardedWindow[PENDING_STATUS_BRIDGE_INSTALL_KEY]) return;

  const publishQueuedIfPending = (noteId: string) => {
    if (!getQueue().some((item) => item.noteId === noteId)) return;
    window.dispatchEvent(new CustomEvent(OFFLINE_QUEUED_EVENT_NAME, {
      detail: { noteId, pending: true },
    }));
  };
  const onPending = (event: Event) => {
    const noteId = (event as CustomEvent<{ noteId?: string }>).detail?.noteId;
    if (!noteId) return;
    window.setTimeout(() => publishQueuedIfPending(noteId), 0);
    window.setTimeout(() => publishQueuedIfPending(noteId), 2200);
  };

  window.addEventListener(NOTE_SYNC_PENDING_EVENT_NAME, onPending);
  guardedWindow[PENDING_STATUS_BRIDGE_INSTALL_KEY] = () => {
    window.removeEventListener(NOTE_SYNC_PENDING_EVENT_NAME, onPending);
    delete guardedWindow[PENDING_STATUS_BRIDGE_INSTALL_KEY];
  };
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
  if (!clearResolvedConflict(item)) {
    throw new Error("处理期间本地内容已更新，等待下一次后台同步。");
  }
  return { note: updated, resolvedLocal: local };
}

async function updateExistingConflictCopy(
  existing: Note,
  remote: Note,
  local: ConflictPayload,
): Promise<Note> {
  if (sameConflictCopyContent(existing, local, remote)) return existing;
  const updated = await api.updateNoteConfirmed(existing.id, {
    content: local.content,
    contentText: local.contentText,
    contentFormat: local.contentFormat || remote.contentFormat,
    version: existing.version,
  });
  if (typeof updated.version !== "number" || updated.version <= existing.version) {
    throw new Error("冲突副本尚未得到服务器确认，请稍后重试。");
  }
  return updated;
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
    // the id is deterministic for this conflict, load and refresh that same copy with the latest
    // local snapshot instead of creating a second timestamped document.
    const existing = await api.getNote(copyId);
    return updateExistingConflictCopy(existing, remote, local);
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
  if (!clearResolvedConflict(item)) {
    throw new Error("处理期间本地内容已更新，等待下一次后台同步。");
  }
  return { note: remote, conflictCopy, resolvedLocal: local };
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

export async function resolveQueuedNoteConflicts(
  items: ReadonlyArray<OfflineQueueItem>,
): Promise<AutoConflictResolutionResult> {
  const latestByNote = new Map<string, OfflineQueueItem>();
  for (const item of items) {
    if (item.type !== "updateNote" || !(item.conflict || item.errorCode === "VERSION_CONFLICT")) continue;
    const previous = latestByNote.get(item.noteId);
    if (!previous || item.enqueuedAt >= previous.enqueuedAt) latestByNote.set(item.noteId, item);
  }

  const conflicts = [...latestByNote.values()].sort((left, right) => left.enqueuedAt - right.enqueuedAt);
  const failures: AutoConflictResolutionResult["failures"] = [];
  let resolved = 0;

  for (const item of conflicts) {
    try {
      // 服务器当前 revision 作为正式版本；清理冲突前先确认本地副本已经落库。
      const result = await resolveNoteConflict(item, "use-server");
      if (typeof window !== "undefined") {
        const detail: NoteConflictAutoResolvedDetail = {
          note: result.note,
          resolvedLocal: result.resolvedLocal,
        };
        window.dispatchEvent(new CustomEvent(NOTE_CONFLICT_AUTO_RESOLVED_EVENT, {
          detail,
        }));
      }
      resolved += 1;
    } catch (error) {
      failures.push({
        noteId: item.noteId,
        message: error instanceof Error ? error.message : String(error || "自动处理失败"),
      });
    }
  }

  return {
    attempted: conflicts.length,
    resolved,
    failed: failures.length,
    failures,
  };
}

installConflictCopyDeletionGuard();
installPendingSyncStatusBridge();
