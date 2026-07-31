from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8-sig")


def write(path: str, text: str) -> None:
    Path(path).write_text(text, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one marker, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex match, found {count}: {pattern[:120]!r}")
    write(path, next_text)


# ---------------------------------------------------------------------------
# Backend migration and router registration
# ---------------------------------------------------------------------------
replace_once(
    "backend/src/db/migrations.ts",
    'import { tagScopeUniquenessMigration } from "./tagScopeUniquenessMigration.js";\n',
    'import { tagScopeUniquenessMigration } from "./tagScopeUniquenessMigration.js";\n'
    'import { offlineSyncMigration } from "./offlineSyncMigration.js";\n',
)
replace_once(
    "backend/src/db/migrations.ts",
    '  tagScopeUniquenessMigration,\n].sort((a, b) => a.version - b.version);',
    '  tagScopeUniquenessMigration,\n  offlineSyncMigration,\n].sort((a, b) => a.version - b.version);',
)
replace_once(
    "backend/src/index.ts",
    'import notesRouter from "./routes/notes";\n',
    'import notesRouter from "./routes/notes";\nimport offlineSyncRouter from "./routes/offline-sync";\n',
)
replace_once(
    "backend/src/index.ts",
    'app.route("/api/notes", notesRouter);\n',
    'app.route("/api/notes", notesRouter);\napp.route("/api/offline-sync", offlineSyncRouter);\n',
)

# Direct note grants are valid personal-scope access too. The capability resolver
# already centralizes owner, notebook member and inherited permission semantics.
replace_once(
    "backend/src/routes/offline-sync.ts",
    '''function noteIsInScope(note: Pick<NoteRow, "userId" | "workspaceId" | "notebookId">, userId: string, scope: SyncScope, notebookIds: Set<string>): boolean {
  if (scope.workspaceId) return note.workspaceId === scope.workspaceId;
  return note.workspaceId === null && (note.userId === userId || notebookIds.has(note.notebookId));
}''',
    '''function noteIsInScope(
  note: Pick<NoteRow, "id" | "userId" | "workspaceId" | "notebookId">,
  userId: string,
  scope: SyncScope,
  notebookIds: Set<string>,
): boolean {
  if (scope.workspaceId) return note.workspaceId === scope.workspaceId;
  if (note.workspaceId !== null) return false;
  if (note.userId === userId || notebookIds.has(note.notebookId)) return true;
  return resolveEffectiveNoteCapabilities(note.id, userId).read;
}''',
)
replace_once(
    "backend/src/routes/offline-sync.ts",
    '''  const notes = listAllAccessibleNotes(db, userId, scope, access.ids);
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);''',
    '''  const notes = listAllAccessibleNotes(db, userId, scope, access.ids);
  const accessFingerprint = createHash("sha256")
    .update([
      access.accessFingerprint,
      ...notes.map((note) => {
        const capabilities = resolveEffectiveNoteCapabilities(note.id, userId);
        return `note:${note.id}:${note.notebookId}:${note.workspaceId || ""}:${capabilities.permission || ""}:${capabilities.download ? 1 : 0}`;
      }),
    ].sort().join("\\n"))
    .digest("hex");
  const after = Math.max(0, Number(c.req.query("after") || 0) || 0);''',
)
replace_once(
    "backend/src/routes/offline-sync.ts",
    '    accessFingerprint: access.accessFingerprint,\n',
    '    accessFingerprint,\n',
)
replace_once(
    "backend/src/routes/offline-sync.ts",
    '''  for (const note of notes) {
    const capabilities = resolveEffectiveNoteCapabilities(note.id, userId);
    if (!capabilities.read || !capabilities.download) {
      attachmentForbiddenNotes += 1;
      continue;
    }
    const row = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
      FROM attachments WHERE noteId = ?
    `).get(note.id) as { count: number; bytes: number };
    attachmentCount += Number(row.count || 0);
    attachmentBytes += Number(row.bytes || 0);
  }''',
    '''  for (const note of notes) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
      FROM attachments WHERE noteId = ?
    `).get(note.id) as { count: number; bytes: number };
    const count = Number(row.count || 0);
    if (count === 0) continue;
    const capabilities = resolveEffectiveNoteCapabilities(note.id, userId);
    if (!capabilities.read || !capabilities.download) {
      attachmentForbiddenNotes += 1;
      continue;
    }
    attachmentCount += count;
    attachmentBytes += Number(row.bytes || 0);
  }''',
)
replace_once(
    "backend/src/routes/offline-sync.ts",
    '  const nextSequence = raw.length > 0 ? raw[raw.length - 1].sequence : after;\n',
    '  const nextSequence = raw.length > 0 ? raw[raw.length - 1].sequence : serverSequence;\n',
)

# ---------------------------------------------------------------------------
# Frontend types and IndexedDB stores
# ---------------------------------------------------------------------------
replace_once(
    "frontend/src/types/index.ts",
    '''export interface Tag {
  id: string;
  userId: string;
  name: string;''',
    '''export interface Tag {
  id: string;
  userId: string;
  workspaceId?: string | null;
  name: string;''',
)

replace_once(
    "frontend/src/lib/localStore.ts",
    '''export type CachedNote = Note & {
  __detailCached?: boolean;
};
''',
    '''export type CachedNote = Note & {
  __detailCached?: boolean;
};

export interface OfflineAttachmentRecord {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  blob: Blob;
  cachedAt: number;
}

export interface OfflineStorageStats {
  cachedNotes: number;
  placeholderNotes: number;
  noteBytes: number;
  attachmentCount: number;
  attachmentBytes: number;
  totalBytes: number;
}

export interface OfflineScopeReconcileOptions {
  noteIds?: ReadonlySet<string>;
  notebookIds?: ReadonlySet<string>;
  tagIds?: ReadonlySet<string>;
  deleteNoteIds?: ReadonlySet<string>;
  preserveNoteIds?: ReadonlySet<string>;
}
''',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    '''  tags: {
    key: string;
    value: Tag;
  };
  meta: {''',
    '''  tags: {
    key: string;
    value: Tag;
  };
  offlineAttachments: {
    key: string;
    value: OfflineAttachmentRecord;
    indexes: {
      "by-note": string;
      "by-cached": number;
    };
  };
  meta: {''',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    'const DB_VERSION = 1;\n',
    'const DB_VERSION = 2;\n',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    '''        if (!db.objectStoreNames.contains("tags")) {
          db.createObjectStore("tags", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("meta")) {''',
    '''        if (!db.objectStoreNames.contains("tags")) {
          db.createObjectStore("tags", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("offlineAttachments")) {
          const store = db.createObjectStore("offlineAttachments", { keyPath: "id" });
          store.createIndex("by-note", "noteId");
          store.createIndex("by-cached", "cachedAt");
        }
        if (!db.objectStoreNames.contains("meta")) {''',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    '''    const transaction = db.transaction(["notebooks", "notes", "tags", "meta"], "readwrite");
    await Promise.all([
      transaction.objectStore("notebooks").clear(),
      transaction.objectStore("notes").clear(),
      transaction.objectStore("tags").clear(),
      transaction.objectStore("meta").clear(),
    ]);''',
    '''    const transaction = db.transaction(["notebooks", "notes", "tags", "offlineAttachments", "meta"], "readwrite");
    await Promise.all([
      transaction.objectStore("notebooks").clear(),
      transaction.objectStore("notes").clear(),
      transaction.objectStore("tags").clear(),
      transaction.objectStore("offlineAttachments").clear(),
      transaction.objectStore("meta").clear(),
    ]);''',
)

local_store_extension = r'''
function dispatchOfflineAttachmentRemoval(ids: readonly string[]): void {
  if (ids.length === 0 || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("nowen:offline-attachments-removed", {
    detail: { ids: [...ids] },
  }));
}

export async function putOfflineAttachment(record: OfflineAttachmentRecord): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    await (await connection).put("offlineAttachments", record);
  }, undefined, "putOfflineAttachment");
}

export async function getOfflineAttachment(id: string): Promise<OfflineAttachmentRecord | undefined> {
  const connection = getDb();
  if (!connection) return undefined;
  return safe(async () => (await connection).get("offlineAttachments", id), undefined, "getOfflineAttachment");
}

export async function getOfflineAttachmentsByNote(noteId: string): Promise<OfflineAttachmentRecord[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("offlineAttachments", "by-note", noteId),
    [],
    "getOfflineAttachmentsByNote",
  );
}

export async function markOfflineAttachmentsAccessed(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("offlineAttachments", "readwrite");
    const now = Date.now();
    for (const id of ids) {
      const row = await transaction.store.get(id);
      if (row) await transaction.store.put({ ...row, cachedAt: now });
    }
    await transaction.done;
  }, undefined, "markOfflineAttachmentsAccessed");
}

export async function deleteOfflineAttachment(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    await (await connection).delete("offlineAttachments", id);
    dispatchOfflineAttachmentRemoval([id]);
  }, undefined, "deleteOfflineAttachment");
}

export async function deleteOfflineAttachmentsByNote(noteId: string): Promise<string[]> {
  const records = await getOfflineAttachmentsByNote(noteId);
  if (records.length === 0) return [];
  const connection = getDb();
  if (!connection) return [];
  const ids = records.map((record) => record.id);
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("offlineAttachments", "readwrite");
    await Promise.all(ids.map((id) => transaction.store.delete(id)));
    await transaction.done;
  }, undefined, "deleteOfflineAttachmentsByNote");
  dispatchOfflineAttachmentRemoval(ids);
  return ids;
}

export async function reconcileOfflineAttachments(
  noteId: string,
  keepIds: ReadonlySet<string>,
): Promise<string[]> {
  const current = await getOfflineAttachmentsByNote(noteId);
  const removed = current.filter((record) => !keepIds.has(record.id)).map((record) => record.id);
  if (removed.length === 0) return [];
  const connection = getDb();
  if (!connection) return [];
  await safe(async () => {
    const db = await connection;
    const transaction = db.transaction("offlineAttachments", "readwrite");
    await Promise.all(removed.map((id) => transaction.store.delete(id)));
    await transaction.done;
  }, undefined, "reconcileOfflineAttachments");
  dispatchOfflineAttachmentRemoval(removed);
  return removed;
}

export async function evictOfflineAttachmentsToFit(
  bytesToFree: number,
  preserveIds: ReadonlySet<string> = new Set(),
): Promise<{ freedBytes: number; evictedIds: string[] }> {
  if (bytesToFree <= 0) return { freedBytes: 0, evictedIds: [] };
  const connection = getDb();
  if (!connection) return { freedBytes: 0, evictedIds: [] };
  return safe(async () => {
    const db = await connection;
    const rows = await db.getAllFromIndex("offlineAttachments", "by-cached");
    let freedBytes = 0;
    const evictedIds: string[] = [];
    const transaction = db.transaction("offlineAttachments", "readwrite");
    for (const row of rows) {
      if (freedBytes >= bytesToFree) break;
      if (preserveIds.has(row.id)) continue;
      await transaction.store.delete(row.id);
      freedBytes += Number(row.size || row.blob?.size || 0);
      evictedIds.push(row.id);
    }
    await transaction.done;
    dispatchOfflineAttachmentRemoval(evictedIds);
    return { freedBytes, evictedIds };
  }, { freedBytes: 0, evictedIds: [] }, "evictOfflineAttachmentsToFit");
}

function recordMatchesWorkspace(value: { workspaceId?: string | null }, workspaceId: string | null): boolean {
  return (value.workspaceId ?? null) === workspaceId;
}

export async function reconcileOfflineScope(
  workspaceId: string | null,
  options: OfflineScopeReconcileOptions,
): Promise<string[]> {
  const preserve = options.preserveNoteIds || new Set<string>();
  const localNotes = await getAllNotes();
  const localNotebooks = await getAllNotebooks();
  const localTags = await getAllTags();
  const deleteNoteIds = new Set<string>();

  if (options.deleteNoteIds) {
    for (const id of options.deleteNoteIds) {
      if (!preserve.has(id)) deleteNoteIds.add(id);
    }
  }
  if (options.noteIds) {
    for (const note of localNotes) {
      if (
        recordMatchesWorkspace(note, workspaceId)
        && !options.noteIds.has(note.id)
        && !preserve.has(note.id)
      ) deleteNoteIds.add(note.id);
    }
  }

  const removedAttachmentIds: string[] = [];
  for (const noteId of deleteNoteIds) {
    removedAttachmentIds.push(...await deleteOfflineAttachmentsByNote(noteId));
    await deleteNote(noteId);
  }

  const connection = getDb();
  if (!connection) return removedAttachmentIds;
  await safe(async () => {
    const db = await connection;
    if (options.notebookIds) {
      const transaction = db.transaction("notebooks", "readwrite");
      for (const notebook of localNotebooks) {
        if (recordMatchesWorkspace(notebook, workspaceId) && !options.notebookIds.has(notebook.id)) {
          await transaction.store.delete(notebook.id);
        }
      }
      await transaction.done;
    }
    if (options.tagIds) {
      const transaction = db.transaction("tags", "readwrite");
      for (const tag of localTags) {
        if (recordMatchesWorkspace(tag, workspaceId) && !options.tagIds.has(tag.id)) {
          await transaction.store.delete(tag.id);
        }
      }
      await transaction.done;
    }
  }, undefined, "reconcileOfflineScope");
  return removedAttachmentIds;
}

export async function clearOfflineScope(
  workspaceId: string | null,
  preserveNoteIds: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  return reconcileOfflineScope(workspaceId, {
    noteIds: new Set(),
    notebookIds: new Set(),
    tagIds: new Set(),
    preserveNoteIds,
  });
}

export async function getOfflineStorageStats(): Promise<OfflineStorageStats> {
  const connection = getDb();
  if (!connection) {
    return {
      cachedNotes: 0,
      placeholderNotes: 0,
      noteBytes: 0,
      attachmentCount: 0,
      attachmentBytes: 0,
      totalBytes: 0,
    };
  }
  return safe(async () => {
    const db = await connection;
    const [notes, attachments] = await Promise.all([
      db.getAll("notes"),
      db.getAll("offlineAttachments"),
    ]);
    let cachedNotes = 0;
    let placeholderNotes = 0;
    let noteBytes = 0;
    for (const note of notes) {
      if (isNoteDetailCached(note)) cachedNotes += 1;
      else placeholderNotes += 1;
      noteBytes += (note.content?.length || 0) * 2;
      noteBytes += (note.contentText?.length || 0) * 2;
      noteBytes += (note.title?.length || 0) * 2;
    }
    const attachmentBytes = attachments.reduce(
      (sum, attachment) => sum + Number(attachment.size || attachment.blob?.size || 0),
      0,
    );
    return {
      cachedNotes,
      placeholderNotes,
      noteBytes,
      attachmentCount: attachments.length,
      attachmentBytes,
      totalBytes: noteBytes + attachmentBytes,
    };
  }, {
    cachedNotes: 0,
    placeholderNotes: 0,
    noteBytes: 0,
    attachmentCount: 0,
    attachmentBytes: 0,
    totalBytes: 0,
  }, "getOfflineStorageStats");
}

'''
replace_once(
    "frontend/src/lib/localStore.ts",
    'export function isReady(): boolean {\n',
    local_store_extension + 'export function isReady(): boolean {\n',
)

# ---------------------------------------------------------------------------
# Attachment object URL bridge
# ---------------------------------------------------------------------------
replace_once(
    "frontend/src/lib/noteAttachmentAccessBridge.ts",
    'import { getShareSessionId } from "@/lib/shareSession";\n',
    'import { getShareSessionId } from "@/lib/shareSession";\n'
    'import { getOfflineAttachmentsByNote, markOfflineAttachmentsAccessed } from "@/lib/localStore";\n',
)
replace_once(
    "frontend/src/lib/noteAttachmentAccessBridge.ts",
    'const accessUrls = new Map<string, string>();\n',
    'const accessUrls = new Map<string, string>();\nconst offlineObjectUrls = new Map<string, string>();\n',
)
bridge_helpers = r'''
function revokeOfflineObjectUrl(id: string): void {
  const current = offlineObjectUrls.get(id);
  if (!current) return;
  offlineObjectUrls.delete(id);
  try { URL.revokeObjectURL(current); } catch { /* ignore unavailable URL API */ }
}

export function registerOfflineAttachmentBlob(id: string, blob: Blob): string | null {
  if (!ATTACHMENT_ID_RE.test(id) || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  revokeOfflineObjectUrl(id);
  const url = URL.createObjectURL(blob);
  offlineObjectUrls.set(id, url);
  queueDomScan();
  return url;
}

export function unregisterOfflineAttachmentObjectUrl(id: string): void {
  revokeOfflineObjectUrl(id);
  queueDomScan();
}

export function clearOfflineAttachmentObjectUrls(): void {
  for (const id of [...offlineObjectUrls.keys()]) revokeOfflineObjectUrl(id);
  queueDomScan();
}

export async function hydrateOfflineAttachmentsForNote(noteId: string): Promise<number> {
  const records = await getOfflineAttachmentsByNote(noteId);
  let hydrated = 0;
  for (const record of records) {
    if (registerOfflineAttachmentBlob(record.id, record.blob)) hydrated += 1;
  }
  if (records.length > 0) {
    await markOfflineAttachmentsAccessed(records.map((record) => record.id));
  }
  return hydrated;
}

'''
replace_once(
    "frontend/src/lib/noteAttachmentAccessBridge.ts",
    'export function resolveAttachmentAccessUrl(raw: string): string {\n',
    bridge_helpers + 'export function resolveAttachmentAccessUrl(raw: string): string {\n',
)
replace_once(
    "frontend/src/lib/noteAttachmentAccessBridge.ts",
    '''  const id = extractAttachmentId(raw);
  if (!id) return raw;
  const signed = accessUrls.get(id);''',
    '''  const id = extractAttachmentId(raw);
  if (!id) return raw;
  const offline = offlineObjectUrls.get(id);
  if (offline) return offline;
  const signed = accessUrls.get(id);''',
)
replace_once(
    "frontend/src/lib/noteAttachmentAccessBridge.ts",
    '''export function resetAttachmentAccessStateForTests(): void {
  accessUrls.clear();
  attachmentApiOrigin = "";''',
    '''export function resetAttachmentAccessStateForTests(): void {
  accessUrls.clear();
  clearOfflineAttachmentObjectUrls();
  attachmentApiOrigin = "";''',
)
replace_once(
    "frontend/src/lib/noteAttachmentAccessBridge.ts",
    '''function rewriteElementAttribute(element: Element, attribute: string): void {
  const raw = element.getAttribute(attribute);
  if (!raw) return;
  const resolved = resolveAttachmentAccessUrl(raw);
  if (resolved !== raw) element.setAttribute(attribute, resolved);
}''',
    '''function rewriteElementAttribute(element: Element, attribute: string): void {
  const raw = element.getAttribute(attribute);
  if (!raw) return;
  const rememberedId = element.getAttribute("data-nowen-attachment-id");
  const rawId = extractAttachmentId(raw);
  const attachmentId = rawId || (rememberedId && ATTACHMENT_ID_RE.test(rememberedId) ? rememberedId : null);
  const source = attachmentId && raw.startsWith("blob:")
    ? `/api/attachments/${attachmentId}`
    : raw;
  const resolved = resolveAttachmentAccessUrl(source);
  if (attachmentId) element.setAttribute("data-nowen-attachment-id", attachmentId);
  if (resolved !== raw) element.setAttribute(attribute, resolved);
}''',
)
# Observe cache removals even when they happen in localStore without importing this bridge.
replace_once(
    "frontend/src/lib/noteAttachmentAccessBridge.ts",
    '''const offlineObjectUrls = new Map<string, string>();
let attachmentApiOrigin = "";''',
    '''const offlineObjectUrls = new Map<string, string>();
if (typeof window !== "undefined") {
  window.addEventListener("nowen:offline-attachments-removed", (event) => {
    const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids || [];
    for (const id of ids) revokeOfflineObjectUrl(id);
    if (ids.length > 0) queueDomScan();
  });
}
let attachmentApiOrigin = "";''',
)

# ---------------------------------------------------------------------------
# Offline read, sync lifecycle and network recovery
# ---------------------------------------------------------------------------
replace_once(
    "frontend/src/lib/offlineRead.ts",
    'import type { Note, NoteListItem, Notebook, Tag } from "@/types";\n',
    'import type { Note, NoteListItem, Notebook, Tag } from "@/types";\n'
    'import { hydrateOfflineAttachmentsForNote } from "@/lib/noteAttachmentAccessBridge";\n',
)
replace_once(
    "frontend/src/lib/offlineRead.ts",
    '''export function readNote(id: string, online: () => Promise<Note>): Promise<Note> {
  return withFallback(
    online,
    async () => {
      const note = await localGetNote(id);
      if (!note) throw new Error("笔记不在本地缓存中");
      if (!isNoteDetailCached(note)) {
        throw new Error("该笔记只有列表摘要，正文尚未缓存，离线时无法打开");
      }
      return note;
    },
    {
      onOnline: (note) => clearOfflineNoteSnapshot(note.id),
      onFallback: (note) => markOfflineNoteSnapshot(note),
    },
  );
}''',
    '''export function readNote(id: string, online: () => Promise<Note>): Promise<Note> {
  return withFallback(
    online,
    async () => {
      const note = await localGetNote(id);
      if (!note) throw new Error("笔记不在本地缓存中");
      if (!isNoteDetailCached(note)) {
        throw new Error("该笔记尚未完成离线下载，恢复网络后会自动继续同步");
      }
      return note;
    },
    {
      onOnline: (note) => clearOfflineNoteSnapshot(note.id),
      onFallback: (note) => markOfflineNoteSnapshot(note),
    },
  ).then(async (note) => {
    await hydrateOfflineAttachmentsForNote(note.id).catch((error) => {
      console.warn("[offlineRead] hydrate cached attachments failed", error);
    });
    return note;
  });
}''',
)

replace_once(
    "frontend/src/lib/syncEngine.ts",
    'import type { Note, User } from "@/types";\n',
    'import type { Note, User } from "@/types";\n'
    'import {\n'
    '  setOfflineSyncUser,\n'
    '  stopOfflineWorkspaceSync,\n'
    '  syncOfflineWorkspace,\n'
    '} from "@/lib/offlineWorkspaceSync";\n',
)
replace_once(
    "frontend/src/lib/syncEngine.ts",
    '''export async function bootstrap(user: User): Promise<void> {
  setCurrentUser(user.id);''',
    '''export async function bootstrap(user: User): Promise<void> {
  setCurrentUser(user.id);
  setOfflineSyncUser(user.id);''',
)
replace_once(
    "frontend/src/lib/syncEngine.ts",
    '''    await pullServerSnapshot();
    const pending = getQueueLength();
    const versionConflicts = countVersionConflicts(getFailedQueueItems());''',
    '''    await pullServerSnapshot();
    void syncOfflineWorkspace({ reason: "bootstrap" }).catch((error) => {
      console.warn("[syncEngine] complete offline bootstrap failed", error);
    });
    const pending = getQueueLength();
    const versionConflicts = countVersionConflicts(getFailedQueueItems());''',
)
# The same marker occurs in syncNow after a blank line; replace the exact later block.
replace_once(
    "frontend/src/lib/syncEngine.ts",
    '''    await pullServerSnapshot();

    const pending = getQueueLength();''',
    '''    await pullServerSnapshot();
    const offlineResult = await syncOfflineWorkspace({ force: true, reason: "manual" });
    if (offlineResult.state === "error") {
      throw new Error(offlineResult.lastError || "离线副本同步失败");
    }

    const pending = getQueueLength();''',
)
replace_once(
    "frontend/src/lib/syncEngine.ts",
    '''export function teardown(): void {
  setCurrentUser(null);
  setState("idle");
}''',
    '''export function teardown(): void {
  stopOfflineWorkspaceSync();
  setOfflineSyncUser(null);
  setCurrentUser(null);
  setState("idle");
}''',
)

replace_once(
    "frontend/src/hooks/useNetworkStatus.ts",
    'import { syncNow } from "@/lib/syncEngine";\n',
    'import { syncNow } from "@/lib/syncEngine";\n'
    'import { syncOfflineChangesIfDue } from "@/lib/offlineWorkspaceSync";\n',
)
replace_once(
    "frontend/src/hooks/useNetworkStatus.ts",
    '''    if (queueLength === 0) {
      // 真实恢复但没有离线修改时保持静默。
      if (wasActuallyOffline) recoveryPendingCountRef.current = 0;
      setPendingCount(0);
      return true;
    }''',
    '''    if (queueLength === 0) {
      // Even without local writes, the server may have changed on another device.
      // A real reconnection forces a delta pull; steady probes respect the user interval.
      void syncOfflineChangesIfDue(wasActuallyOffline).catch((error) => {
        console.warn("[useNetworkStatus] offline workspace delta pull failed", error);
      });
      if (wasActuallyOffline) recoveryPendingCountRef.current = 0;
      setPendingCount(0);
      return true;
    }''',
)

# ---------------------------------------------------------------------------
# Settings entry and public pure helpers for tests
# ---------------------------------------------------------------------------
replace_once(
    "frontend/src/components/SettingsModal.tsx",
    'Download, FolderSync } from "lucide-react";',
    'Download, FolderSync, CloudDownload } from "lucide-react";',
)
replace_once(
    "frontend/src/components/SettingsModal.tsx",
    'import FolderSyncSettings from "@/components/settings/FolderSyncSettings";\n',
    'import FolderSyncSettings from "@/components/settings/FolderSyncSettings";\n'
    'import OfflineSyncSettings from "@/components/settings/OfflineSyncSettings";\n',
)
replace_once(
    "frontend/src/components/SettingsModal.tsx",
    'type TabId = "appearance" | "switches" | "shortcuts" | "ai" | "security" | "tokens" | "data" | "folderSync" | "users" | "workspaces" | "download" | "about";',
    'type TabId = "appearance" | "switches" | "shortcuts" | "ai" | "security" | "tokens" | "data" | "offlineSync" | "folderSync" | "users" | "workspaces" | "download" | "about";',
)
replace_once(
    "frontend/src/components/SettingsModal.tsx",
    '''    { id: "data" as const, label: t('settings.dataManagement'), icon: Database },
    // 「文件夹同步」：桌面端专属，Phase B 只做配置 CRUD''',
    '''    { id: "data" as const, label: t('settings.dataManagement'), icon: Database },
    { id: "offlineSync" as const, label: "离线同步", icon: CloudDownload },
    // 「文件夹同步」：桌面端专属，Phase B 只做配置 CRUD''',
)
replace_once(
    "frontend/src/components/SettingsModal.tsx",
    '''                  {activeTab === "data" && <DataManager />}
                  {activeTab === "folderSync" && <FolderSyncSettings />}''',
    '''                  {activeTab === "data" && <DataManager />}
                  {activeTab === "offlineSync" && <OfflineSyncSettings />}
                  {activeTab === "folderSync" && <FolderSyncSettings />}''',
)

path = "frontend/src/lib/offlineWorkspaceSync.ts"
text = read(path)
text = text.replace("function normalizeSettings(", "export function normalizeOfflineSyncSettings(")
text = text.replace("normalizeSettings(", "normalizeOfflineSyncSettings(")
text = text.replace("function wantsAttachment(", "export function isOfflineAttachmentWanted(")
text = text.replace("wantsAttachment(", "isOfflineAttachmentWanted(")
old_targets = '''  let workspaces: Workspace[] = [];
  try {
    workspaces = await api.getWorkspaces();
  } catch (error) {
    console.warn("[offline-sync] failed to list workspaces", error);
  }
  const selected = settings.workspaceMode === "all"'''
new_targets = '''  const workspaces: Workspace[] = await api.getWorkspaces();
  const selected = settings.workspaceMode === "all"'''
if text.count(old_targets) != 1:
    raise SystemExit("offlineWorkspaceSync.ts: resolveTargets marker not found")
text = text.replace(old_targets, new_targets, 1)
old_metadata = '''  await putNotebooks(plan.notebooks);
  await putTags(plan.tags);

  const snapshotComplete = Boolean(await getMeta<boolean>(`${SNAPSHOT_COMPLETE_PREFIX}${target.scopeKey}`));'''
new_metadata = '''  await putNotebooks(plan.notebooks);
  await putTags(plan.tags);
  await reconcileOfflineScope(target.workspaceId, {
    notebookIds: new Set(plan.notebooks.map((notebook) => notebook.id)),
    tagIds: new Set(plan.tags.map((tag) => tag.id)),
    preserveNoteIds: queuedNoteIds,
  });

  const snapshotComplete = Boolean(await getMeta<boolean>(`${SNAPSHOT_COMPLETE_PREFIX}${target.scopeKey}`));'''
if text.count(old_metadata) != 1:
    raise SystemExit("offlineWorkspaceSync.ts: metadata reconcile marker not found")
text = text.replace(old_metadata, new_metadata, 1)
write(path, text)
