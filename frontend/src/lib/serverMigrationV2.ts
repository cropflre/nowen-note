import type { ServerProfile } from "@/lib/serverProfiles";

export type MigrationStrategy = "skip" | "replace" | "keep-both";
export type AuthenticatedServerProfile = ServerProfile & { token: string };

export interface MigrationPreflight {
  source: { instanceId: string; userId: string; username: string };
  snapshotHash: string;
  generatedAt: string;
  counts: {
    notebooks: number;
    notes: number;
    tags: number;
    tasks: number;
    noteVersions: number;
    attachments: number;
    missingAttachments: number;
  };
  attachments: {
    total: number;
    totalBytes: number;
    missing: Array<{ kind: "note" | "task"; id: string; filename: string }>;
    manifest: MigrationAttachment[];
  };
  entities: Record<string, Array<{ id: string; parentId?: string | null; label: string; hash: string }>>;
}

export interface MigrationAttachment {
  kind: "note" | "task";
  id: string;
  parentId: string;
  filename: string;
  mimeType: string;
  size: number;
  hash: string;
  missing: boolean;
}

export interface TargetPreview {
  target: { instanceId: string; userId: string };
  summary: Record<string, { total: number; alreadyImported: number; changed: number; newItems: number }>;
  samples: Array<{ entityType: string; label: string; state: string }>;
  strategies: Record<MigrationStrategy, string>;
}

export interface MigrationAnalysis {
  source: AuthenticatedServerProfile;
  target: AuthenticatedServerProfile;
  preflight: MigrationPreflight;
  targetPreview: TargetPreview;
}

export interface MigrationProgress {
  phase: "backup" | "data" | "attachments" | "rewrite" | "verify" | "done";
  ratio: number;
  message: string;
  current?: number;
  total?: number;
}

export interface MigrationRunResult {
  migrationId: string;
  backup: { filename: string; size: number; sha256: string; location?: string };
  imported: {
    idMap: {
      notebooks: Record<string, string>;
      notes: Record<string, string>;
      tags: Record<string, string>;
      tasks: Record<string, string>;
    };
    stats: Record<string, number>;
  };
  attachments: {
    total: number;
    transferred: number;
    reused: number;
    bytes: number;
  };
  verification: { verifiedAttachments: number; verifiedBytes: number };
}

interface MigrationCheckpoint {
  version: 1;
  migrationId: string;
  sourceProfileId: string;
  targetProfileId: string;
  sourceInstanceId: string;
  sourceUserId: string;
  snapshotHash: string;
  strategy: MigrationStrategy;
  backup?: { filename: string; size: number; sha256: string; location?: string };
  idMap?: MigrationRunResult["imported"]["idMap"];
  stats?: Record<string, number>;
  completedAttachments: Record<string, { targetId: string; hash: string; size: number; reused: boolean }>;
  startedAt: number;
  updatedAt: number;
  lastError?: string;
}

const CHECKPOINT_KEY = "nowen-instance-migration-checkpoint-v1";

function profileApi(profile: ServerProfile, path: string): string {
  return `${profile.serverUrl.replace(/\/+$/, "")}/api/user-migration/v2${path}`;
}

function authHeaders(profile: AuthenticatedServerProfile, json = false): Headers {
  const headers = new Headers();
  if (profile.token) headers.set("Authorization", `Bearer ${profile.token}`);
  if (json) headers.set("Content-Type", "application/json");
  return headers;
}

async function readApiError(response: Response): Promise<Error> {
  const body = await response.json().catch(async () => ({ error: await response.text().catch(() => "") }));
  const message = body?.error || body?.message || `HTTP ${response.status}`;
  const error = new Error(message) as Error & { code?: string; detail?: unknown; status?: number };
  error.code = body?.code;
  error.detail = body;
  error.status = response.status;
  return error;
}

async function fetchJson<T>(
  profile: AuthenticatedServerProfile,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (profile.token) headers.set("Authorization", `Bearer ${profile.token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(profileApi(profile, path), { ...init, headers });
  if (!response.ok) throw await readApiError(response);
  return response.json() as Promise<T>;
}

function uuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `migration-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

function checkpointKey(item: MigrationAttachment): string {
  return `${item.kind}:${item.id}`;
}

function loadCheckpoint(): MigrationCheckpoint | null {
  try {
    const raw = localStorage.getItem(CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MigrationCheckpoint;
    return parsed?.version === 1 && parsed.migrationId ? parsed : null;
  } catch {
    return null;
  }
}

function saveCheckpoint(checkpoint: MigrationCheckpoint): void {
  checkpoint.updatedAt = Date.now();
  try { localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(checkpoint)); } catch { /* ignore */ }
}

export function getMigrationCheckpoint(): MigrationCheckpoint | null {
  return loadCheckpoint();
}

export function clearMigrationCheckpoint(): void {
  try { localStorage.removeItem(CHECKPOINT_KEY); } catch { /* ignore */ }
}

export function formatMigrationBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function digestBlob(blob: Blob): Promise<string> {
  const bytes = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function inspectServerProfile(profile: ServerProfile, token = ""): Promise<{
  online: boolean;
  authenticated: boolean;
  serverInstanceId?: string;
  username?: string;
  displayName?: string;
  error?: string;
}> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 8000);
  try {
    const version = await fetch(`${profile.serverUrl}/api/version`, { signal: controller.signal });
    if (!version.ok) return { online: false, authenticated: false, error: `HTTP ${version.status}` };
    const versionBody = await version.json().catch(() => ({}));
    if (!token) {
      return { online: true, authenticated: false, serverInstanceId: versionBody?.serverInstanceId };
    }
    const me = await fetch(`${profile.serverUrl}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const meBody = await me.json().catch(() => ({}));
    return {
      online: true,
      authenticated: me.ok && Boolean(meBody?.id),
      serverInstanceId: versionBody?.serverInstanceId,
      username: meBody?.username,
      displayName: meBody?.displayName || meBody?.username,
      error: me.ok ? undefined : (meBody?.error || `HTTP ${me.status}`),
    };
  } catch (error) {
    return {
      online: false,
      authenticated: false,
      error: error instanceof DOMException && error.name === "AbortError"
        ? "连接超时"
        : (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export async function loginServerProfile(
  profile: Pick<ServerProfile, "serverUrl">,
  username: string,
  password: string,
): Promise<{ token: string; username: string; displayName: string }> {
  const response = await fetch(`${profile.serverUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `登录失败（HTTP ${response.status}）`);
  if (body?.requires2FA) throw new Error("该账号启用了二步验证，请先通过常规登录页登录一次，再保存此服务端配置。");
  if (!body?.token) throw new Error("登录响应缺少 token");
  return {
    token: body.token,
    username: body.user?.username || username,
    displayName: body.user?.displayName || body.user?.username || username,
  };
}

export async function analyzeInstanceMigration(
  source: AuthenticatedServerProfile,
  target: AuthenticatedServerProfile,
): Promise<MigrationAnalysis> {
  const [preflight] = await Promise.all([
    fetchJson<MigrationPreflight>(source, "/preflight"),
    inspectServerProfile(target, target.token).then((result) => {
      if (!result.online) throw new Error(`目标服务器不可连接：${result.error || "未知错误"}`);
      if (!result.authenticated) throw new Error(`目标账号登录态已失效：${result.error || "请重新登录"}`);
      return result;
    }),
  ]);
  const targetPreview = await fetchJson<TargetPreview>(target, "/target-preview", {
    method: "POST",
    body: JSON.stringify({
      source: preflight.source,
      snapshotHash: preflight.snapshotHash,
      entities: preflight.entities,
    }),
  });
  return { source, target, preflight, targetPreview };
}

function compatibleCheckpoint(
  checkpoint: MigrationCheckpoint | null,
  analysis: MigrationAnalysis,
  strategy: MigrationStrategy,
): MigrationCheckpoint {
  if (
    checkpoint
    && checkpoint.sourceProfileId === analysis.source.id
    && checkpoint.targetProfileId === analysis.target.id
    && checkpoint.sourceInstanceId === analysis.preflight.source.instanceId
    && checkpoint.sourceUserId === analysis.preflight.source.userId
    && checkpoint.snapshotHash === analysis.preflight.snapshotHash
    && checkpoint.strategy === strategy
  ) {
    return checkpoint;
  }
  return {
    version: 1,
    migrationId: uuid(),
    sourceProfileId: analysis.source.id,
    targetProfileId: analysis.target.id,
    sourceInstanceId: analysis.preflight.source.instanceId,
    sourceUserId: analysis.preflight.source.userId,
    snapshotHash: analysis.preflight.snapshotHash,
    strategy,
    completedAttachments: {},
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export async function runInstanceMigration(args: {
  analysis: MigrationAnalysis;
  strategy: MigrationStrategy;
  onProgress?: (progress: MigrationProgress) => void;
}): Promise<MigrationRunResult> {
  const { analysis, strategy, onProgress } = args;
  if (analysis.preflight.counts.missingAttachments > 0) {
    throw new Error("源端存在物理文件缺失的附件，迁移已阻止。请先修复附件或使用完整备份排查。");
  }
  const checkpoint = compatibleCheckpoint(loadCheckpoint(), analysis, strategy);
  saveCheckpoint(checkpoint);
  const tick = (progress: MigrationProgress) => onProgress?.(progress);

  try {
    tick({ phase: "backup", ratio: 0.02, message: "正在源端创建迁移前安全备份…" });
    if (!checkpoint.backup) {
      checkpoint.backup = await fetchJson<{
        success: true;
        filename: string;
        size: number;
        sha256: string;
        location?: string;
      }>(analysis.source, "/source-backup", { method: "POST", body: "{}" });
      saveCheckpoint(checkpoint);
    }

    tick({ phase: "data", ratio: 0.12, message: "正在读取源端一致性数据快照…" });
    const payload = await fetchJson<Record<string, unknown>>(analysis.source, "/export");
    const imported = await fetchJson<{
      success: true;
      migrationId: string;
      idMap: MigrationRunResult["imported"]["idMap"];
      stats: Record<string, number>;
    }>(analysis.target, "/import", {
      method: "POST",
      body: JSON.stringify({
        migrationId: checkpoint.migrationId,
        strategy,
        payload,
        backup: checkpoint.backup,
      }),
    });
    checkpoint.idMap = imported.idMap;
    checkpoint.stats = imported.stats;
    saveCheckpoint(checkpoint);

    const manifest = analysis.preflight.attachments.manifest.filter((item) => !item.missing);
    const noteAttachmentMap: Record<string, string> = {};
    const taskAttachmentMap: Record<string, string> = {};
    let transferred = 0;
    let reused = 0;
    let transferredBytes = 0;

    for (let index = 0; index < manifest.length; index++) {
      const item = manifest[index];
      const key = checkpointKey(item);
      const cached = checkpoint.completedAttachments[key];
      if (cached?.hash === item.hash) {
        if (item.kind === "note") noteAttachmentMap[item.id] = cached.targetId;
        else taskAttachmentMap[item.id] = cached.targetId;
        reused += cached.reused ? 1 : 0;
        transferred++;
        transferredBytes += cached.size;
        continue;
      }

      tick({
        phase: "attachments",
        ratio: 0.2 + (manifest.length ? index / manifest.length : 1) * 0.65,
        message: `迁移附件 ${index + 1}/${manifest.length}：${item.filename}`,
        current: index + 1,
        total: manifest.length,
      });

      const sourceResponse = await fetch(
        profileApi(analysis.source, `/attachment/${item.kind}/${encodeURIComponent(item.id)}`),
        { headers: authHeaders(analysis.source) },
      );
      if (!sourceResponse.ok) throw await readApiError(sourceResponse);
      const blob = await sourceResponse.blob();
      if (blob.size !== item.size) {
        throw new Error(`附件大小校验失败：${item.filename}（预期 ${item.size}，实际 ${blob.size}）`);
      }
      const actualHash = await digestBlob(blob);
      if (actualHash !== item.hash) {
        throw new Error(`附件 SHA-256 校验失败：${item.filename}`);
      }

      const targetParentId = item.kind === "note"
        ? imported.idMap.notes[item.parentId]
        : imported.idMap.tasks[item.parentId];
      if (!targetParentId) throw new Error(`附件 ${item.filename} 的目标归属映射缺失`);

      const form = new FormData();
      form.set("file", new File([blob], item.filename, { type: item.mimeType || blob.type }));
      form.set("migrationId", checkpoint.migrationId);
      form.set("sourceInstanceId", analysis.preflight.source.instanceId);
      form.set("sourceUserId", analysis.preflight.source.userId);
      form.set("sourceAttachmentId", item.id);
      form.set("sourceHash", item.hash);
      form.set("kind", item.kind);
      form.set("targetParentId", targetParentId);

      const uploadResponse = await fetch(profileApi(analysis.target, "/attachment/import"), {
        method: "POST",
        headers: authHeaders(analysis.target),
        body: form,
      });
      if (!uploadResponse.ok) throw await readApiError(uploadResponse);
      const uploaded = await uploadResponse.json() as {
        id: string;
        hash: string;
        size: number;
        reused: boolean;
      };
      if (uploaded.hash !== item.hash || uploaded.size !== item.size) {
        throw new Error(`目标端附件回执校验失败：${item.filename}`);
      }

      checkpoint.completedAttachments[key] = {
        targetId: uploaded.id,
        hash: uploaded.hash,
        size: uploaded.size,
        reused: uploaded.reused,
      };
      saveCheckpoint(checkpoint);
      if (item.kind === "note") noteAttachmentMap[item.id] = uploaded.id;
      else taskAttachmentMap[item.id] = uploaded.id;
      transferred++;
      transferredBytes += uploaded.size;
      if (uploaded.reused) reused++;
    }

    tick({ phase: "rewrite", ratio: 0.88, message: "正在重写笔记与任务中的附件引用…" });
    await fetchJson(analysis.target, "/rewrite", {
      method: "POST",
      body: JSON.stringify({
        migrationId: checkpoint.migrationId,
        noteAttachments: noteAttachmentMap,
        taskAttachments: taskAttachmentMap,
        noteIds: Object.values(imported.idMap.notes),
        taskIds: Object.values(imported.idMap.tasks),
      }),
    });

    tick({ phase: "verify", ratio: 0.94, message: "正在逐个复核目标端附件大小与 SHA-256…" });
    const verification = await fetchJson<{
      success: true;
      verifiedAttachments: number;
      verifiedBytes: number;
    }>(analysis.target, "/complete", {
      method: "POST",
      body: JSON.stringify({
        migrationId: checkpoint.migrationId,
        attachments: manifest,
      }),
    });

    tick({ phase: "done", ratio: 1, message: "迁移完成，源端数据与安全备份均已保留。" });
    clearMigrationCheckpoint();
    return {
      migrationId: checkpoint.migrationId,
      backup: checkpoint.backup!,
      imported: { idMap: imported.idMap, stats: imported.stats },
      attachments: { total: manifest.length, transferred, reused, bytes: transferredBytes },
      verification,
    };
  } catch (error) {
    checkpoint.lastError = error instanceof Error ? error.message : String(error);
    saveCheckpoint(checkpoint);
    throw error;
  }
}

export async function rollbackInstanceMigration(
  target: AuthenticatedServerProfile,
  migrationId: string,
): Promise<{ success: true; removed: Record<string, number> }> {
  const result = await fetchJson<{ success: true; removed: Record<string, number> }>(target, "/rollback", {
    method: "POST",
    body: JSON.stringify({ migrationId }),
  });
  const checkpoint = loadCheckpoint();
  if (checkpoint?.migrationId === migrationId) clearMigrationCheckpoint();
  return result;
}
