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
import { OFFLINE_QUEUE_CONFLICT_EVENT } from "@/lib/offlineQueue";
import { saveDraft } from "@/lib/draftStorage";

const INSTALL_KEY = "__NOWEN_NOTE_SYNC_SAFETY_V1__" as const;
const CONFLICT_STORAGE_KEY = "nowen-note-sync-conflicts:v1";
const MAX_CONFLICTS = 20;
const MAX_SNAPSHOT_CHARS = 500_000;

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

type GuardedWindow = Window & typeof globalThis & {
  [INSTALL_KEY]?: () => void;
};

type NoteMutation = Partial<Note> & Record<string, unknown>;

export function isVersionedNoteMutation(data: NoteMutation): boolean {
  return ["title", "content", "contentText", "contentFormat"].some(
    (field) => data[field] !== undefined,
  );
}

export function isServerConfirmedNoteWrite(baseVersion: number, responseVersion: unknown): boolean {
  return typeof responseVersion === "number" && Number.isFinite(responseVersion) && responseVersion > baseVersion;
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

export function listNoteSyncConflicts(): NoteSyncConflictRecord[] {
  return readConflictRecords();
}

export function recordNoteSyncConflict(record: NoteSyncConflictRecord): void {
  try {
    const records = readConflictRecords()
      .filter((item) => item.noteId !== record.noteId || item.createdAt !== record.createdAt);
    records.unshift(record);
    localStorage.setItem(CONFLICT_STORAGE_KEY, JSON.stringify(records.slice(0, MAX_CONFLICTS)));
  } catch {
    // The complete local edit remains in draftStorage even if conflict metadata hits quota.
  }
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

function dispatchConflict(record: NoteSyncConflictRecord, localPayload: NoteMutation): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OFFLINE_QUEUE_CONFLICT_EVENT, {
    detail: {
      noteId: record.noteId,
      localVersion: record.baseVersion,
      serverVersion: record.serverVersion,
      localPayload,
      serverSnapshot: {
        title: record.serverTitle,
        content: record.serverContent,
        contentText: record.serverContentText,
        updatedAt: record.serverUpdatedAt,
      },
      reason: record.reason,
      message: "检测到多端版本冲突，已停止自动覆盖，并保留本地草稿。",
    },
  }));
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

function preserveConflict(
  noteId: string,
  data: NoteMutation,
  baseVersion: number,
  server: Partial<Note> | null,
  reason: NoteSyncConflictRecord["reason"],
): NoteSyncConflictRecord {
  const record = buildConflictRecord(noteId, data, baseVersion, server, reason);
  persistLocalDraft(noteId, data, baseVersion, { serverVersion: record.serverVersion });
  recordNoteSyncConflict(record);
  dispatchConflict(record, data);
  return record;
}

export function installNoteSyncSafety(): void {
  if (typeof window === "undefined") return;
  const guardedWindow = window as GuardedWindow;
  if (guardedWindow[INSTALL_KEY]) return;

  const originalGetNote = api.getNote.bind(api);
  const originalUpdateNote = api.updateNote.bind(api);

  (api as any).getNote = async (noteId: string): Promise<Note> => {
    const note = await originalGetNote(noteId);
    if (!isCurrentlyOffline()) clearOfflineNoteSnapshot(noteId);
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

    if (versioned) persistLocalDraft(noteId, data, baseVersion);

    if (versioned && isOfflineNoteSnapshot(noteId) && !isCurrentlyOffline()) {
      const offlineBase = getOfflineNoteSnapshot(noteId);
      let fresh: Note;
      try {
        fresh = await originalGetNote(noteId);
      } catch {
        preserveConflict(noteId, data, baseVersion, null, "REMOTE_BASE_UNVERIFIED");
        throw syncError(
          "REMOTE_BASE_UNVERIFIED",
          "无法确认服务端最新版本，已保留本地草稿并阻止覆盖。",
        );
      }

      if (isCurrentlyOffline()) {
        preserveConflict(noteId, data, baseVersion, fresh, "REMOTE_BASE_UNVERIFIED");
        throw syncError(
          "REMOTE_BASE_UNVERIFIED",
          "服务端正文尚未成功加载，已阻止保存。",
        );
      }

      clearOfflineNoteSnapshot(noteId);
      const baseContentMismatch = !!(
        offlineBase?.contentFingerprint &&
        fingerprintNoteContent(fresh.content) !== offlineBase.contentFingerprint
      );
      if (fresh.version !== baseVersion || baseContentMismatch) {
        preserveConflict(noteId, data, baseVersion, fresh, "STALE_OFFLINE_BASE");
        const error = syncError("VERSION_CONFLICT", "Version conflict", 409) as any;
        error.currentVersion = fresh.version;
        error.baseContentMismatch = baseContentMismatch;
        throw error;
      }
    }

    try {
      const updated = await originalUpdateNote(noteId, data as Partial<Note>);

      if (versioned && !isServerConfirmedNoteWrite(baseVersion, updated?.version)) {
        persistLocalDraft(noteId, data, baseVersion);
        markOfflineNoteSnapshot({
          id: noteId,
          version: baseVersion,
          updatedAt: updated?.updatedAt,
        });
        window.dispatchEvent(new CustomEvent(NOTE_SYNC_PENDING_EVENT, {
          detail: { noteId, baseVersion, queued: true },
        }));
        const error = syncError(
          "OFFLINE_WRITE_QUEUED",
          "修改已保存在本地并等待上传，尚未得到服务端确认。",
        ) as any;
        error.queued = true;
        throw error;
      }

      clearOfflineNoteSnapshot(noteId);
      return updated;
    } catch (error: any) {
      if (error?.status === 409 || error?.code === "VERSION_CONFLICT") {
        let server: Note | null = null;
        try {
          server = await originalGetNote(noteId);
          if (!isCurrentlyOffline()) clearOfflineNoteSnapshot(noteId);
        } catch {
          // The version from the 409 is enough to stop the write safely.
        }
        const record = preserveConflict(noteId, data, baseVersion, server, "VERSION_CONFLICT");
        if (typeof error.currentVersion !== "number" && typeof record.serverVersion === "number") {
          error.currentVersion = record.serverVersion;
        }
      }
      throw error;
    }
  };

  guardedWindow[INSTALL_KEY] = () => {
    (api as any).getNote = originalGetNote;
    (api as any).updateNote = originalUpdateNote;
    delete guardedWindow[INSTALL_KEY];
  };
}
