import type { Note } from "@/types";
import { api } from "@/lib/api";
import {
  clearOfflineNoteSnapshot,
  fingerprintNoteContent,
  getOfflineNoteSnapshot,
  isCurrentlyOffline,
  isOfflineNoteSnapshot,
  markOfflineNoteSnapshot,
} from "@/lib/offlineRead";
import { dequeue, enqueue, getQueue, updateItem } from "@/lib/offlineQueue";
import { saveDraft } from "@/lib/draftStorage";

const INSTALL_KEY = "__NOWEN_NOTE_SYNC_SAFETY_V1__" as const;
const CONFLICT_STORAGE_KEY = "nowen-note-sync-conflicts:v1";
const MAX_CONFLICTS = 20;
const MAX_SNAPSHOT_CHARS = 500_000;
const resolvingNoteIds = new Set<string>();
const confirmedNotes = new Map<string, Note>();

export const NOTE_SYNC_PENDING_EVENT = "nowen:note-sync-pending";

export interface NoteSyncConflictRecord {
  noteId: string;
  baseVersion: number;
  serverVersion?: number;
  serverUpdatedAt?: string;
  localTitle?: string;
  localContent?: string;
  localContentText?: string;
  serverTitle?: string;
  serverContent?: string;
  serverContentText?: string;
  createdAt: number;
  reason: "STALE_OFFLINE_BASE" | "VERSION_CONFLICT" | "REMOTE_BASE_UNVERIFIED";
}

type GuardedWindow = Window & typeof globalThis & { [INSTALL_KEY]?: () => void };
type NoteMutation = Partial<Note> & Record<string, unknown>;
type PendingNote = Note & { __syncPending: true };

export function isVersionedNoteMutation(data: NoteMutation): boolean {
  return ["title", "content", "contentText", "contentFormat"].some((field) => data[field] !== undefined);
}

export function isServerConfirmedNoteWrite(baseVersion: number, responseVersion: unknown): boolean {
  return typeof responseVersion === "number" && Number.isFinite(responseVersion) && responseVersion > baseVersion;
}

function isCompleteNote(value: unknown, noteId?: string): value is Note {
  const note = value as Partial<Note> | null;
  return !!note
    && typeof note.id === "string" && note.id.length > 0
    && (!noteId || note.id === noteId)
    && typeof note.userId === "string" && note.userId.length > 0
    && typeof note.notebookId === "string" && note.notebookId.length > 0
    && typeof note.title === "string"
    && typeof note.content === "string"
    && typeof note.contentText === "string"
    && typeof note.version === "number" && Number.isFinite(note.version)
    && typeof note.createdAt === "string" && note.createdAt.length > 0
    && typeof note.updatedAt === "string" && note.updatedAt.length > 0;
}

function rememberConfirmedNote(note: unknown, noteId?: string): note is Note {
  if (!isCompleteNote(note, noteId)) return false;
  confirmedNotes.set(note.id, note);
  return true;
}

function noteBodiesEqual(left: Partial<Note>, right: Partial<Note>): boolean {
  return left.title === right.title
    && left.content === right.content
    && left.contentText === right.contentText
    && left.contentFormat === right.contentFormat;
}

function mutationMatchesNote(note: Partial<Note>, data: NoteMutation): boolean {
  const fields = ["title", "content", "contentText", "contentFormat"] as const;
  return fields.every((field) => data[field] === undefined || note[field] === data[field]);
}

function makePendingNote(server: Note, data: NoteMutation): PendingNote {
  return {
    ...server,
    ...(typeof data.title === "string" ? { title: data.title } : {}),
    ...(typeof data.content === "string" ? { content: data.content } : {}),
    ...(typeof data.contentText === "string" ? { contentText: data.contentText } : {}),
    ...(data.contentFormat !== undefined ? { contentFormat: data.contentFormat } : {}),
    version: server.version,
    __syncPending: true,
  } as PendingNote;
}

function trimSnapshot(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= MAX_SNAPSHOT_CHARS
    ? value
    : `${value.slice(0, MAX_SNAPSHOT_CHARS)}\n\n[Snapshot truncated locally]`;
}

function readConflictRecords(): NoteSyncConflictRecord[] {
  try {
    const raw = localStorage.getItem(CONFLICT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function conflictSignature(record: NoteSyncConflictRecord): string {
  return JSON.stringify([
    record.noteId,
    record.baseVersion,
    record.serverVersion ?? null,
    record.localTitle ?? "",
    record.localContent ?? "",
    record.localContentText ?? "",
    record.reason,
  ]);
}

export function listNoteSyncConflicts(): NoteSyncConflictRecord[] {
  return readConflictRecords();
}

export function getNoteSyncConflict(noteId: string): NoteSyncConflictRecord | null {
  return readConflictRecords().find((record) => record.noteId === noteId) || null;
}

export function clearNoteSyncConflict(noteId: string): void {
  try {
    const next = readConflictRecords().filter((record) => record.noteId !== noteId);
    if (next.length === 0) localStorage.removeItem(CONFLICT_STORAGE_KEY);
    else localStorage.setItem(CONFLICT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Queue and draft remain the durable fallback.
  }
}

export function recordNoteSyncConflict(record: NoteSyncConflictRecord): boolean {
  const previous = getNoteSyncConflict(record.noteId);
  const changed = !previous || conflictSignature(previous) !== conflictSignature(record);
  try {
    const records = readConflictRecords().filter((item) => item.noteId !== record.noteId);
    records.unshift(record);
    localStorage.setItem(CONFLICT_STORAGE_KEY, JSON.stringify(records.slice(0, MAX_CONFLICTS)));
  } catch {
    // Queue and draft still contain the complete local edit.
  }
  return changed;
}

function persistLocalDraft(
  noteId: string,
  data: NoteMutation,
  baseVersion: number,
  conflict?: { serverVersion?: number },
): void {
  if (typeof data.content !== "string") return;
  saveDraft({
    noteId,
    editorMode: data.contentFormat === "markdown" ? "md" : "tiptap",
    content: data.content,
    contentText: typeof data.contentText === "string" ? data.contentText : "",
    title: typeof data.title === "string" ? data.title : "",
    baseVersion,
    savedAt: Date.now(),
    conflicted: conflict ? true : undefined,
    serverVersion: conflict?.serverVersion,
  });
}

function syncError(code: string, message: string, status?: number): Error {
  const error = new Error(message) as Error & {
    code?: string;
    status?: number;
    queued?: boolean;
    currentVersion?: number;
  };
  error.code = code;
  if (status !== undefined) error.status = status;
  return error;
}

function buildConflictRecord(
  noteId: string,
  data: NoteMutation,
  baseVersion: number,
  server: Partial<Note> | null,
  reason: NoteSyncConflictRecord["reason"],
): NoteSyncConflictRecord {
  return {
    noteId,
    baseVersion,
    serverVersion: typeof server?.version === "number" ? server.version : undefined,
    serverUpdatedAt: server?.updatedAt,
    localTitle: typeof data.title === "string" ? data.title : undefined,
    localContent: trimSnapshot(data.content),
    localContentText: trimSnapshot(data.contentText),
    serverTitle: server?.title,
    serverContent: trimSnapshot(server?.content),
    serverContentText: trimSnapshot(server?.contentText),
    createdAt: Date.now(),
    reason,
  };
}

function isConflictQueueItem(item: { conflict?: boolean; errorCode?: string }): boolean {
  return item.conflict === true || item.errorCode === "VERSION_CONFLICT";
}

function upsertConflictQueueItem(noteId: string, data: NoteMutation, serverVersion?: number): void {
  const body = { ...data } as Record<string, unknown>;
  const candidates = getQueue().filter((item) => item.noteId === noteId && item.type === "updateNote");
  const existing = candidates.find(isConflictQueueItem) || candidates[0];
  const patch = {
    body,
    localPayload: body,
    conflict: true,
    blocked: true,
    retryable: false,
    errorCode: "VERSION_CONFLICT",
    serverVersion,
    failedAt: Date.now(),
    lastAttemptAt: Date.now(),
    lastHttpStatus: 409,
    message: "版本冲突：本地内容已保留，等待用户选择最终版本。",
  } as const;

  if (existing) {
    // Keep the queue id stable so all later edits target the same deterministic copy.
    updateItem(existing.id, patch);
    for (const duplicate of candidates) {
      if (duplicate.id !== existing.id) dequeue(duplicate.id);
    }
    return;
  }

  enqueue({
    type: "updateNote",
    noteId,
    url: `/notes/${noteId}`,
    method: "PUT",
    ...patch,
  });
}

function clearResolvedConflictArtifacts(noteId: string): void {
  clearNoteSyncConflict(noteId);
  for (const item of getQueue()) {
    if (item.noteId === noteId && item.type === "updateNote" && isConflictQueueItem(item)) {
      dequeue(item.id);
    }
  }
}

export function hasPendingNoteSyncConflict(noteId: string): boolean {
  return !!getNoteSyncConflict(noteId) || getQueue().some(
    (item) => item.noteId === noteId && item.type === "updateNote" && isConflictQueueItem(item),
  );
}

export async function runWithNoteConflictResolution<T>(noteId: string, task: () => Promise<T>): Promise<T> {
  resolvingNoteIds.add(noteId);
  try {
    return await task();
  } finally {
    resolvingNoteIds.delete(noteId);
  }
}

function preserveConflict(
  noteId: string,
  data: NoteMutation,
  baseVersion: number,
  server: Partial<Note> | null,
  reason: NoteSyncConflictRecord["reason"],
): NoteSyncConflictRecord {
  const record = buildConflictRecord(noteId, data, baseVersion, server, reason);
  persistLocalDraft(noteId, data, baseVersion, { serverVersion: record.serverVersion });
  upsertConflictQueueItem(noteId, data, record.serverVersion);
  recordNoteSyncConflict(record);
  return record;
}

export function preserveNoteSyncConflictSnapshot(
  noteId: string,
  data: NoteMutation,
  baseVersion: number,
  server: Partial<Note>,
): void {
  preserveConflict(noteId, data, baseVersion, server, "VERSION_CONFLICT");
}

function dispatchPending(noteId: string, baseVersion: number, detail?: Record<string, unknown>): void {
  window.dispatchEvent(new CustomEvent(NOTE_SYNC_PENDING_EVENT, {
    detail: { noteId, baseVersion, queued: true, ...detail },
  }));
}

function restorePendingDraft(
  noteId: string,
  data: NoteMutation,
  baseVersion: number,
  conflict: boolean,
  serverVersion?: number,
): void {
  window.setTimeout(() => {
    persistLocalDraft(
      noteId,
      data,
      baseVersion,
      conflict ? { serverVersion } : undefined,
    );
  }, 0);
}

export function installNoteSyncSafety(): void {
  if (typeof window === "undefined") return;
  const guardedWindow = window as GuardedWindow;
  if (guardedWindow[INSTALL_KEY]) return;

  const originalGetNote = api.getNote.bind(api);
  const originalUpdateNote = api.updateNote.bind(api);

  async function fetchCurrentServerNote(noteId: string): Promise<Note | null> {
    try {
      const note = await originalGetNote(noteId);
      if (!isCurrentlyOffline()) clearOfflineNoteSnapshot(noteId);
      return isCompleteNote(note, noteId) ? note : null;
    } catch {
      return null;
    }
  }

  function completePendingResponse(
    noteId: string,
    data: NoteMutation,
    baseVersion: number,
    server: Note,
    conflict: boolean,
  ): PendingNote {
    persistLocalDraft(noteId, data, baseVersion, conflict ? { serverVersion: server.version } : undefined);
    restorePendingDraft(noteId, data, baseVersion, conflict, server.version);
    dispatchPending(noteId, baseVersion, { conflict, serverVersion: server.version });
    return makePendingNote(server, data);
  }

  async function retryOnFreshVersion(noteId: string, data: NoteMutation, fresh: Note): Promise<Note | null> {
    try {
      const updated = await originalUpdateNote(noteId, { ...data, version: fresh.version } as Partial<Note>);
      if (!isCompleteNote(updated, noteId) || !isServerConfirmedNoteWrite(fresh.version, updated.version)) {
        return null;
      }
      clearOfflineNoteSnapshot(noteId);
      clearResolvedConflictArtifacts(noteId);
      rememberConfirmedNote(updated, noteId);
      return updated;
    } catch {
      return null;
    }
  }

  (api as any).getNote = async (noteId: string): Promise<Note> => {
    const note = await originalGetNote(noteId);
    if (!isCurrentlyOffline()) clearOfflineNoteSnapshot(noteId);
    rememberConfirmedNote(note, noteId);
    return note;
  };

  (api as any).updateNote = async (noteId: string, data: NoteMutation): Promise<Note> => {
    const versioned = isVersionedNoteMutation(data);
    const baseVersion = Number(data.version);

    if (versioned && !Number.isFinite(baseVersion)) {
      throw syncError(
        "VERSION_REQUIRED_CLIENT",
        "缺少服务端版本，已阻止不安全保存。请重新加载笔记后重试。",
        400,
      );
    }

    if (versioned && !resolvingNoteIds.has(noteId) && hasPendingNoteSyncConflict(noteId)) {
      let server = confirmedNotes.get(noteId) || null;
      if (!server) {
        server = await fetchCurrentServerNote(noteId);
        if (server) confirmedNotes.set(noteId, server);
      }
      preserveConflict(
        noteId,
        data,
        baseVersion,
        server,
        getNoteSyncConflict(noteId)?.reason || "VERSION_CONFLICT",
      );
      if (!server) {
        throw syncError("REMOTE_BASE_UNVERIFIED", "无法确认服务端最新版本，已保留本地草稿并阻止覆盖。");
      }
      return completePendingResponse(noteId, data, baseVersion, server, true);
    }

    if (versioned) persistLocalDraft(noteId, data, baseVersion);

    if (versioned && isOfflineNoteSnapshot(noteId) && !isCurrentlyOffline()) {
      const offlineBase = getOfflineNoteSnapshot(noteId);
      const previousConfirmed = confirmedNotes.get(noteId) || null;
      const fresh = await fetchCurrentServerNote(noteId);
      if (!fresh) {
        preserveConflict(noteId, data, baseVersion, previousConfirmed, "REMOTE_BASE_UNVERIFIED");
        if (previousConfirmed) return completePendingResponse(noteId, data, baseVersion, previousConfirmed, true);
        throw syncError("REMOTE_BASE_UNVERIFIED", "无法确认服务端最新版本，已保留本地草稿并阻止覆盖。");
      }

      if (isCurrentlyOffline()) {
        preserveConflict(noteId, data, baseVersion, fresh, "REMOTE_BASE_UNVERIFIED");
        return completePendingResponse(noteId, data, baseVersion, fresh, true);
      }

      clearOfflineNoteSnapshot(noteId);
      const baseContentMismatch = !!(
        offlineBase?.contentFingerprint
        && fingerprintNoteContent(fresh.content) !== offlineBase.contentFingerprint
      );
      if (fresh.version !== baseVersion || baseContentMismatch) {
        if (mutationMatchesNote(fresh, data)) {
          clearResolvedConflictArtifacts(noteId);
          rememberConfirmedNote(fresh, noteId);
          return fresh;
        }
        if (previousConfirmed && noteBodiesEqual(fresh, previousConfirmed)) {
          const retried = await retryOnFreshVersion(noteId, data, fresh);
          if (retried) return retried;
        }
        preserveConflict(noteId, data, baseVersion, fresh, "STALE_OFFLINE_BASE");
        confirmedNotes.set(noteId, fresh);
        return completePendingResponse(noteId, data, baseVersion, fresh, true);
      }
    }

    const previousConfirmed = confirmedNotes.get(noteId) || null;
    try {
      const updated = await originalUpdateNote(noteId, data as Partial<Note>);
      if (versioned && !isServerConfirmedNoteWrite(baseVersion, updated?.version)) {
        persistLocalDraft(noteId, data, baseVersion);
        markOfflineNoteSnapshot({ id: noteId, version: baseVersion, updatedAt: updated?.updatedAt });
        const server = previousConfirmed || (isCompleteNote(updated, noteId) ? updated : null);
        if (server) return completePendingResponse(noteId, data, baseVersion, server, false);
        dispatchPending(noteId, baseVersion, { responseIncomplete: true });
        const error = syncError("OFFLINE_WRITE_QUEUED", "修改已保存在本地并等待上传，尚未得到服务端确认。") as any;
        error.queued = true;
        throw error;
      }

      clearOfflineNoteSnapshot(noteId);
      clearResolvedConflictArtifacts(noteId);
      rememberConfirmedNote(updated, noteId);
      return updated;
    } catch (error: any) {
      if (error?.status !== 409 && error?.code !== "VERSION_CONFLICT") throw error;

      const fresh = await fetchCurrentServerNote(noteId);
      if (fresh && mutationMatchesNote(fresh, data)) {
        clearOfflineNoteSnapshot(noteId);
        clearResolvedConflictArtifacts(noteId);
        rememberConfirmedNote(fresh, noteId);
        return fresh;
      }
      if (fresh && previousConfirmed && noteBodiesEqual(fresh, previousConfirmed)) {
        const retried = await retryOnFreshVersion(noteId, data, fresh);
        if (retried) return retried;
      }

      const currentVersion = typeof error.currentVersion === "number" ? error.currentVersion : undefined;
      const fallbackServer = previousConfirmed
        ? ({ ...previousConfirmed, version: currentVersion ?? previousConfirmed.version } as Note)
        : null;
      const server = fresh || fallbackServer;
      const record = preserveConflict(noteId, data, baseVersion, server, "VERSION_CONFLICT");
      if (typeof error.currentVersion !== "number" && typeof record.serverVersion === "number") {
        error.currentVersion = record.serverVersion;
      }
      if (server) {
        if (fresh) confirmedNotes.set(noteId, fresh);
        return completePendingResponse(noteId, data, baseVersion, server, true);
      }
      throw syncError("REMOTE_BASE_UNVERIFIED", "无法确认服务端最新版本，已保留本地草稿并阻止覆盖。");
    }
  };

  guardedWindow[INSTALL_KEY] = () => {
    (api as any).getNote = originalGetNote;
    (api as any).updateNote = originalUpdateNote;
    resolvingNoteIds.clear();
    confirmedNotes.clear();
    delete guardedWindow[INSTALL_KEY];
  };
}
