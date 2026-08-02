import { api, getBaseUrl, getServerUrl } from "@/lib/api";
import {
  clearOfflineScope,
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
  type OfflineStorageStats,
} from "@/lib/localStore";
import { getQueue } from "@/lib/offlineQueue";
import type { Note, Notebook, Tag, Workspace } from "@/types";

export type OfflineAttachmentMode = "none" | "images" | "all";
export type OfflineWorkspaceMode = "all" | "selected";
export type OfflineSyncState =
  | "idle"
  | "planning"
  | "downloading-notes"
  | "downloading-attachments"
  | "applying-changes"
  | "ready"
  | "paused"
  | "error";

export interface OfflineSyncSettings {
  enabled: boolean;
  workspaceMode: OfflineWorkspaceMode;
  workspaceIds: string[];
  attachmentMode: OfflineAttachmentMode;
  wifiOnly: boolean;
  /** 0 means unlimited. Note bodies are never evicted; this cap applies to attachment blobs. */
  maxAttachmentBytes: number;
  intervalMinutes: number;
  paused: boolean;
}

export interface OfflineSyncProgress {
  state: OfflineSyncState;
  scopeKey: string | null;
  scopeLabel: string | null;
  completedNotes: number;
  totalNotes: number;
  completedAttachments: number;
  totalAttachments: number;
  downloadedBytes: number;
  totalAttachmentBytes: number;
  failedAttachments: number;
  lastSyncAt: number | null;
  lastError: string | null;
  storage: OfflineStorageStats | null;
}

interface SyncScopeTarget {
  scopeKey: string;
  label: string;
  workspaceId: string | null;
}

interface AttachmentManifest {
  id: string;
  noteId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

interface NoteBundle {
  note: Note;
  attachments: AttachmentManifest[];
  attachmentDownloadAllowed: boolean;
  attachmentBytes: number;
}

interface SyncPlan {
  scopeKey: string;
  workspaceId: string | null;
  serverSequence: number;
  minAvailableSequence: number;
  resetRequired: boolean;
  accessFingerprint: string;
  noteCount: number;
  attachmentCount: number;
  attachmentBytes: number;
  attachmentForbiddenNotes: number;
  notebooks: Notebook[];
  tags: Tag[];
}

interface SnapshotPage {
  scopeKey: string;
  snapshotSequence: number;
  items: NoteBundle[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface ChangeUpsert extends NoteBundle {
  sequence: number;
  operation: "upsert";
}

interface ChangeDelete {
  sequence: number;
  operation: "delete";
  noteId: string;
}

interface ChangePage {
  scopeKey: string;
  resetRequired: boolean;
  minAvailableSequence: number;
  serverSequence: number;
  nextSequence: number;
  hasMore: boolean;
  items: Array<ChangeUpsert | ChangeDelete>;
}

interface SyncOptions {
  force?: boolean;
  reason?: "bootstrap" | "manual" | "network" | "interval" | "settings";
}

const SETTINGS_KEY_PREFIX = "nowen-offline-workspace-settings:v1";
const CLIENT_ID_KEY_PREFIX = "nowen-offline-workspace-client:v1";
const KNOWN_SCOPES_META = "offlineWorkspaceSync:knownScopes";
const LAST_RUN_META = "offlineWorkspaceSync:lastRunAt";
const SNAPSHOT_COMPLETE_PREFIX = "offlineWorkspaceSync:snapshotComplete:";
const SEQUENCE_PREFIX = "offlineWorkspaceSync:sequence:";
const FINGERPRINT_PREFIX = "offlineWorkspaceSync:fingerprint:";
const POLICY_PREFIX = "offlineWorkspaceSync:policy:";
const API_TIMEOUT_MS = 90_000;
const ATTACHMENT_CONCURRENCY = 3;
const DEFAULT_ATTACHMENT_LIMIT = 5 * 1024 * 1024 * 1024;

let activeUserId: string | null = null;
let activePromise: Promise<OfflineSyncProgress> | null = null;
let activeController: AbortController | null = null;
let progress: OfflineSyncProgress = {
  state: "idle",
  scopeKey: null,
  scopeLabel: null,
  completedNotes: 0,
  totalNotes: 0,
  completedAttachments: 0,
  totalAttachments: 0,
  downloadedBytes: 0,
  totalAttachmentBytes: 0,
  failedAttachments: 0,
  lastSyncAt: null,
  lastError: null,
  storage: null,
};
const listeners = new Set<(value: OfflineSyncProgress) => void>();

function emit(patch: Partial<OfflineSyncProgress>): void {
  progress = { ...progress, ...patch };
  const snapshot = { ...progress };
  for (const listener of listeners) {
    try { listener(snapshot); } catch { /* isolate UI listeners */ }
  }
}

function normalizedServerIdentity(): string {
  const server = getServerUrl().replace(/\/+$/, "").toLowerCase();
  if (server) return server;
  if (typeof window !== "undefined" && window.location.origin.startsWith("http")) {
    return window.location.origin.replace(/\/+$/, "").toLowerCase();
  }
  return "same-origin";
}

function identitySuffix(): string {
  return encodeURIComponent(`${normalizedServerIdentity()}|${activeUserId || "anonymous"}`);
}

function isLoopbackServer(): boolean {
  const server = getServerUrl();
  if (!server) return false;
  try {
    const url = new URL(server);
    return url.hostname === "localhost" || (url.hostname === "::1" || url.hostname === "[::1]") || url.hostname.startsWith("127.");
  } catch {
    return false;
  }
}

function isNativeRemoteClient(): boolean {
  if (typeof window === "undefined") return false;
  const desktop = Boolean((window as any).nowenDesktop?.isDesktop);
  const capacitor = Boolean((window as any).Capacitor?.isNativePlatform?.())
    || Boolean((window as any).Capacitor?.platform && (window as any).Capacitor.platform !== "web");
  return (desktop || capacitor) && Boolean(getServerUrl()) && !isLoopbackServer();
}

function defaultSettings(): OfflineSyncSettings {
  const nativeRemote = isNativeRemoteClient();
  const mobile = typeof window !== "undefined"
    && Boolean((window as any).Capacitor?.isNativePlatform?.());
  return {
    enabled: nativeRemote,
    workspaceMode: "all",
    workspaceIds: [],
    attachmentMode: nativeRemote ? "all" : "images",
    wifiOnly: mobile,
    maxAttachmentBytes: DEFAULT_ATTACHMENT_LIMIT,
    intervalMinutes: 5,
    paused: false,
  };
}

export function normalizeOfflineSyncSettings(value: Partial<OfflineSyncSettings> | null | undefined): OfflineSyncSettings {
  const defaults = defaultSettings();
  const workspaceMode = value?.workspaceMode === "selected" ? "selected" : "all";
  const attachmentMode: OfflineAttachmentMode = value?.attachmentMode === "none"
    || value?.attachmentMode === "images"
    || value?.attachmentMode === "all"
    ? value.attachmentMode
    : defaults.attachmentMode;
  const maxAttachmentBytes = Number(value?.maxAttachmentBytes);
  const intervalMinutes = Number(value?.intervalMinutes);
  return {
    enabled: typeof value?.enabled === "boolean" ? value.enabled : defaults.enabled,
    workspaceMode,
    workspaceIds: Array.isArray(value?.workspaceIds)
      ? [...new Set(value!.workspaceIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : defaults.workspaceIds,
    attachmentMode,
    wifiOnly: typeof value?.wifiOnly === "boolean" ? value.wifiOnly : defaults.wifiOnly,
    maxAttachmentBytes: Number.isFinite(maxAttachmentBytes) && maxAttachmentBytes >= 0
      ? Math.floor(maxAttachmentBytes)
      : defaults.maxAttachmentBytes,
    intervalMinutes: Number.isFinite(intervalMinutes)
      ? Math.max(1, Math.min(1440, Math.floor(intervalMinutes)))
      : defaults.intervalMinutes,
    paused: typeof value?.paused === "boolean" ? value.paused : false,
  };
}

export function setOfflineSyncUser(userId: string | null): void {
  if (activeUserId === userId) return;
  stopOfflineWorkspaceSync();
  activeUserId = userId;
  emit({
    state: "idle",
    scopeKey: null,
    scopeLabel: null,
    completedNotes: 0,
    totalNotes: 0,
    completedAttachments: 0,
    totalAttachments: 0,
    downloadedBytes: 0,
    totalAttachmentBytes: 0,
    failedAttachments: 0,
    lastError: null,
  });
  if (userId) {
    void Promise.all([getMeta<number>(LAST_RUN_META), getOfflineStorageStats()]).then(([lastSyncAt, storage]) => {
      if (activeUserId === userId) emit({ lastSyncAt: Number(lastSyncAt || 0) || null, storage });
    }).catch(() => {});
  }
}

export function getOfflineSyncSettings(): OfflineSyncSettings {
  if (typeof localStorage === "undefined") return defaultSettings();
  try {
    const raw = localStorage.getItem(`${SETTINGS_KEY_PREFIX}:${identitySuffix()}`);
    return normalizeOfflineSyncSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultSettings();
  }
}

export function setOfflineSyncSettings(patch: Partial<OfflineSyncSettings>): OfflineSyncSettings {
  const next = normalizeOfflineSyncSettings({ ...getOfflineSyncSettings(), ...patch });
  try {
    localStorage.setItem(`${SETTINGS_KEY_PREFIX}:${identitySuffix()}`, JSON.stringify(next));
  } catch { /* storage may be disabled */ }
  emit({ state: next.paused ? "paused" : progress.state });
  return next;
}

export function getOfflineSyncProgress(): OfflineSyncProgress {
  return { ...progress };
}

export function subscribeOfflineSyncProgress(listener: (value: OfflineSyncProgress) => void): () => void {
  listeners.add(listener);
  listener({ ...progress });
  return () => { listeners.delete(listener); };
}

function generateClientId(): string {
  const randomUUID = typeof crypto !== "undefined" ? crypto.randomUUID?.bind(crypto) : undefined;
  return randomUUID ? randomUUID() : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getClientId(): string {
  const key = `${CLIENT_ID_KEY_PREFIX}:${identitySuffix()}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = generateClientId();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return generateClientId();
  }
}

function authHeaders(json = true): HeadersInit {
  const token = localStorage.getItem("nowen-token");
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function requestJson<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${getBaseUrl()}${path}`, {
      ...init,
      headers: { ...authHeaders(true), ...(init.headers || {}) },
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const error = new Error(payload?.error || `HTTP ${response.status}`) as Error & {
        status?: number;
        code?: string;
      };
      error.status = response.status;
      error.code = payload?.code;
      throw error;
    }
    return payload as T;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function scopeQuery(workspaceId: string | null): string {
  return workspaceId ? `workspaceId=${encodeURIComponent(workspaceId)}` : "workspaceId=personal";
}

async function resolveTargets(settings: OfflineSyncSettings): Promise<SyncScopeTarget[]> {
  const targets: SyncScopeTarget[] = [{ scopeKey: "personal", label: "个人空间", workspaceId: null }];
  const workspaces: Workspace[] = await api.getWorkspaces();
  const selected = settings.workspaceMode === "all"
    ? workspaces
    : workspaces.filter((workspace) => settings.workspaceIds.includes(workspace.id));
  for (const workspace of selected) {
    targets.push({
      scopeKey: `workspace:${workspace.id}`,
      label: workspace.name || "工作区",
      workspaceId: workspace.id,
    });
  }
  return targets;
}

function connectionAllowsLargeDownloads(settings: OfflineSyncSettings): boolean {
  if (!settings.wifiOnly) return true;
  const connection = (navigator as any).connection;
  if (!connection) return true;
  const type = String(connection.type || "").toLowerCase();
  if (type) return type === "wifi" || type === "ethernet";
  // Browsers that expose only effectiveType cannot reliably distinguish Wi-Fi
  // from cellular. saveData is the only safe negative signal in that model.
  return connection.saveData !== true;
}

export function isOfflineAttachmentWanted(attachment: AttachmentManifest, settings: OfflineSyncSettings): boolean {
  if (settings.attachmentMode === "none") return false;
  if (settings.attachmentMode === "images") return attachment.mimeType.toLowerCase().startsWith("image/");
  return true;
}

async function fetchAttachmentBlob(attachment: AttachmentManifest, signal: AbortSignal): Promise<Blob> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw new DOMException("Sync aborted", "AbortError");
    try {
      const response = await fetch(`${getBaseUrl()}/attachments/${encodeURIComponent(attachment.id)}`, {
        method: "GET",
        headers: authHeaders(false),
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        const error = new Error(`附件下载失败：HTTP ${response.status}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return await response.blob();
    } catch (error) {
      lastError = error;
      if ((error as { name?: string })?.name === "AbortError") throw error;
      if (attempt < 2) await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("附件下载失败");
}

async function cacheAttachment(
  attachment: AttachmentManifest,
  settings: OfflineSyncSettings,
  signal: AbortSignal,
): Promise<"cached" | "existing" | "skipped"> {
  if (!isOfflineAttachmentWanted(attachment, settings)) return "skipped";
  const existing = await getOfflineAttachment(attachment.id);
  if (
    existing
    && existing.size === attachment.size
    && existing.mimeType === attachment.mimeType
    && existing.filename === attachment.filename
  ) return "existing";

  if (settings.maxAttachmentBytes > 0) {
    const storage = await getOfflineStorageStats();
    if (attachment.size > settings.maxAttachmentBytes) return "skipped";
    const projected = storage.attachmentBytes - Number(existing?.size || 0) + attachment.size;
    const required = Math.max(0, projected - settings.maxAttachmentBytes);
    if (required > 0) await evictOfflineAttachmentsToFit(required, new Set([attachment.id]));
    const afterEviction = await getOfflineStorageStats();
    const finalProjected = afterEviction.attachmentBytes - Number(existing?.size || 0) + attachment.size;
    if (finalProjected > settings.maxAttachmentBytes) return "skipped";
  }

  const blob = await fetchAttachmentBlob(attachment, signal);
  const record: OfflineAttachmentRecord = {
    ...attachment,
    size: blob.size || attachment.size,
    blob,
    cachedAt: Date.now(),
  };
  await putOfflineAttachment(record);
  return "cached";
}

async function runPool<T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency: number,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const current = cursor++;
      await worker(items[current]);
    }
  });
  await Promise.all(runners);
}

async function queueBundleAttachments(
  bundle: NoteBundle,
  settings: OfflineSyncSettings,
): Promise<void> {
  const desired = bundle.attachmentDownloadAllowed
    ? bundle.attachments.filter((attachment) => isOfflineAttachmentWanted(attachment, settings))
    : [];
  const keepIds = new Set(desired.map((item) => item.id));
  await reconcileOfflineAttachments(bundle.note.id, keepIds);
  await reconcileOfflineAttachmentJobs(bundle.note.id, keepIds);

  const jobsById = new Map(
    (await getAllOfflineAttachmentJobs()).map((job) => [job.id, job] as const),
  );
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
    const prior = jobsById.get(attachment.id);
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

async function ackScope(scopeKey: string, sequence: number, signal: AbortSignal): Promise<void> {
  await requestJson("/offline-sync/ack", {
    method: "POST",
    body: JSON.stringify({ clientId: getClientId(), scopeKey, sequence }),
  }, signal);
}

async function fullSnapshot(
  target: SyncScopeTarget,
  plan: SyncPlan,
  settings: OfflineSyncSettings,
  signal: AbortSignal,
  queuedNoteIds: Set<string>,
): Promise<number> {
  let cursor = "";
  let snapshotSequence = plan.serverSequence;
  const remoteNoteIds = new Set<string>();
  const remoteNotebookIds = new Set(plan.notebooks.map((notebook) => notebook.id));
  const remoteTagIds = new Set(plan.tags.map((tag) => tag.id));

  await putCompleteOfflineNotebooks(plan.notebooks);
  await putCompleteOfflineTags(plan.tags);
  emit({
    state: "downloading-notes",
    completedNotes: 0,
    totalNotes: plan.noteCount,
    completedAttachments: 0,
    totalAttachments: 0,
    downloadedBytes: 0,
    totalAttachmentBytes: 0,
    failedAttachments: 0,
  });

  while (true) {
    const query = new URLSearchParams({
      ...(target.workspaceId ? { workspaceId: target.workspaceId } : { workspaceId: "personal" }),
      limit: "80",
      cursor,
      snapshotSequence: String(snapshotSequence),
    });
    const page = await requestJson<SnapshotPage>(`/offline-sync/snapshot?${query.toString()}`, {}, signal);
    snapshotSequence = page.snapshotSequence;
    for (const bundle of page.items) {
      remoteNoteIds.add(bundle.note.id);
      await applyBundle(bundle, settings, signal, queuedNoteIds);
      emit({ state: "downloading-notes" });
    }
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  await reconcileOfflineScope(target.workspaceId, {
    noteIds: remoteNoteIds,
    notebookIds: remoteNotebookIds,
    tagIds: remoteTagIds,
    preserveNoteIds: queuedNoteIds,
  });
  await setMeta(`${SNAPSHOT_COMPLETE_PREFIX}${target.scopeKey}`, true);
  await setMeta(`${FINGERPRINT_PREFIX}${target.scopeKey}`, plan.accessFingerprint);
  await setMeta(`${SEQUENCE_PREFIX}${target.scopeKey}`, snapshotSequence);
  return snapshotSequence;
}

async function applyChanges(
  target: SyncScopeTarget,
  startSequence: number,
  settings: OfflineSyncSettings,
  signal: AbortSignal,
  queuedNoteIds: Set<string>,
): Promise<number> {
  let sequence = startSequence;
  emit({ state: "applying-changes" });
  while (true) {
    const query = new URLSearchParams({
      ...(target.workspaceId ? { workspaceId: target.workspaceId } : { workspaceId: "personal" }),
      after: String(sequence),
      limit: "500",
    });
    const page = await requestJson<ChangePage>(`/offline-sync/changes?${query.toString()}`, {}, signal);
    if (page.resetRequired) throw new Error("OFFLINE_SYNC_RESET_REQUIRED");
    for (const item of page.items) {
      if (item.operation === "delete") {
        if (!queuedNoteIds.has(item.noteId)) {
          await reconcileOfflineScope(target.workspaceId, {
            deleteNoteIds: new Set([item.noteId]),
            preserveNoteIds: queuedNoteIds,
          });
          await deleteOfflineAttachmentsByNote(item.noteId);
        }
      } else {
        await applyBundle(item, settings, signal, queuedNoteIds);
      }
    }
    sequence = page.nextSequence;
    await setMeta(`${SEQUENCE_PREFIX}${target.scopeKey}`, sequence);
    if (!page.hasMore) break;
  }
  return sequence;
}

async function syncTarget(
  target: SyncScopeTarget,
  settings: OfflineSyncSettings,
  signal: AbortSignal,
  queuedNoteIds: Set<string>,
): Promise<void> {
  emit({
    state: "planning",
    scopeKey: target.scopeKey,
    scopeLabel: target.label,
    completedNotes: 0,
    totalNotes: 0,
    completedAttachments: 0,
    totalAttachments: 0,
    downloadedBytes: 0,
    totalAttachmentBytes: 0,
    failedAttachments: 0,
    lastError: null,
  });

  const storedSequence = Number(await getMeta<number>(`${SEQUENCE_PREFIX}${target.scopeKey}`) || 0);
  const plan = await requestJson<SyncPlan>(
    `/offline-sync/plan?${scopeQuery(target.workspaceId)}&after=${storedSequence}`,
    {},
    signal,
  );
  await putCompleteOfflineNotebooks(plan.notebooks);
  await putCompleteOfflineTags(plan.tags);
  await reconcileOfflineScope(target.workspaceId, {
    notebookIds: new Set(plan.notebooks.map((notebook) => notebook.id)),
    tagIds: new Set(plan.tags.map((tag) => tag.id)),
    preserveNoteIds: queuedNoteIds,
  });

  const snapshotComplete = Boolean(await getMeta<boolean>(`${SNAPSHOT_COMPLETE_PREFIX}${target.scopeKey}`));
  const fingerprint = await getMeta<string>(`${FINGERPRINT_PREFIX}${target.scopeKey}`);
  const policy = `${settings.attachmentMode}:${settings.workspaceMode}:${settings.workspaceIds.slice().sort().join(",")}`;
  const storedPolicy = await getMeta<string>(`${POLICY_PREFIX}${target.scopeKey}`);
  let sequence = storedSequence;
  const requiresSnapshot = !snapshotComplete
    || plan.resetRequired
    || fingerprint !== plan.accessFingerprint
    || storedPolicy !== policy;

  if (requiresSnapshot) {
    sequence = await fullSnapshot(target, plan, settings, signal, queuedNoteIds);
  }

  try {
    sequence = await applyChanges(target, sequence, settings, signal, queuedNoteIds);
  } catch (error) {
    if ((error as Error)?.message !== "OFFLINE_SYNC_RESET_REQUIRED") throw error;
    await setMeta(`${SNAPSHOT_COMPLETE_PREFIX}${target.scopeKey}`, false);
    sequence = await fullSnapshot(target, plan, settings, signal, queuedNoteIds);
    sequence = await applyChanges(target, sequence, settings, signal, queuedNoteIds);
  }

  await setMeta(`${FINGERPRINT_PREFIX}${target.scopeKey}`, plan.accessFingerprint);
  await setMeta(`${POLICY_PREFIX}${target.scopeKey}`, policy);
  await setMeta(`${SEQUENCE_PREFIX}${target.scopeKey}`, sequence);
  await ackScope(target.scopeKey, sequence, signal);
}

async function clearRemovedScopes(targets: SyncScopeTarget[], queuedNoteIds: Set<string>): Promise<void> {
  const current = new Set(targets.map((target) => target.scopeKey));
  const known = await getMeta<string[]>(KNOWN_SCOPES_META) || [];
  for (const scopeKey of known) {
    if (current.has(scopeKey)) continue;
    const workspaceId = scopeKey.startsWith("workspace:") ? scopeKey.slice("workspace:".length) : null;
    if (scopeKey === "personal") continue;
    await clearOfflineScope(workspaceId, queuedNoteIds);
    await setMeta(`${SNAPSHOT_COMPLETE_PREFIX}${scopeKey}`, false);
    await setMeta(`${SEQUENCE_PREFIX}${scopeKey}`, 0);
    await setMeta(`${FINGERPRINT_PREFIX}${scopeKey}`, "");
  }
  await setMeta(KNOWN_SCOPES_META, [...current]);
}

async function executeSync(options: SyncOptions): Promise<OfflineSyncProgress> {
  if (!activeUserId) return getOfflineSyncProgress();
  const settings = getOfflineSyncSettings();
  if (!settings.enabled) {
    emit({ state: "idle", lastError: null });
    return getOfflineSyncProgress();
  }
  if (settings.paused) {
    emit({ state: "paused", lastError: null });
    return getOfflineSyncProgress();
  }
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    emit({ state: "error", lastError: "当前离线，恢复连接后会自动继续同步。" });
    return getOfflineSyncProgress();
  }

  const lastRun = Number(await getMeta<number>(LAST_RUN_META) || 0);
  const dueMs = settings.intervalMinutes * 60_000;
  if (!options.force && lastRun > 0 && Date.now() - lastRun < dueMs) {
    return getOfflineSyncProgress();
  }

  activeController = new AbortController();
  const signal = activeController.signal;
  const queuedNoteIds = new Set(getQueue().map((item) => item.noteId));
  try {
    const targets = await resolveTargets(settings);
    await clearRemovedScopes(targets, queuedNoteIds);
    for (const target of targets) {
      if (signal.aborted) throw new DOMException("Sync aborted", "AbortError");
      await syncTarget(target, settings, signal, queuedNoteIds);
    }
    const attachmentResult = await processPendingAttachmentJobs(settings, signal);
    const now = Date.now();
    await setMeta(LAST_RUN_META, now);
    const storage = await getOfflineStorageStats();
    emit({
      state: "ready",
      scopeKey: null,
      scopeLabel: null,
      lastSyncAt: now,
      lastError: attachmentResult.deferredForNetwork
        ? `${attachmentResult.remaining} 个附件正在等待 Wi-Fi / 有线网络。`
        : attachmentResult.remaining > 0
          ? `${attachmentResult.remaining} 个附件暂未下载，任务已保留并会自动重试。`
          : null,
      storage,
    });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("nowen:sync-snapshot-applied", {
        detail: { offlineWorkspace: true, lastSyncAt: now },
      }));
    }
    return getOfflineSyncProgress();
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      const paused = getOfflineSyncSettings().paused;
      emit({ state: paused ? "paused" : "idle", lastError: null });
      return getOfflineSyncProgress();
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[offline-sync] sync failed", error);
    emit({ state: "error", lastError: message });
    return getOfflineSyncProgress();
  } finally {
    activeController = null;
  }
}

export function syncOfflineWorkspace(options: SyncOptions = {}): Promise<OfflineSyncProgress> {
  if (activePromise) return activePromise;
  const promise = executeSync(options).finally(() => {
    if (activePromise === promise) activePromise = null;
  });
  activePromise = promise;
  return promise;
}

export function syncOfflineChangesIfDue(force = false): Promise<OfflineSyncProgress> {
  return syncOfflineWorkspace({ force, reason: force ? "network" : "interval" });
}

export function pauseOfflineWorkspaceSync(): OfflineSyncSettings {
  const settings = setOfflineSyncSettings({ paused: true });
  activeController?.abort();
  emit({ state: "paused", lastError: null });
  return settings;
}

export function resumeOfflineWorkspaceSync(): Promise<OfflineSyncProgress> {
  setOfflineSyncSettings({ paused: false });
  return syncOfflineWorkspace({ force: true, reason: "settings" });
}

export function stopOfflineWorkspaceSync(): void {
  activeController?.abort();
  activeController = null;
}

export async function clearAllOfflineWorkspaceData(): Promise<void> {
  stopOfflineWorkspaceSync();
  const queuedNoteIds = new Set(getQueue().map((item) => item.noteId));
  const known = await getMeta<string[]>(KNOWN_SCOPES_META) || [];
  await clearOfflineScope(null, queuedNoteIds);
  for (const scopeKey of known) {
    if (!scopeKey.startsWith("workspace:")) continue;
    await clearOfflineScope(scopeKey.slice("workspace:".length), queuedNoteIds);
  }
  await setMeta(KNOWN_SCOPES_META, []);
  await setMeta(LAST_RUN_META, 0);
  const storage = await getOfflineStorageStats();
  emit({
    state: getOfflineSyncSettings().paused ? "paused" : "idle",
    completedNotes: 0,
    totalNotes: 0,
    completedAttachments: 0,
    totalAttachments: 0,
    downloadedBytes: 0,
    totalAttachmentBytes: 0,
    failedAttachments: 0,
    lastSyncAt: null,
    lastError: null,
    storage,
  });
}

export async function refreshOfflineStorageStats(): Promise<OfflineStorageStats> {
  const storage = await getOfflineStorageStats();
  emit({ storage });
  return storage;
}
