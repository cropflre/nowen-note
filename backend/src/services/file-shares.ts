import crypto from "crypto";
import { getDb } from "../db/schema";
import { resolveEffectiveNoteCapabilities } from "./share-capabilities";

export interface FileShareRecord {
  id: string;
  token: string;
  attachmentId: string;
  noteId: string;
  ownerId: string;
  isActive: number;
  expiresAt: string | null;
  allowDownload: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileShareAccess {
  id: string;
  attachmentId: string;
  noteId: string;
  ownerId: string;
  allowDownload: boolean;
}

export class FileShareError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 403 | 404 | 410,
    public readonly code: string,
  ) {
    super(message);
    this.name = "FileShareError";
  }
}

let schemaReadyFor: ReturnType<typeof getDb> | null = null;

/**
 * 独立文件分享是附件之上的 capability，不复用 notes shares 表：
 * 否则一个“文件外链”token 会同时变成整篇笔记的公开入口。
 *
 * 目前先保持为内部能力表；等 PostgreSQL 迁移链稳定后再纳入统一 schema migration。
 */
export function ensureFileSharesTable(): void {
  const db = getDb();
  if (schemaReadyFor === db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_shares (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      attachmentId TEXT NOT NULL,
      noteId TEXT NOT NULL,
      ownerId TEXT NOT NULL,
      isActive INTEGER NOT NULL DEFAULT 1 CHECK (isActive IN (0, 1)),
      expiresAt TEXT,
      allowDownload INTEGER NOT NULL DEFAULT 1 CHECK (allowDownload IN (0, 1)),
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (attachmentId) REFERENCES attachments(id) ON DELETE CASCADE,
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_file_shares_token
      ON file_shares(token);
    CREATE INDEX IF NOT EXISTS idx_file_shares_attachment_owner
      ON file_shares(attachmentId, ownerId, isActive);
  `);
  schemaReadyFor = db;
}

function isExpired(value: string | null | undefined): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function normalizeExpiresAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const timestamp = new Date(String(value)).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new FileShareError("分享过期时间无效", 400, "FILE_SHARE_INVALID_EXPIRY");
  }
  if (timestamp <= Date.now()) {
    throw new FileShareError("分享过期时间必须晚于当前时间", 400, "FILE_SHARE_INVALID_EXPIRY");
  }
  return new Date(timestamp).toISOString();
}

function generateFileShareToken(): string {
  // 24 bytes = 192 bits entropy，URL-safe 且不可枚举。
  return crypto.randomBytes(24).toString("base64url");
}

function loadAttachmentForSharing(attachmentId: string): {
  id: string;
  noteId: string;
} | null {
  const db = getDb();
  return db.prepare(`
    SELECT a.id, a.noteId
    FROM attachments a
    INNER JOIN notes n ON n.id = a.noteId
    WHERE a.id = ?
      AND n.isTrashed = 0
  `).get(attachmentId) as { id: string; noteId: string } | undefined || null;
}

export function ensureStableFileShare(
  attachmentId: string,
  ownerId: string,
  options: { allowDownload?: boolean; expiresAt?: string | null } = {},
): FileShareRecord {
  ensureFileSharesTable();
  const normalizedAttachmentId = attachmentId.trim();
  if (!normalizedAttachmentId) {
    throw new FileShareError("缺少 attachmentId", 400, "FILE_SHARE_ATTACHMENT_REQUIRED");
  }

  const attachment = loadAttachmentForSharing(normalizedAttachmentId);
  if (!attachment) {
    throw new FileShareError("文件不存在", 404, "FILE_SHARE_ATTACHMENT_NOT_FOUND");
  }

  const capabilities = resolveEffectiveNoteCapabilities(attachment.noteId, ownerId);
  if (!capabilities.read || !capabilities.reshare) {
    throw new FileShareError("当前目录不允许分享此文件", 403, "FILE_SHARE_FORBIDDEN");
  }

  const db = getDb();
  const existing = db.prepare(`
    SELECT *
    FROM file_shares
    WHERE attachmentId = ? AND ownerId = ? AND isActive = 1
    ORDER BY createdAt DESC
    LIMIT 1
  `).get(normalizedAttachmentId, ownerId) as FileShareRecord | undefined;

  if (existing && isExpired(existing.expiresAt)) {
    db.prepare(
      "UPDATE file_shares SET isActive = 0, updatedAt = datetime('now') WHERE id = ?",
    ).run(existing.id);
  }

  const active = existing && !isExpired(existing.expiresAt) ? existing : undefined;
  const expiresAt = normalizeExpiresAt(options.expiresAt);
  const requestedAllowDownload = options.allowDownload === undefined
    ? undefined
    : options.allowDownload && capabilities.download;

  if (active) {
    if (expiresAt !== undefined || requestedAllowDownload !== undefined) {
      const nextExpiresAt = expiresAt === undefined ? active.expiresAt : expiresAt;
      const nextAllowDownload = requestedAllowDownload === undefined
        ? active.allowDownload
        : requestedAllowDownload ? 1 : 0;
      db.prepare(`
        UPDATE file_shares
        SET expiresAt = ?, allowDownload = ?, updatedAt = datetime('now')
        WHERE id = ?
      `).run(nextExpiresAt, nextAllowDownload, active.id);
    }
    return db.prepare("SELECT * FROM file_shares WHERE id = ?").get(active.id) as FileShareRecord;
  }

  const id = crypto.randomUUID();
  const token = generateFileShareToken();
  const allowDownload = (options.allowDownload === false || !capabilities.download) ? 0 : 1;
  db.prepare(`
    INSERT INTO file_shares (
      id, token, attachmentId, noteId, ownerId, isActive, expiresAt, allowDownload
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    token,
    normalizedAttachmentId,
    attachment.noteId,
    ownerId,
    expiresAt ?? null,
    allowDownload,
  );

  return db.prepare("SELECT * FROM file_shares WHERE id = ?").get(id) as FileShareRecord;
}

export function resolveStableFileShare(
  token: string,
  attachmentId: string,
): FileShareAccess {
  ensureFileSharesTable();
  const normalizedToken = token.trim();
  if (!normalizedToken || normalizedToken.length > 512) {
    throw new FileShareError("文件分享链接不存在", 404, "FILE_SHARE_NOT_FOUND");
  }

  const db = getDb();
  const share = db.prepare(`
    SELECT *
    FROM file_shares
    WHERE token = ? AND attachmentId = ?
  `).get(normalizedToken, attachmentId) as FileShareRecord | undefined;
  if (!share) {
    throw new FileShareError("文件分享链接不存在或已失效", 404, "FILE_SHARE_NOT_FOUND");
  }
  if (!share.isActive) {
    throw new FileShareError("文件分享已被撤销", 410, "FILE_SHARE_REVOKED");
  }
  if (isExpired(share.expiresAt)) {
    throw new FileShareError("文件分享已过期", 410, "FILE_SHARE_EXPIRED");
  }

  const attachment = loadAttachmentForSharing(attachmentId);
  if (!attachment) {
    throw new FileShareError("分享的文件不存在", 404, "FILE_SHARE_ATTACHMENT_NOT_FOUND");
  }
  if (attachment.noteId !== share.noteId) {
    throw new FileShareError("文件分享已失效", 410, "FILE_SHARE_SCOPE_CHANGED");
  }

  const owner = db
    .prepare("SELECT isDisabled FROM users WHERE id = ?")
    .get(share.ownerId) as { isDisabled: number } | undefined;
  if (!owner || owner.isDisabled) {
    throw new FileShareError("文件分享已失效", 410, "FILE_SHARE_ACCESS_REVOKED");
  }

  // 每次稳定链接访问都重新核验当前权限，避免文件移动、成员移除等场景留下永久能力。
  const capabilities = resolveEffectiveNoteCapabilities(share.noteId, share.ownerId);
  if (!capabilities.read || !capabilities.reshare) {
    throw new FileShareError("文件分享已失效", 410, "FILE_SHARE_ACCESS_REVOKED");
  }

  return {
    id: share.id,
    attachmentId: share.attachmentId,
    noteId: share.noteId,
    ownerId: share.ownerId,
    allowDownload: share.allowDownload !== 0 && capabilities.download,
  };
}

export function revokeStableFileShare(attachmentId: string, ownerId: string): boolean {
  ensureFileSharesTable();
  const result = getDb().prepare(`
    UPDATE file_shares
    SET isActive = 0, updatedAt = datetime('now')
    WHERE attachmentId = ? AND ownerId = ? AND isActive = 1
  `).run(attachmentId, ownerId);
  return result.changes > 0;
}
