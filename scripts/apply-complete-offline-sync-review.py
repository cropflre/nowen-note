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
        raise SystemExit(f"{path}: expected one marker, found {count}: {old[:140]!r}")
    write(path, text.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str) -> None:
    text = read(path)
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{path}: expected one regex match, found {count}: {pattern[:140]!r}")
    write(path, next_text)


# ---------------------------------------------------------------------------
# IndexedDB: strict writes and persistent attachment retry jobs
# ---------------------------------------------------------------------------
replace_once(
    "frontend/src/lib/localStore.ts",
    '''export interface OfflineStorageStats {
  cachedNotes: number;''',
    '''export interface OfflineAttachmentJob {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  queuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
}

export interface OfflineStorageStats {
  cachedNotes: number;''',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    '''  offlineAttachments: {
    key: string;
    value: OfflineAttachmentRecord;
    indexes: {
      "by-note": string;
      "by-cached": number;
    };
  };
  meta: {''',
    '''  offlineAttachments: {
    key: string;
    value: OfflineAttachmentRecord;
    indexes: {
      "by-note": string;
      "by-cached": number;
    };
  };
  offlineAttachmentJobs: {
    key: string;
    value: OfflineAttachmentJob;
    indexes: {
      "by-note": string;
      "by-queued": number;
    };
  };
  meta: {''',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    '''        if (!db.objectStoreNames.contains("offlineAttachments")) {
          const store = db.createObjectStore("offlineAttachments", { keyPath: "id" });
          store.createIndex("by-note", "noteId");
          store.createIndex("by-cached", "cachedAt");
        }
        if (!db.objectStoreNames.contains("meta")) {''',
    '''        if (!db.objectStoreNames.contains("offlineAttachments")) {
          const store = db.createObjectStore("offlineAttachments", { keyPath: "id" });
          store.createIndex("by-note", "noteId");
          store.createIndex("by-cached", "cachedAt");
        }
        if (!db.objectStoreNames.contains("offlineAttachmentJobs")) {
          const store = db.createObjectStore("offlineAttachmentJobs", { keyPath: "id" });
          store.createIndex("by-note", "noteId");
          store.createIndex("by-queued", "queuedAt");
        }
        if (!db.objectStoreNames.contains("meta")) {''',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    '''    const transaction = db.transaction(["notebooks", "notes", "tags", "offlineAttachments", "meta"], "readwrite");
    await Promise.all([
      transaction.objectStore("notebooks").clear(),
      transaction.objectStore("notes").clear(),
      transaction.objectStore("tags").clear(),
      transaction.objectStore("offlineAttachments").clear(),
      transaction.objectStore("meta").clear(),
    ]);''',
    '''    const attachmentIds = (await db.getAllKeys("offlineAttachments")).map(String);
    const transaction = db.transaction(["notebooks", "notes", "tags", "offlineAttachments", "offlineAttachmentJobs", "meta"], "readwrite");
    await Promise.all([
      transaction.objectStore("notebooks").clear(),
      transaction.objectStore("notes").clear(),
      transaction.objectStore("tags").clear(),
      transaction.objectStore("offlineAttachments").clear(),
      transaction.objectStore("offlineAttachmentJobs").clear(),
      transaction.objectStore("meta").clear(),
    ]);
    dispatchOfflineAttachmentRemoval(attachmentIds);''',
)

strict_writes = r'''
/** Offline snapshot writes are strict: quota or transaction failures must stop cursor advancement. */
export async function putCompleteOfflineNote(note: CachedNote): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  const detailCached = note.__detailCached === true
    || (note.__detailCached !== false && typeof note.content === "string");
  await (await connection).put("notes", { ...note, __detailCached: detailCached });
}

export async function putCompleteOfflineNotebooks(notebooks: Notebook[]): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  const db = await connection;
  const transaction = db.transaction("notebooks", "readwrite");
  for (const notebook of notebooks) await transaction.store.put(notebook);
  await transaction.done;
}

export async function putCompleteOfflineTags(tags: Tag[]): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  const db = await connection;
  const transaction = db.transaction("tags", "readwrite");
  for (const tag of tags) await transaction.store.put(tag);
  await transaction.done;
}

'''
replace_once(
    "frontend/src/lib/localStore.ts",
    'function dispatchOfflineAttachmentRemoval(ids: readonly string[]): void {\n',
    strict_writes + 'function dispatchOfflineAttachmentRemoval(ids: readonly string[]): void {\n',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    '''export async function putOfflineAttachment(record: OfflineAttachmentRecord): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await safe(async () => {
    await (await connection).put("offlineAttachments", record);
  }, undefined, "putOfflineAttachment");
}''',
    '''export async function putOfflineAttachment(record: OfflineAttachmentRecord): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  await (await connection).put("offlineAttachments", record);
}''',
)

job_functions = r'''
export async function putOfflineAttachmentJob(job: OfflineAttachmentJob): Promise<void> {
  const connection = getDb();
  if (!connection) throw new Error("离线数据库尚未初始化");
  await (await connection).put("offlineAttachmentJobs", job);
}

export async function getAllOfflineAttachmentJobs(): Promise<OfflineAttachmentJob[]> {
  const connection = getDb();
  if (!connection) return [];
  return safe(
    async () => (await connection).getAllFromIndex("offlineAttachmentJobs", "by-queued"),
    [],
    "getAllOfflineAttachmentJobs",
  );
}

export async function deleteOfflineAttachmentJob(id: string): Promise<void> {
  const connection = getDb();
  if (!connection) return;
  await (await connection).delete("offlineAttachmentJobs", id);
}

export async function deleteOfflineAttachmentJobsByNote(noteId: string): Promise<string[]> {
  const connection = getDb();
  if (!connection) return [];
  const db = await connection;
  const jobs = await db.getAllFromIndex("offlineAttachmentJobs", "by-note", noteId);
  if (jobs.length === 0) return [];
  const transaction = db.transaction("offlineAttachmentJobs", "readwrite");
  for (const job of jobs) await transaction.store.delete(job.id);
  await transaction.done;
  return jobs.map((job) => job.id);
}

export async function reconcileOfflineAttachmentJobs(
  noteId: string,
  keepIds: ReadonlySet<string>,
): Promise<string[]> {
  const connection = getDb();
  if (!connection) return [];
  const db = await connection;
  const jobs = await db.getAllFromIndex("offlineAttachmentJobs", "by-note", noteId);
  const removed = jobs.filter((job) => !keepIds.has(job.id));
  if (removed.length === 0) return [];
  const transaction = db.transaction("offlineAttachmentJobs", "readwrite");
  for (const job of removed) await transaction.store.delete(job.id);
  await transaction.done;
  return removed.map((job) => job.id);
}

'''
replace_once(
    "frontend/src/lib/localStore.ts",
    'export async function getOfflineAttachment(id: string): Promise<OfflineAttachmentRecord | undefined> {\n',
    job_functions + 'export async function getOfflineAttachment(id: string): Promise<OfflineAttachmentRecord | undefined> {\n',
)
replace_once(
    "frontend/src/lib/localStore.ts",
    '''  for (const noteId of deleteNoteIds) {
    removedAttachmentIds.push(...await deleteOfflineAttachmentsByNote(noteId));
    await deleteNote(noteId);
  }''',
    '''  for (const noteId of deleteNoteIds) {
    removedAttachmentIds.push(...await deleteOfflineAttachmentsByNote(noteId));
    await deleteOfflineAttachmentJobsByNote(noteId);
    await deleteNote(noteId);
  }''',
)

# ---------------------------------------------------------------------------
# Scope-aware ordinary cache fallback (prevents one workspace wiping another)
# ---------------------------------------------------------------------------
replace_once(
    "frontend/src/lib/offlineRead.ts",
    '''export function readNotebooks(online: () => Promise<Notebook[]>): Promise<Notebook[]> {
  return withFallback(online, () => getAllNotebooks());
}''',
    '''function activeWorkspaceId(): string | null {
  try {
    const workspace = localStorage.getItem("nowen-current-workspace") || "personal";
    return workspace === "personal" ? null : workspace;
  } catch {
    return null;
  }
}

function matchesActiveWorkspace(value: { workspaceId?: string | null }): boolean {
  return (value.workspaceId ?? null) === activeWorkspaceId();
}

export function readNotebooks(online: () => Promise<Notebook[]>): Promise<Notebook[]> {
  return withFallback(online, async () => (await getAllNotebooks()).filter(matchesActiveWorkspace));
}''',
)
replace_once(
    "frontend/src/lib/offlineRead.ts",
    '''export function readTags(online: () => Promise<Tag[]>): Promise<Tag[]> {
  return withFallback(online, () => getAllTags());
}''',
    '''export function readTags(online: () => Promise<Tag[]>): Promise<Tag[]> {
  return withFallback(online, async () => (await getAllTags()).filter(matchesActiveWorkspace));
}''',
)

replace_once(
    "frontend/src/lib/syncEngine.ts",
    'import { api } from "@/lib/api";\n',
    'import { api, getCurrentWorkspace } from "@/lib/api";\n',
)
replace_once(
    "frontend/src/lib/syncEngine.ts",
    '''async function pullServerSnapshot(): Promise<void> {
  const [notebooksResult, notesResult, tagsResult] = await Promise.allSettled([''',
    '''async function pullServerSnapshot(): Promise<void> {
  const currentWorkspace = getCurrentWorkspace();
  const currentWorkspaceId = currentWorkspace === "personal" ? null : currentWorkspace;
  const isCurrentScope = (value: { workspaceId?: string | null }) =>
    (value.workspaceId ?? null) === currentWorkspaceId;
  const [notebooksResult, notesResult, tagsResult] = await Promise.allSettled([''',
)
replace_once(
    "frontend/src/lib/syncEngine.ts",
    '''    const local = await getAllNotebooks();
    const remoteIds = new Set(notebooksResult.value.map((notebook) => notebook.id));
    for (const notebook of local) {''',
    '''    const local = (await getAllNotebooks()).filter(isCurrentScope);
    const remoteIds = new Set(notebooksResult.value.map((notebook) => notebook.id));
    for (const notebook of local) {''',
)
replace_once(
    "frontend/src/lib/syncEngine.ts",
    '''    const local = await getAllNotes();
    // 兼容修复前遗留状态：''',
    '''    const local = (await getAllNotes()).filter(isCurrentScope);
    // 兼容修复前遗留状态：''',
)
replace_once(
    "frontend/src/lib/syncEngine.ts",
    '''    const local = await getAllTags();
    const remoteIds = new Set(tagsResult.value.map((tag) => tag.id));''',
    '''    const local = (await getAllTags()).filter(isCurrentScope);
    const remoteIds = new Set(tagsResult.value.map((tag) => tag.id));''',
)

# ---------------------------------------------------------------------------
# Client engine: durable jobs, strict snapshot writes, policy reset and races
# ---------------------------------------------------------------------------
path = "frontend/src/lib/offlineWorkspaceSync.ts"
text = read(path)
text = text.replace(
    '''  clearOfflineScope,
  deleteOfflineAttachmentsByNote,
  evictOfflineAttachmentsToFit,
  getMeta,
  getOfflineAttachment,
  getOfflineStorageStats,
  putNote,
  putNotebooks,
  putOfflineAttachment,
  putTags,
  reconcileOfflineAttachments,
  reconcileOfflineScope,
  setMeta,
  type CachedNote,
  type OfflineAttachmentRecord,
  type OfflineStorageStats,''',
    '''  clearOfflineScope,
  deleteOfflineAttachmentJob,
  deleteOfflineAttachmentsByNote,
  evictOfflineAttachmentsToFit,
  getAllOfflineAttachmentJobs,
  getMeta,
  getOfflineAttachment,
  getOfflineStorageStats,
  putCompleteOfflineNote,
  putCompleteOfflineNotebooks,
  putCompleteOfflineTags,
  putOfflineAttachment,
  putOfflineAttachmentJob,
  reconcileOfflineAttachmentJobs,
  reconcileOfflineAttachments,
  reconcileOfflineScope,
  setMeta,
  type CachedNote,
  type OfflineAttachmentJob,
  type OfflineAttachmentRecord,
  type OfflineStorageStats,''',
)
text = text.replace(
    'const FINGERPRINT_PREFIX = "offlineWorkspaceSync:fingerprint:";\n',
    'const FINGERPRINT_PREFIX = "offlineWorkspaceSync:fingerprint:";\nconst POLICY_PREFIX = "offlineWorkspaceSync:policy:";\n',
)
# Load visible status after user identity switches.
text = text.replace(
    '''  emit({
    state: "idle",
    scopeKey: null,''',
    '''  emit({
    state: "idle",
    scopeKey: null,''',
    1,
)
marker = '''    lastError: null,
  });
}

export function getOfflineSyncSettings'''
replacement = '''    lastError: null,
  });
  if (userId) {
    void Promise.all([getMeta<number>(LAST_RUN_META), getOfflineStorageStats()]).then(([lastSyncAt, storage]) => {
      if (activeUserId === userId) emit({ lastSyncAt: Number(lastSyncAt || 0) || null, storage });
    }).catch(() => {});
  }
}

export function getOfflineSyncSettings'''
if text.count(marker) != 1:
    raise SystemExit("offlineWorkspaceSync: user status marker missing")
text = text.replace(marker, replacement, 1)
# Strict metadata writes.
text = text.replace("await putNotebooks(plan.notebooks);", "await putCompleteOfflineNotebooks(plan.notebooks);")
text = text.replace("await putTags(plan.tags);", "await putCompleteOfflineTags(plan.tags);")
# Correct attachment cap projection when replacing an existing blob.
old_cap = '''  if (settings.maxAttachmentBytes > 0) {
    const storage = await getOfflineStorageStats();
    if (attachment.size > settings.maxAttachmentBytes) return "skipped";
    const required = Math.max(0, storage.attachmentBytes + attachment.size - settings.maxAttachmentBytes);
    if (required > 0) {
      await evictOfflineAttachmentsToFit(required, new Set([attachment.id]));
    }
  }'''
new_cap = '''  if (settings.maxAttachmentBytes > 0) {
    const storage = await getOfflineStorageStats();
    if (attachment.size > settings.maxAttachmentBytes) return "skipped";
    const projected = storage.attachmentBytes - Number(existing?.size || 0) + attachment.size;
    const required = Math.max(0, projected - settings.maxAttachmentBytes);
    if (required > 0) await evictOfflineAttachmentsToFit(required, new Set([attachment.id]));
    const afterEviction = await getOfflineStorageStats();
    const finalProjected = afterEviction.attachmentBytes - Number(existing?.size || 0) + attachment.size;
    if (finalProjected > settings.maxAttachmentBytes) return "skipped";
  }'''
if text.count(old_cap) != 1:
    raise SystemExit("offlineWorkspaceSync: cap marker missing")
text = text.replace(old_cap, new_cap, 1)

new_attachment_block = r'''async function queueBundleAttachments(
  bundle: NoteBundle,
  settings: OfflineSyncSettings,
): Promise<void> {
  const desired = bundle.attachmentDownloadAllowed
    ? bundle.attachments.filter((attachment) => isOfflineAttachmentWanted(attachment, settings))
    : [];
  const keepIds = new Set(desired.map((item) => item.id));
  await reconcileOfflineAttachments(bundle.note.id, keepIds);
  await reconcileOfflineAttachmentJobs(bundle.note.id, keepIds);

  for (const attachment of desired) {
    const existing = await getOfflineAttachment(attachment.id);
    const current = !!existing
      && existing.size === attachment.size
      && existing.mimeType === attachment.mimeType
      && existing.filename === attachment.filename;
    if (current) {
      await deleteOfflineAttachmentJob(attachment.id);
      continue;
    }
    const prior = (await getAllOfflineAttachmentJobs()).find((job) => job.id === attachment.id);
    await putOfflineAttachmentJob({
      ...attachment,
      queuedAt: prior?.queuedAt || Date.now(),
      retryCount: prior?.retryCount || 0,
      lastAttemptAt: prior?.lastAttemptAt,
      lastError: prior?.lastError,
    });
  }
}

async function applyBundle(
  bundle: NoteBundle,
  settings: OfflineSyncSettings,
  signal: AbortSignal,
  queuedNoteIds: Set<string>,
): Promise<void> {
  if (signal.aborted) throw new DOMException("Sync aborted", "AbortError");
  if (!queuedNoteIds.has(bundle.note.id)) {
    await putCompleteOfflineNote({ ...bundle.note, __detailCached: true } as CachedNote);
    if (signal.aborted) throw new DOMException("Sync aborted", "AbortError");
    await queueBundleAttachments(bundle, settings);
  }
  emit({ completedNotes: progress.completedNotes + 1 });
}

async function processPendingAttachmentJobs(
  settings: OfflineSyncSettings,
  signal: AbortSignal,
): Promise<{ remaining: number; deferredForNetwork: boolean }> {
  const jobs = await getAllOfflineAttachmentJobs();
  if (jobs.length === 0) return { remaining: 0, deferredForNetwork: false };
  const totalBytes = jobs.reduce((sum, job) => sum + Number(job.size || 0), 0);
  emit({
    state: "downloading-attachments",
    completedAttachments: 0,
    totalAttachments: jobs.length,
    downloadedBytes: 0,
    totalAttachmentBytes: totalBytes,
    failedAttachments: 0,
  });

  if (!connectionAllowsLargeDownloads(settings)) {
    return { remaining: jobs.length, deferredForNetwork: true };
  }

  await runPool(jobs, async (job) => {
    if (signal.aborted) throw new DOMException("Sync aborted", "AbortError");
    try {
      const result = await cacheAttachment(job, settings, signal);
      if (result === "skipped") throw new Error("附件超过本机缓存上限");
      await deleteOfflineAttachmentJob(job.id);
      emit({
        completedAttachments: progress.completedAttachments + 1,
        downloadedBytes: progress.downloadedBytes + (result === "cached" ? job.size : 0),
      });
    } catch (error) {
      if ((error as { name?: string })?.name === "AbortError") throw error;
      const message = error instanceof Error ? error.message : String(error);
      await putOfflineAttachmentJob({
        ...job,
        retryCount: job.retryCount + 1,
        lastAttemptAt: Date.now(),
        lastError: message,
      });
      emit({
        completedAttachments: progress.completedAttachments + 1,
        failedAttachments: progress.failedAttachments + 1,
      });
    }
  }, ATTACHMENT_CONCURRENCY);

  return { remaining: (await getAllOfflineAttachmentJobs()).length, deferredForNetwork: false };
}

'''
pattern = r'async function syncBundleAttachments\(.*?\nasync function ackScope\('
match = re.search(pattern, text, flags=re.S)
if not match:
    raise SystemExit("offlineWorkspaceSync: attachment/apply block missing")
text = text[:match.start()] + new_attachment_block + 'async function ackScope(' + text[match.end():]
# Snapshot totals are based on actual persistent jobs after policy filtering.
text = text.replace(
    '''    completedAttachments: 0,
    totalAttachments: plan.attachmentCount,
    downloadedBytes: 0,
    totalAttachmentBytes: plan.attachmentBytes,''',
    '''    completedAttachments: 0,
    totalAttachments: 0,
    downloadedBytes: 0,
    totalAttachmentBytes: 0,''',
)
text = text.replace(
    '''      if (bundle.attachments.some((attachment) => isOfflineAttachmentWanted(attachment, settings))) {
        emit({ state: "downloading-attachments" });
      }
      await applyBundle(bundle, settings, signal, queuedNoteIds);
      emit({ state: "downloading-notes" });''',
    '''      await applyBundle(bundle, settings, signal, queuedNoteIds);
      emit({ state: "downloading-notes" });''',
)
# Attachment policy changes require a manifest pass even when note versions did not change.
text = text.replace(
    '''  const snapshotComplete = Boolean(await getMeta<boolean>(`${SNAPSHOT_COMPLETE_PREFIX}${target.scopeKey}`));
  const fingerprint = await getMeta<string>(`${FINGERPRINT_PREFIX}${target.scopeKey}`);
  let sequence = storedSequence;
  const requiresSnapshot = !snapshotComplete
    || plan.resetRequired
    || fingerprint !== plan.accessFingerprint;''',
    '''  const snapshotComplete = Boolean(await getMeta<boolean>(`${SNAPSHOT_COMPLETE_PREFIX}${target.scopeKey}`));
  const fingerprint = await getMeta<string>(`${FINGERPRINT_PREFIX}${target.scopeKey}`);
  const policy = `${settings.attachmentMode}:${settings.workspaceMode}:${settings.workspaceIds.slice().sort().join(",")}`;
  const storedPolicy = await getMeta<string>(`${POLICY_PREFIX}${target.scopeKey}`);
  let sequence = storedSequence;
  const requiresSnapshot = !snapshotComplete
    || plan.resetRequired
    || fingerprint !== plan.accessFingerprint
    || storedPolicy !== policy;''',
)
text = text.replace(
    '''  await setMeta(`${FINGERPRINT_PREFIX}${target.scopeKey}`, plan.accessFingerprint);
  await setMeta(`${SEQUENCE_PREFIX}${target.scopeKey}`, sequence);
  await ackScope(target.scopeKey, sequence, signal);''',
    '''  await setMeta(`${FINGERPRINT_PREFIX}${target.scopeKey}`, plan.accessFingerprint);
  await setMeta(`${POLICY_PREFIX}${target.scopeKey}`, policy);
  await setMeta(`${SEQUENCE_PREFIX}${target.scopeKey}`, sequence);
  await ackScope(target.scopeKey, sequence, signal);''',
)
# Process durable attachment jobs after all note scopes are consistent.
old_targets_loop = '''    for (const target of targets) {
      if (signal.aborted) throw new DOMException("Sync aborted", "AbortError");
      await syncTarget(target, settings, signal, queuedNoteIds);
    }
    const now = Date.now();'''
new_targets_loop = '''    for (const target of targets) {
      if (signal.aborted) throw new DOMException("Sync aborted", "AbortError");
      await syncTarget(target, settings, signal, queuedNoteIds);
    }
    const attachmentResult = await processPendingAttachmentJobs(settings, signal);
    const now = Date.now();'''
if text.count(old_targets_loop) != 1:
    raise SystemExit("offlineWorkspaceSync: target loop marker missing")
text = text.replace(old_targets_loop, new_targets_loop, 1)
text = text.replace(
    '''      lastError: progress.failedAttachments > 0
        ? `${progress.failedAttachments} 个附件暂未下载，将在下次同步时重试。`
        : null,''',
    '''      lastError: attachmentResult.deferredForNetwork
        ? `${attachmentResult.remaining} 个附件正在等待 Wi-Fi / 有线网络。`
        : attachmentResult.remaining > 0
          ? `${attachmentResult.remaining} 个附件暂未下载，任务已保留并会自动重试。`
          : null,''',
)
# Abort does not clear the single-flight promise until its finally block has exited.
text = text.replace(
    '''export function stopOfflineWorkspaceSync(): void {
  activeController?.abort();
  activeController = null;
  activePromise = null;
}''',
    '''export function stopOfflineWorkspaceSync(): void {
  activeController?.abort();
  activeController = null;
}''',
)
write(path, text)

# ---------------------------------------------------------------------------
# Settings behavior: stop disabled sync, auto-apply policy, pause while idle
# ---------------------------------------------------------------------------
replace_once(
    "frontend/src/components/settings/OfflineSyncSettings.tsx",
    '''  setOfflineSyncSettings,
  subscribeOfflineSyncProgress,
  syncOfflineWorkspace,''',
    '''  setOfflineSyncSettings,
  stopOfflineWorkspaceSync,
  subscribeOfflineSyncProgress,
  syncOfflineWorkspace,''',
)
replace_once(
    "frontend/src/components/settings/OfflineSyncSettings.tsx",
    '''  const toggleEnabled = (enabled: boolean) => {
    const next = update({ enabled, paused: enabled ? false : settings.paused });
    if (next.enabled) void syncOfflineWorkspace({ force: true, reason: "settings" });
  };''',
    '''  const toggleEnabled = (enabled: boolean) => {
    const next = update({ enabled, paused: enabled ? false : settings.paused });
    if (next.enabled) void syncOfflineWorkspace({ force: true, reason: "settings" });
    else stopOfflineWorkspaceSync();
  };''',
)
replace_once(
    "frontend/src/components/settings/OfflineSyncSettings.tsx",
    '''  const selectedWorkspaceSet = useMemo(() => new Set(settings.workspaceIds), [settings.workspaceIds]);

  const update =''',
    '''  const selectedWorkspaceSet = useMemo(() => new Set(settings.workspaceIds), [settings.workspaceIds]);

  useEffect(() => {
    if (!settings.enabled || settings.paused) return;
    const timer = window.setTimeout(() => {
      void syncOfflineWorkspace({ force: true, reason: "settings" });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    settings.attachmentMode,
    settings.maxAttachmentBytes,
    settings.wifiOnly,
    settings.workspaceIds,
    settings.workspaceMode,
    settings.enabled,
    settings.paused,
  ]);

  const update =''',
)
replace_once(
    "frontend/src/components/settings/OfflineSyncSettings.tsx",
    '''    if (!ok) return;
    await clearAllOfflineWorkspaceData();''',
    '''    if (!ok) return;
    setSettings(setOfflineSyncSettings({ enabled: false, paused: false }));
    await clearAllOfflineWorkspaceData();''',
)
replace_once(
    "frontend/src/components/settings/OfflineSyncSettings.tsx",
    'disabled={!settings.enabled || !busy}\n                onClick={() => {\n                  const next = pauseOfflineWorkspaceSync();',
    'disabled={!settings.enabled}\n                onClick={() => {\n                  const next = pauseOfflineWorkspaceSync();',
)

# ---------------------------------------------------------------------------
# Backend scale: SQL-scoped note reads and page-batched tags/attachments
# ---------------------------------------------------------------------------
path = "backend/src/routes/offline-sync.ts"
text = read(path)

new_personal = r'''function personalNotebookAccess(db: Database.Database, userId: string): {
  rows: NotebookRow[];
  ids: Set<string>;
  fingerprintParts: string[];
} {
  const members = db.prepare(`
    SELECT notebookId, role, allowDownload, allowReshare, status, updatedAt
    FROM notebook_members
    WHERE userId = ? AND status != 'removed'
    ORDER BY notebookId ASC
  `).all(userId) as Array<{
    notebookId: string;
    role: string;
    allowDownload: number;
    allowReshare: number;
    status: string;
    updatedAt: string;
  }>;

  const rows = db.prepare(`
    WITH RECURSIVE accessible(id) AS (
      SELECT id FROM notebooks
      WHERE workspaceId IS NULL
        AND (userId = ? OR id IN (
          SELECT notebookId FROM notebook_members
          WHERE userId = ? AND status != 'removed'
        ))
      UNION
      SELECT child.id
      FROM notebooks child
      INNER JOIN accessible parent ON child.parentId = parent.id
      WHERE child.workspaceId IS NULL
    )
    SELECT n.id, n.userId, n.workspaceId, n.parentId, n.name, n.description,
           n.icon, n.color, n.sortOrder, n.isExpanded, n.isDeleted,
           n.deletedAt, n.createdAt, n.updatedAt
    FROM notebooks n
    INNER JOIN accessible a ON a.id = n.id
    ORDER BY n.id ASC
  `).all(userId, userId) as NotebookRow[];
  const ids = new Set(rows.map((row) => row.id));
  const fingerprintParts = [
    ...rows.map((row) => `n:${row.id}:${row.parentId || ""}:${row.userId}:${row.updatedAt}:${row.isDeleted || 0}`),
    ...members.map((member) =>
      `m:${member.notebookId}:${member.role}:${member.allowDownload}:${member.allowReshare}:${member.updatedAt}`,
    ),
  ];
  return { rows, ids, fingerprintParts };
}

'''
text, count = re.subn(
    r'function personalNotebookAccess\(.*?\nfunction workspaceNotebookAccess\(',
    new_personal + 'function workspaceNotebookAccess(',
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit("offline-sync route: personal access block missing")

# No separate note-level grants exist; filtering by owner + inherited notebook access is exact and avoids N+1 ACL lookups.
text = text.replace(
    '''  if (note.userId === userId || notebookIds.has(note.notebookId)) return true;
  return resolveEffectiveNoteCapabilities(note.id, userId).read;''',
    '''  return note.userId === userId || notebookIds.has(note.notebookId);''',
)

new_note_access = r'''function personalNoteAccess(
  userId: string,
  notebookIds: Set<string>,
  alias = "n",
): { clause: string; params: unknown[] } {
  const ids = [...notebookIds];
  const notebookClause = ids.length > 0
    ? ` OR ${alias}.notebookId IN (${ids.map(() => "?").join(",")})`
    : "";
  return {
    clause: `${alias}.workspaceId IS NULL AND (${alias}.userId = ?${notebookClause})`,
    params: [userId, ...ids],
  };
}

function listAllAccessibleNotes(
  db: Database.Database,
  userId: string,
  scope: SyncScope,
  notebookIds: Set<string>,
): NoteRow[] {
  if (scope.workspaceId) {
    return db.prepare(`${noteSelectSql()} WHERE n.workspaceId = ? ORDER BY n.id ASC`)
      .all(userId, scope.workspaceId) as NoteRow[];
  }
  const access = personalNoteAccess(userId, notebookIds);
  return db.prepare(`${noteSelectSql()} WHERE ${access.clause} ORDER BY n.id ASC`)
    .all(userId, ...access.params) as NoteRow[];
}

function listSnapshotPage(
  db: Database.Database,
  userId: string,
  scope: SyncScope,
  notebookIds: Set<string>,
  cursor: string,
  limit: number,
): { rows: NoteRow[]; hasMore: boolean; nextCursor: string | null } {
  const target = limit + 1;
  const rows = scope.workspaceId
    ? db.prepare(`${noteSelectSql()} WHERE n.workspaceId = ? AND n.id > ? ORDER BY n.id ASC LIMIT ?`)
        .all(userId, scope.workspaceId, cursor, target) as NoteRow[]
    : (() => {
        const access = personalNoteAccess(userId, notebookIds);
        return db.prepare(`${noteSelectSql()} WHERE ${access.clause} AND n.id > ? ORDER BY n.id ASC LIMIT ?`)
          .all(userId, ...access.params, cursor, target) as NoteRow[];
      })();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    rows: page,
    hasMore,
    nextCursor: hasMore && page.length > 0 ? page[page.length - 1].id : null,
  };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function attachmentMapForNotes(db: Database.Database, noteIds: string[]): Map<string, AttachmentRow[]> {
  const result = new Map<string, AttachmentRow[]>();
  for (const batch of chunks(noteIds, 400)) {
    if (batch.length === 0) continue;
    const rows = db.prepare(`
      SELECT id, noteId, filename, mimeType, size, createdAt
      FROM attachments
      WHERE noteId IN (${batch.map(() => "?").join(",")})
      ORDER BY noteId ASC, id ASC
    `).all(...batch) as AttachmentRow[];
    for (const row of rows) {
      const list = result.get(row.noteId) || [];
      list.push(row);
      result.set(row.noteId, list);
    }
  }
  return result;
}

function tagMapForNotes(db: Database.Database, noteIds: string[]): Map<string, any[]> {
  const result = new Map<string, any[]>();
  for (const batch of chunks(noteIds, 400)) {
    if (batch.length === 0) continue;
    const rows = db.prepare(`
      SELECT nt.noteId AS linkedNoteId, t.*
      FROM note_tags nt
      INNER JOIN tags t ON t.id = nt.tagId
      WHERE nt.noteId IN (${batch.map(() => "?").join(",")})
      ORDER BY nt.noteId ASC, t.name COLLATE NOCASE ASC, t.id ASC
    `).all(...batch) as Array<any & { linkedNoteId: string }>;
    for (const row of rows) {
      const { linkedNoteId, ...tag } = row;
      const list = result.get(linkedNoteId) || [];
      list.push(tag);
      result.set(linkedNoteId, list);
    }
  }
  return result;
}

function buildBundles(db: Database.Database, userId: string, notes: NoteRow[]) {
  const noteIds = notes.map((note) => note.id);
  const attachmentsByNote = attachmentMapForNotes(db, noteIds);
  const tagsByNote = tagMapForNotes(db, noteIds);
  return notes.map((note) => {
    const allAttachments = attachmentsByNote.get(note.id) || [];
    const downloadAllowed = allAttachments.length === 0
      || Boolean(resolveEffectiveNoteCapabilities(note.id, userId).download);
    const attachments = downloadAllowed ? allAttachments : [];
    return {
      note: { ...note, tags: tagsByNote.get(note.id) || [] },
      attachments,
      attachmentDownloadAllowed: downloadAllowed,
      attachmentBytes: attachments.reduce((sum, attachment) => sum + Number(attachment.size || 0), 0),
      rawAttachmentCount: allAttachments.length,
    };
  });
}

'''
text, count = re.subn(
    r'function listAllAccessibleNotes\(.*?\nfunction listTagsForScope\(',
    new_note_access + 'function listTagsForScope(',
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit("offline-sync route: note listing/build bundle block missing")

# Fingerprint already captures notebooks, memberships and workspace role; note mutations are in the sequence log.
text, count = re.subn(
    r'  const accessFingerprint = createHash\("sha256"\).*?\.digest\("hex"\);\n  const after =',
    '  const accessFingerprint = access.accessFingerprint;\n  const after =',
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise SystemExit("offline-sync route: plan fingerprint block missing")

# Replace per-note attachment count queries with page-batched manifests.
old_plan_loop = re.search(
    r'  let attachmentCount = 0;.*?\n\n  return c\.json\(\{',
    text,
    flags=re.S,
)
if not old_plan_loop:
    raise SystemExit("offline-sync route: plan attachment loop missing")
new_plan_loop = '''  let attachmentCount = 0;
  let attachmentBytes = 0;
  let attachmentForbiddenNotes = 0;
  for (const batch of chunks(notes, 200)) {
    for (const bundle of buildBundles(db, userId, batch)) {
      if (bundle.rawAttachmentCount > 0 && !bundle.attachmentDownloadAllowed) {
        attachmentForbiddenNotes += 1;
        continue;
      }
      attachmentCount += bundle.attachments.length;
      attachmentBytes += bundle.attachmentBytes;
    }
  }

  return c.json({'''
text = text[:old_plan_loop.start()] + new_plan_loop + text[old_plan_loop.end():]
text = text.replace(
    '    items: page.rows.map((note) => buildBundle(db, userId, note)),\n',
    '    items: buildBundles(db, userId, page.rows).map(({ rawAttachmentCount: _raw, ...bundle }) => bundle),\n',
)
# Change page fetches all current note bodies and manifests in batches.
old_change_items = re.search(
    r'  const items: any\[\] = \[\];\n  for \(const \[noteId, change\] of latestByNote\.entries\(\)\) \{.*?\n  items\.sort',
    text,
    flags=re.S,
)
if not old_change_items:
    raise SystemExit("offline-sync route: change item block missing")
candidate_block = '''  const candidateIds = [...latestByNote.keys()];
  const currentNotes: NoteRow[] = [];
  for (const batch of chunks(candidateIds, 400)) {
    if (batch.length === 0) continue;
    currentNotes.push(...db.prepare(`${noteSelectSql()} WHERE n.id IN (${batch.map(() => "?").join(",")})`)
      .all(userId, ...batch) as NoteRow[]);
  }
  const bundles = new Map(
    buildBundles(db, userId, currentNotes)
      .map(({ rawAttachmentCount: _raw, ...bundle }) => [bundle.note.id, bundle] as const),
  );
  const items: any[] = [];
  for (const [noteId, change] of latestByNote.entries()) {
    const bundle = bundles.get(noteId);
    if (bundle && noteIsInScope(bundle.note, userId, scope, access.ids)) {
      items.push({ sequence: change.sequence, operation: "upsert", ...bundle });
    } else {
      items.push({ sequence: change.sequence, operation: "delete", noteId });
    }
  }
  items.sort'''
text = text[:old_change_items.start()] + candidate_block + text[old_change_items.end():]
# Advance across unrelated global changes when this scope returned fewer than a full page.
text = text.replace(
    '  const nextSequence = raw.length > 0 ? raw[raw.length - 1].sequence : serverSequence;\n',
    '  const nextSequence = raw.length < limit ? serverSequence : raw[raw.length - 1].sequence;\n',
)
write(path, text)
