import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Clipper 本地凭据（Phase 8）。
 *
 * 为什么不让 Clipper 直接用桌面端的管理员 JWT：
 * 浏览器扩展的运行环境远不如桌面应用可控——任何能读扩展存储的东西
 * 都会拿到一枚全权令牌，可以删用户、恢复备份、改安全设置。
 * 因此这里签发一枚**独立凭据**，只授予剪藏必需的能力。
 *
 * 授予：list notebooks / list tags / create note / upload attachment
 * 禁止：admin、删除用户、恢复备份、修改系统安全设置
 *
 * 存储方式：只存 SHA-256 摘要，不存明文。
 * 即使 SQLite 文件被拿到也无法直接复用凭据。
 */

export const CLIPPER_SCOPES = [
  "notebooks:list",
  "tags:list",
  "note:create",
  "attachment:upload",
] as const;

export type ClipperScope = (typeof CLIPPER_SCOPES)[number];

export interface ClipperCredentialRow {
  id: string;
  userId: string;
  tokenHash: string;
  label: string | null;
  scopes: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/**
 * 建表。
 *
 * 不走 migration 链：这是运行时按需创建的本地辅助表，
 * 与用户笔记数据无关，且只在桌面端 Embedded Backend 里存在。
 * 放进正式迁移会让 Docker/NAS 部署也凭空多出一张永远为空的表。
 */
export function ensureClipperCredentialTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clipper_credentials (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      label TEXT,
      scopes TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      lastUsedAt TEXT,
      revokedAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_clipper_credentials_user
      ON clipper_credentials(userId, revokedAt);
  `);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedClipperCredential {
  id: string;
  /** 明文仅在签发时返回一次，之后无法再取回。 */
  token: string;
  scopes: ClipperScope[];
}

export function issueClipperCredential(
  db: Database.Database,
  userId: string,
  label?: string,
): IssuedClipperCredential {
  ensureClipperCredentialTable(db);

  const id = randomBytes(8).toString("hex");
  // 32 字节随机量：足够抵御离线爆破，且长度对扩展存储友好。
  const token = `nwclip_${randomBytes(32).toString("base64url")}`;
  const scopes = [...CLIPPER_SCOPES];

  db.prepare(`
    INSERT INTO clipper_credentials (id, userId, tokenHash, label, scopes, createdAt)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(id, userId, hashToken(token), label ?? null, JSON.stringify(scopes));

  return { id, token, scopes };
}

/**
 * 校验凭据。
 *
 * 用 timingSafeEqual 比较摘要，避免通过响应时间差逐字节猜测。
 * 注意这里比较的是摘要而非明文——摘要长度固定，天然满足等长要求。
 */
export function verifyClipperCredential(
  db: Database.Database,
  token: string,
): { userId: string; scopes: ClipperScope[] } | null {
  if (!token || !token.startsWith("nwclip_")) return null;
  ensureClipperCredentialTable(db);

  const digest = hashToken(token);
  const rows = db.prepare(
    "SELECT * FROM clipper_credentials WHERE revokedAt IS NULL",
  ).all() as ClipperCredentialRow[];

  for (const row of rows) {
    const a = Buffer.from(row.tokenHash, "hex");
    const b = Buffer.from(digest, "hex");
    if (a.length !== b.length) continue;
    if (!timingSafeEqual(a, b)) continue;

    db.prepare("UPDATE clipper_credentials SET lastUsedAt = datetime('now') WHERE id = ?")
      .run(row.id);

    let scopes: ClipperScope[] = [...CLIPPER_SCOPES];
    try {
      const parsed = JSON.parse(row.scopes);
      if (Array.isArray(parsed)) {
        scopes = parsed.filter((s): s is ClipperScope =>
          (CLIPPER_SCOPES as readonly string[]).includes(s));
      }
    } catch {
      // 摘要已匹配，scopes 解析失败时退回默认最小集合而不是放行全部。
    }
    return { userId: row.userId, scopes };
  }
  return null;
}

export function revokeClipperCredential(db: Database.Database, id: string): void {
  ensureClipperCredentialTable(db);
  db.prepare("UPDATE clipper_credentials SET revokedAt = datetime('now') WHERE id = ?")
    .run(id);
}

export function listClipperCredentials(
  db: Database.Database,
  userId: string,
): Array<{ id: string; label: string | null; createdAt: string; lastUsedAt: string | null }> {
  ensureClipperCredentialTable(db);
  return db.prepare(`
    SELECT id, label, createdAt, lastUsedAt FROM clipper_credentials
    WHERE userId = ? AND revokedAt IS NULL
    ORDER BY createdAt DESC
  `).all(userId) as Array<{
    id: string; label: string | null; createdAt: string; lastUsedAt: string | null;
  }>;
}

export function hasScope(scopes: ClipperScope[], required: ClipperScope): boolean {
  return scopes.includes(required);
}
