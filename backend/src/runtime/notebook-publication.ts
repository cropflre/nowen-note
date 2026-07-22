import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import notebooksRouter from "../routes/notebooks.js";
import { sharedRouter } from "../routes/shares.js";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotebookPermission } from "../middleware/acl.js";
import { ensureNotebookAclOverridesTable } from "../queries/memberQueryService.js";
import { notebookMembersRepository, userSessionsRepository } from "../repositories/index.js";
import { signShareAccessToken, verifyLoginToken, verifyShareAccessToken } from "../lib/auth-security.js";
import {
  createAttachmentSignedUrl,
  createPublicationAttachmentScope,
} from "../lib/attachment-signed-url.js";
import { resolvePublicOrigin } from "../lib/shareUrlRewrite.js";
import { logAudit } from "../services/audit.js";
import { allowAnonymousAction, checkCredentialAttempt, getClientIp, hashClientIp, recordCredentialFailure, recordCredentialSuccess } from "../lib/share-credential-rate-limit.js";

export type NotebookPublicationAccessMode = "public" | "link" | "code" | "password";
export type NotebookPublicationPermission = "read" | "comment" | "write";

type PublicationRow = {
  id: string;
  notebookId: string;
  ownerId: string;
  token: string;
  accessMode: NotebookPublicationAccessMode;
  accessSecret: string | null;
  permission: NotebookPublicationPermission;
  credentialVersion: number;
  allowDownload: number;
  allowComment: number;
  allowEdit: number;
  allowReshare: number;
  expiresAt: string | null;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  name?: string;
  icon?: string | null;
  color?: string | null;
  ownerUsername?: string;
  ownerDisplayName?: string | null;
};

const PUBLICATION_INSTALLED = Symbol.for("nowen.notebookPublication.installed");
const PUBLICATION_TOKEN_BYTES = 32;
const COMMENT_MAX_LENGTH = 4000;
const NICKNAME_MAX_LENGTH = 32;

export function ensureNotebookPublicationTables(): void {
  const db = getDb();
  ensureNotebookAclOverridesTable();
  db.exec(`
    CREATE TABLE IF NOT EXISTS notebook_publications (
      id TEXT PRIMARY KEY,
      notebookId TEXT NOT NULL UNIQUE,
      ownerId TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      accessMode TEXT NOT NULL DEFAULT 'link'
        CHECK(accessMode IN ('public', 'link', 'code', 'password')),
      accessSecret TEXT,
      permission TEXT NOT NULL DEFAULT 'read'
        CHECK(permission IN ('read', 'comment', 'write')),
      credentialVersion INTEGER NOT NULL DEFAULT 1,
      allowDownload INTEGER NOT NULL DEFAULT 1,
      allowComment INTEGER NOT NULL DEFAULT 0,
      allowEdit INTEGER NOT NULL DEFAULT 0,
      allowReshare INTEGER NOT NULL DEFAULT 0,
      expiresAt TEXT,
      isActive INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (notebookId) REFERENCES notebooks(id) ON DELETE CASCADE,
      FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notebook_publications_public
      ON notebook_publications(accessMode, isActive, updatedAt);

    CREATE TABLE IF NOT EXISTS notebook_public_comments (
      id TEXT PRIMARY KEY,
      publicationId TEXT NOT NULL,
      noteId TEXT NOT NULL,
      nickname TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (publicationId) REFERENCES notebook_publications(id) ON DELETE CASCADE,
      FOREIGN KEY (noteId) REFERENCES notes(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_notebook_public_comments_note
      ON notebook_public_comments(publicationId, noteId, createdAt);
  `);
  const publicationColumns = db.prepare("PRAGMA table_info(notebook_publications)").all() as { name: string }[];
  if (!publicationColumns.some((column) => column.name === "credentialVersion")) {
    db.prepare("ALTER TABLE notebook_publications ADD COLUMN credentialVersion INTEGER NOT NULL DEFAULT 1").run();
  }
}

function generatePublicationToken(): string {
  return crypto.randomBytes(PUBLICATION_TOKEN_BYTES).toString("base64url");
}

function isExpired(value: string | null | undefined): boolean {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time <= Date.now();
}

function publicationByToken(token: string): PublicationRow | undefined {
  ensureNotebookPublicationTables();
  return getDb().prepare(`
    SELECT p.*, nb.name, nb.icon, nb.color,
           u.username AS ownerUsername, u.displayName AS ownerDisplayName
    FROM notebook_publications p
    JOIN notebooks nb ON nb.id = p.notebookId
    JOIN users u ON u.id = p.ownerId
    WHERE p.token = ? AND nb.isDeleted = 0
  `).get(token) as PublicationRow | undefined;
}

function validatePublication(row: PublicationRow | undefined):
  | { ok: true; publication: PublicationRow }
  | { ok: false; status: 404 | 410; error: string; code: string } {
  if (!row) return { ok: false, status: 404, error: "发布内容不存在", code: "PUBLICATION_NOT_FOUND" };
  if (!row.isActive) return { ok: false, status: 410, error: "发布已撤销", code: "PUBLICATION_REVOKED" };
  if (isExpired(row.expiresAt)) return { ok: false, status: 410, error: "发布链接已过期", code: "PUBLICATION_EXPIRED" };
  return { ok: true, publication: row };
}

function requiresSecret(row: PublicationRow): boolean {
  return row.accessMode === "code" || row.accessMode === "password";
}

function verifyPublicationAccess(c: any, row: PublicationRow): boolean {
  if (!requiresSecret(row)) return true;
  const auth = c.req.header("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return false;
  return !!verifyShareAccessToken(auth.slice(7), row.id, row.credentialVersion);
}

function noStore(c: any): void {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
}

function noteBelongsToPublication(publicationId: string, noteId: string): boolean {
  const row = getDb().prepare(`
    WITH RECURSIVE published_tree(id) AS (
      SELECT notebookId FROM notebook_publications WHERE id = ?
      UNION ALL
      SELECT child.id
      FROM notebooks child
      JOIN published_tree parent ON child.parentId = parent.id
      WHERE child.isDeleted = 0
    )
    SELECT 1 AS ok
    FROM notes
    WHERE id = ?
      AND notebookId IN (SELECT id FROM published_tree)
      AND isTrashed = 0
      AND isLocked = 0
    LIMIT 1
  `).get(publicationId, noteId) as { ok: number } | undefined;
  return !!row;
}

function attachmentUrlsForNote(c: any, publication: PublicationRow, noteId: string): Record<string, string> {
  const rows = getDb()
    .prepare("SELECT id FROM attachments WHERE noteId = ? ORDER BY id ASC")
    .all(noteId) as Array<{ id: string }>;
  const origin = (resolvePublicOrigin((name) => c.req.header(name)) || "").replace(/\/+$/, "");
  const scope = createPublicationAttachmentScope(publication.id, noteId, publication.allowDownload !== 0);
  const urls: Record<string, string> = {};
  for (const row of rows) {
    const path = `/api/attachments/${row.id}`;
    urls[row.id] = createAttachmentSignedUrl(origin ? `${origin}${path}` : path, row.id, scope);
  }
  return urls;
}

function rewriteAttachmentUrls(content: string, urls: Record<string, string>): string {
  if (!content) return content;
  return content.replace(
    /(?:https?:\/\/[^\s"'<>]+)?\/api\/attachments\/([0-9a-fA-F-]{36})(?:\?[^\s"'<>)]*)?/g,
    (match, attachmentId: string) => urls[attachmentId] || match,
  );
}

function parseAccessMode(value: unknown): NotebookPublicationAccessMode | null {
  return value === "public" || value === "link" || value === "code" || value === "password"
    ? value
    : null;
}

function parsePublicationPermission(value: unknown): NotebookPublicationPermission | null {
  return value === "read" || value === "comment" || value === "write" ? value : null;
}

function publicationResponse(row: PublicationRow | undefined) {
  if (!row) return null;
  const { accessSecret: _secret, ...safe } = row;
  return { ...safe, hasSecret: !!row.accessSecret };
}

function requireManageNotebook(c: any, notebookId: string): { ok: true; userId: string } | { ok: false; response: Response } {
  const userId = c.req.header("X-User-Id") || "";
  const { permission } = resolveNotebookPermission(notebookId, userId);
  if (!hasPermission(permission, "manage")) {
    return { ok: false, response: c.json({ error: "无权管理该目录", code: "FORBIDDEN" }, 403) };
  }
  return { ok: true, userId };
}

// ---------------------------------------------------------------------------
// 公开访问：挂载到现有 /api/shared 前缀下，因此无需登录 JWT。
// ---------------------------------------------------------------------------

sharedRouter.get("/notebook-public/index", (c) => {
  ensureNotebookPublicationTables();
  noStore(c);
  const rows = getDb().prepare(`
    WITH RECURSIVE tree(publicationId, notebookId) AS (
      SELECT p.id, p.notebookId
      FROM notebook_publications p
      JOIN notebooks root ON root.id = p.notebookId
      WHERE p.accessMode = 'public'
        AND p.isActive = 1
        AND root.isDeleted = 0
        AND (p.expiresAt IS NULL OR p.expiresAt > datetime('now'))
      UNION ALL
      SELECT tree.publicationId, child.id
      FROM tree
      JOIN notebooks child ON child.parentId = tree.notebookId
      WHERE child.isDeleted = 0
    )
    SELECT p.token, p.notebookId, p.permission, p.allowDownload, p.allowComment,
           p.updatedAt, nb.name, nb.icon, nb.color,
           u.username AS ownerUsername, u.displayName AS ownerDisplayName,
           COUNT(DISTINCT CASE WHEN n.isTrashed = 0 AND n.isLocked = 0 THEN n.id END) AS noteCount
    FROM notebook_publications p
    JOIN notebooks nb ON nb.id = p.notebookId
    JOIN users u ON u.id = p.ownerId
    LEFT JOIN tree ON tree.publicationId = p.id
    LEFT JOIN notes n ON n.notebookId = tree.notebookId
    WHERE p.accessMode = 'public'
      AND p.isActive = 1
      AND nb.isDeleted = 0
      AND (p.expiresAt IS NULL OR p.expiresAt > datetime('now'))
    GROUP BY p.id
    ORDER BY p.updatedAt DESC
    LIMIT 100
  `).all();
  return c.json(rows);
});

sharedRouter.get("/notebook-public/:token", (c) => {
  noStore(c);
  const checked = validatePublication(publicationByToken(c.req.param("token")));
  if (!checked.ok) return c.json({ error: checked.error, code: checked.code }, checked.status);
  const p = checked.publication;
  return c.json({
    token: p.token,
    notebookId: p.notebookId,
    name: p.name,
    icon: p.icon,
    color: p.color,
    ownerUsername: p.ownerUsername,
    ownerDisplayName: p.ownerDisplayName,
    accessMode: p.accessMode,
    permission: p.permission,
    allowDownload: !!p.allowDownload,
    allowComment: !!p.allowComment,
    allowEdit: !!p.allowEdit,
    allowReshare: !!p.allowReshare,
    expiresAt: p.expiresAt,
    needSecret: requiresSecret(p),
    secretLabel: p.accessMode === "code" ? "访问码" : p.accessMode === "password" ? "密码" : null,
  });
});

sharedRouter.post("/notebook-public/:token/verify", async (c) => {
  noStore(c);
  const checked = validatePublication(publicationByToken(c.req.param("token")));
  if (!checked.ok) return c.json({ error: checked.error, code: checked.code }, checked.status);
  const p = checked.publication;
  const ipHash = hashClientIp(getClientIp(c));
  const rateKey = `publication:${p.id}:${ipHash}`;
  const rate = checkCredentialAttempt(rateKey);
  if (!rate.allowed) {
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return c.json({ error: "验证尝试过于频繁，请稍后再试", code: "SHARE_CREDENTIAL_RATE_LIMIT" }, 429);
  }
  if (!requiresSecret(p)) {
    recordCredentialSuccess(rateKey);
    return c.json({ success: true, accessToken: signShareAccessToken({
      shareId: p.id, noteId: p.notebookId, credentialVersion: p.credentialVersion,
    }) });
  }
  const body = await c.req.json().catch(() => ({}));
  const secret = String(body.secret || "").trim();
  if (!secret) return c.json({ error: `请输入${p.accessMode === "code" ? "访问码" : "密码"}` }, 400);
  if (!p.accessSecret || !(await bcrypt.compare(secret, p.accessSecret))) {
    recordCredentialFailure(rateKey);
    logAudit("", "notebook_publication", "credential_failure", { publicationId: p.id, ipHash }, {
      targetType: "notebook_publication", targetId: p.id, ip: ipHash, level: "warn",
    });
    return c.json({ error: "访问凭证错误" }, 403);
  }
  recordCredentialSuccess(rateKey);
  return c.json({ success: true, accessToken: signShareAccessToken({
    shareId: p.id, noteId: p.notebookId, credentialVersion: p.credentialVersion,
  }) });
});

sharedRouter.get("/notebook-public/:token/tree", (c) => {
  noStore(c);
  const checked = validatePublication(publicationByToken(c.req.param("token")));
  if (!checked.ok) return c.json({ error: checked.error, code: checked.code }, checked.status);
  const p = checked.publication;
  if (!verifyPublicationAccess(c, p)) {
    return c.json({ error: "需要验证访问凭证", code: "PUBLICATION_SECRET_REQUIRED", needSecret: true }, 401);
  }

  const notebooks = getDb().prepare(`
    WITH RECURSIVE tree(id, parentId, depth) AS (
      SELECT id, parentId, 0 FROM notebooks WHERE id = ? AND isDeleted = 0
      UNION ALL
      SELECT child.id, child.parentId, tree.depth + 1
      FROM notebooks child
      JOIN tree ON child.parentId = tree.id
      WHERE child.isDeleted = 0
    )
    SELECT nb.id, nb.parentId, nb.name, nb.icon, nb.color, nb.sortOrder, tree.depth
    FROM tree JOIN notebooks nb ON nb.id = tree.id
    ORDER BY tree.depth ASC, nb.sortOrder ASC, nb.name ASC
  `).all(p.notebookId);

  const notes = getDb().prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM notebooks WHERE id = ? AND isDeleted = 0
      UNION ALL
      SELECT child.id FROM notebooks child JOIN tree ON child.parentId = tree.id WHERE child.isDeleted = 0
    )
    SELECT id, notebookId, title, contentText, contentFormat, updatedAt
    FROM notes
    WHERE notebookId IN (SELECT id FROM tree)
      AND isTrashed = 0
      AND isLocked = 0
    ORDER BY isPinned DESC, sortOrder ASC, updatedAt DESC
  `).all(p.notebookId);

  return c.json({ notebooks, notes });
});

sharedRouter.get("/notebook-public/:token/notes/:noteId", (c) => {
  noStore(c);
  const checked = validatePublication(publicationByToken(c.req.param("token")));
  if (!checked.ok) return c.json({ error: checked.error, code: checked.code }, checked.status);
  const p = checked.publication;
  if (!verifyPublicationAccess(c, p)) {
    return c.json({ error: "需要验证访问凭证", code: "PUBLICATION_SECRET_REQUIRED", needSecret: true }, 401);
  }
  const noteId = c.req.param("noteId");
  if (!noteBelongsToPublication(p.id, noteId)) {
    return c.json({ error: "笔记不存在或未发布", code: "PUBLIC_NOTE_NOT_FOUND" }, 404);
  }
  const note = getDb().prepare(`
    SELECT id, notebookId, title, content, contentText, contentFormat, updatedAt, version
    FROM notes WHERE id = ?
  `).get(noteId) as any;
  const attachmentUrls = attachmentUrlsForNote(c, p, noteId);
  return c.json({
    ...note,
    content: rewriteAttachmentUrls(note.content || "", attachmentUrls),
    attachmentUrls,
    permission: p.permission,
    allowDownload: !!p.allowDownload,
    allowComment: !!p.allowComment,
    allowEdit: !!p.allowEdit,
  });
});

sharedRouter.get("/notebook-public/:token/notes/:noteId/comments", (c) => {
  noStore(c);
  const checked = validatePublication(publicationByToken(c.req.param("token")));
  if (!checked.ok) return c.json({ error: checked.error, code: checked.code }, checked.status);
  const p = checked.publication;
  if (!verifyPublicationAccess(c, p)) return c.json({ error: "需要验证访问凭证" }, 401);
  if (!p.allowComment && p.permission === "read") return c.json({ error: "此发布未开放评论" }, 403);
  const noteId = c.req.param("noteId");
  if (!noteBelongsToPublication(p.id, noteId)) return c.json({ error: "笔记不存在或未发布" }, 404);
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") || 50)));
  const offset = Math.max(0, Number(c.req.query("offset") || 0));
  const rows = getDb().prepare(`
    SELECT sc.id, sc.guestName AS nickname, sc.content, sc.isResolved, sc.createdAt
    FROM share_comments sc
    WHERE sc.sourceType = 'notebook_publication' AND sc.sourceId = ? AND sc.noteId = ? AND sc.isHidden = 0
    ORDER BY sc.createdAt ASC LIMIT ? OFFSET ?
  `).all(p.id, noteId, limit, offset);
  return c.json(rows);
});

sharedRouter.post("/notebook-public/:token/notes/:noteId/comments", async (c) => {
  noStore(c);
  const checked = validatePublication(publicationByToken(c.req.param("token")));
  if (!checked.ok) return c.json({ error: checked.error, code: checked.code }, checked.status);
  const p = checked.publication;
  if (!verifyPublicationAccess(c, p)) return c.json({ error: "需要验证访问凭证" }, 401);
  if (!p.allowComment && p.permission === "read") {
    return c.json({ error: "此发布未开放评论", code: "PUBLIC_COMMENT_FORBIDDEN" }, 403);
  }
  const noteId = c.req.param("noteId");
  if (!noteBelongsToPublication(p.id, noteId)) return c.json({ error: "笔记不存在或未发布" }, 404);
  const body = await c.req.json().catch(() => ({}));
  if (String(body._hp || "").trim()) return c.json({ ok: true, suppressed: true });
  const nickname = String(body.nickname || "").trim();
  const content = String(body.content || "").trim();
  if (!nickname || nickname.length > NICKNAME_MAX_LENGTH) {
    return c.json({ error: `昵称长度需为 1-${NICKNAME_MAX_LENGTH} 个字符` }, 400);
  }
  if (!content || content.length > 1000) return c.json({ error: "评论长度需为 1-1000 个字符" }, 400);
  const ipHash = hashClientIp(getClientIp(c));
  if (!allowAnonymousAction("publication-comment", `${p.id}:${noteId}:${ipHash}`, 20, 60_000)) {
    return c.json({ error: "评论过于频繁，请稍后再试" }, 429);
  }
  const id = uuid();
  getDb().prepare(`
    INSERT INTO share_comments (
      id, noteId, userId, guestName, guestIpHash, content,
      sourceType, sourceId, isHidden, isResolved
    ) VALUES (?, ?, NULL, ?, ?, ?, 'notebook_publication', ?, 0, 0)
  `).run(id, noteId, nickname, ipHash, content, p.id);
  return c.json({ id, nickname, content, isResolved: 0, createdAt: new Date().toISOString() }, 201);
});

sharedRouter.post("/notebook-public/:token/join", async (c) => {
  noStore(c);
  const checked = validatePublication(publicationByToken(c.req.param("token")));
  if (!checked.ok) return c.json({ error: checked.error, code: checked.code }, checked.status);
  const p = checked.publication;
  const body = await c.req.json().catch(() => ({}));
  if (requiresSecret(p)) {
    const accessToken = String(body.accessToken || "");
    if (!verifyShareAccessToken(accessToken, p.id, p.credentialVersion)) {
      return c.json({ error: "访问凭证无效或已过期" }, 401);
    }
  }

  const auth = c.req.header("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return c.json({ error: "请先登录", code: "LOGIN_REQUIRED" }, 401);
  const login = verifyLoginToken(auth.slice(7));
  if (!login?.userId) return c.json({ error: "登录已失效", code: "LOGIN_REQUIRED" }, 401);
  const user = getDb().prepare("SELECT tokenVersion, isDisabled FROM users WHERE id = ?")
    .get(login.userId) as { tokenVersion: number; isDisabled: number } | undefined;
  if (!user || user.isDisabled || (login.tver ?? 0) !== (user.tokenVersion ?? 0)) {
    return c.json({ error: "登录已失效", code: "LOGIN_REQUIRED" }, 401);
  }
  if (login.jti) {
    const session = userSessionsRepository.getByIdAndUser(login.jti, login.userId);
    if (!session || session.revokedAt) return c.json({ error: "登录已失效", code: "LOGIN_REQUIRED" }, 401);
  }
  if (p.ownerId === login.userId) return c.json({ success: true, notebookId: p.notebookId, role: "owner" });

  const role = p.permission === "write" && p.allowEdit ? "editor" : "viewer";
  notebookMembersRepository.upsert({
    id: `${p.notebookId}:${login.userId}`,
    notebookId: p.notebookId,
    userId: login.userId,
    role,
    invitedBy: p.ownerId,
    allowDownload: !!p.allowDownload,
    allowReshare: !!p.allowReshare,
    source: "publication",
    sourceId: p.id,
  });
  return c.json({ success: true, notebookId: p.notebookId, role });
});

// ---------------------------------------------------------------------------
// 管理接口：挂载到 /api/notebooks，经过全局登录 JWT。
// ---------------------------------------------------------------------------

notebooksRouter.get("/:id/publication", (c) => {
  ensureNotebookPublicationTables();
  const notebookId = c.req.param("id");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  const row = getDb().prepare("SELECT * FROM notebook_publications WHERE notebookId = ?")
    .get(notebookId) as PublicationRow | undefined;
  return c.json(publicationResponse(row));
});

notebooksRouter.put("/:id/publication", async (c) => {
  ensureNotebookPublicationTables();
  const notebookId = c.req.param("id");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  const body = await c.req.json().catch(() => ({}));
  const accessMode = parseAccessMode(body.accessMode);
  const permission = parsePublicationPermission(body.permission);
  if (!accessMode || !permission) {
    return c.json({ error: "accessMode 或 permission 无效" }, 400);
  }

  const existing = getDb().prepare("SELECT * FROM notebook_publications WHERE notebookId = ?")
    .get(notebookId) as PublicationRow | undefined;
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  let accessSecret = existing?.accessSecret || null;
  let credentialChanged = false;
  if (accessMode === "code" || accessMode === "password") {
    if (secret) { accessSecret = await bcrypt.hash(secret, 10); credentialChanged = true; }
    if (!accessSecret) return c.json({ error: `请设置${accessMode === "code" ? "访问码" : "密码"}` }, 400);
  } else {
    if (accessSecret) credentialChanged = true;
    accessSecret = null;
  }

  const allowComment = body.allowComment === true || permission === "comment" || permission === "write" ? 1 : 0;
  const allowEdit = body.allowEdit === true && permission === "write" ? 1 : 0;
  const allowDownload = body.allowDownload === false ? 0 : 1;
  const allowReshare = body.allowReshare === true ? 1 : 0;
  const expiresAt = typeof body.expiresAt === "string" && body.expiresAt.trim() ? body.expiresAt.trim() : null;
  const id = existing?.id || uuid();
  // 撤销后重新发布必须换 token，确保旧链接不会“复活”。
  const token = !existing || !existing.isActive ? generatePublicationToken() : existing.token;

  getDb().prepare(`
    INSERT INTO notebook_publications (
      id, notebookId, ownerId, token, accessMode, accessSecret, permission,
      allowDownload, allowComment, allowEdit, allowReshare, expiresAt, isActive, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(notebookId) DO UPDATE SET
      ownerId = excluded.ownerId,
      token = excluded.token,
      credentialVersion = CASE WHEN ? = 1 THEN notebook_publications.credentialVersion + 1 ELSE notebook_publications.credentialVersion END,
      accessMode = excluded.accessMode,
      accessSecret = excluded.accessSecret,
      permission = excluded.permission,
      allowDownload = excluded.allowDownload,
      allowComment = excluded.allowComment,
      allowEdit = excluded.allowEdit,
      allowReshare = excluded.allowReshare,
      expiresAt = excluded.expiresAt,
      isActive = 1,
      updatedAt = datetime('now')
  `).run(
    id, notebookId, access.userId, token, accessMode, accessSecret, permission,
    allowDownload, allowComment, allowEdit, allowReshare, expiresAt, credentialChanged ? 1 : 0,
  );

  logAudit(access.userId, "notebook_publication", existing ? "update" : "create", {
    notebookId, accessMode, permission, allowDownload, allowComment, allowEdit, allowReshare,
  }, { targetType: "notebook", targetId: notebookId });

  if (existing) {
    notebookMembersRepository.restrictBySource("publication", existing.id, {
      role: permission === "write" && allowEdit ? "editor" : "viewer",
      allowDownload: !!allowDownload,
      allowReshare: !!allowReshare,
    });
  }

  const updated = getDb().prepare("SELECT * FROM notebook_publications WHERE notebookId = ?")
    .get(notebookId) as PublicationRow;
  return c.json(publicationResponse(updated), existing ? 200 : 201);
});

notebooksRouter.delete("/:id/publication", (c) => {
  ensureNotebookPublicationTables();
  const notebookId = c.req.param("id");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  const result = getDb().prepare(`
    UPDATE notebook_publications
    SET isActive = 0, updatedAt = datetime('now')
    WHERE notebookId = ? AND isActive = 1
  `).run(notebookId);
  const publication = getDb().prepare("SELECT id FROM notebook_publications WHERE notebookId = ?").get(notebookId) as { id: string } | undefined;
  const removedMembers = publication ? notebookMembersRepository.removeBySource("publication", publication.id) : 0;
  logAudit(access.userId, "notebook_publication", "revoke", { notebookId, removedMembers }, { targetType: "notebook", targetId: notebookId });
  return c.json({ success: true, revoked: result.changes > 0, removedMembers });
});

notebooksRouter.get("/:id/publication/comments", (c) => {
  const notebookId = c.req.param("id");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  const publication = getDb().prepare("SELECT id FROM notebook_publications WHERE notebookId = ?")
    .get(notebookId) as { id: string } | undefined;
  if (!publication) return c.json([]);
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") || 100)));
  const rows = getDb().prepare(`
    SELECT sc.id, sc.noteId, n.title AS noteTitle,
           COALESCE(NULLIF(sc.guestName, ''), u.displayName, u.username, '匿名') AS nickname,
           sc.content, sc.isResolved, sc.isHidden, sc.createdAt
    FROM share_comments sc
    JOIN notes n ON n.id = sc.noteId
    LEFT JOIN users u ON u.id = sc.userId
    WHERE sc.sourceType = 'notebook_publication' AND sc.sourceId = ?
    ORDER BY sc.createdAt DESC LIMIT ?
  `).all(publication.id, limit);
  return c.json(rows);
});

notebooksRouter.patch("/:id/publication/comments/:commentId", async (c) => {
  const notebookId = c.req.param("id");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  const publication = getDb().prepare("SELECT id FROM notebook_publications WHERE notebookId = ?")
    .get(notebookId) as { id: string } | undefined;
  if (!publication) return c.json({ error: "发布不存在" }, 404);
  const commentId = c.req.param("commentId");
  const comment = getDb().prepare(`
    SELECT id, isResolved, isHidden FROM share_comments
    WHERE id = ? AND sourceType = 'notebook_publication' AND sourceId = ?
  `).get(commentId, publication.id) as { id: string; isResolved: number; isHidden: number } | undefined;
  if (!comment) return c.json({ error: "评论不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const resolved = body.isResolved === undefined ? comment.isResolved : body.isResolved ? 1 : 0;
  const hidden = body.isHidden === undefined ? comment.isHidden : body.isHidden ? 1 : 0;
  getDb().prepare("UPDATE share_comments SET isResolved = ?, isHidden = ?, updatedAt = datetime('now') WHERE id = ?")
    .run(resolved, hidden, commentId);
  return c.json({ success: true, id: commentId, isResolved: resolved, isHidden: hidden });
});

notebooksRouter.delete("/:id/publication/comments/:commentId", (c) => {
  const notebookId = c.req.param("id");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  const publication = getDb().prepare("SELECT id FROM notebook_publications WHERE notebookId = ?")
    .get(notebookId) as { id: string } | undefined;
  if (!publication) return c.json({ error: "发布不存在" }, 404);
  const result = getDb().prepare(`
    DELETE FROM share_comments
    WHERE id = ? AND sourceType = 'notebook_publication' AND sourceId = ?
  `).run(c.req.param("commentId"), publication.id);
  if (!result.changes) return c.json({ error: "评论不存在" }, 404);
  return c.json({ success: true });
});

notebooksRouter.get("/:id/permission-overrides", (c) => {
  ensureNotebookPublicationTables();
  const notebookId = c.req.param("id");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  const direct = getDb().prepare(`
    SELECT acl.notebookId, acl.userId, acl.permission, acl.allowDownload, acl.allowReshare,
           acl.createdBy, acl.createdAt, acl.updatedAt,
           u.username, u.displayName, u.email
    FROM notebook_acl_overrides acl
    JOIN users u ON u.id = acl.userId
    WHERE acl.notebookId = ?
    ORDER BY COALESCE(u.displayName, u.username) COLLATE NOCASE
  `).all(notebookId);
  const parent = getDb().prepare("SELECT parentId FROM notebooks WHERE id = ?").get(notebookId) as { parentId: string | null } | undefined;
  return c.json({ direct, inheritsFromParent: parent?.parentId || null });
});

notebooksRouter.put("/:id/permission-overrides/:targetUserId", async (c) => {
  ensureNotebookPublicationTables();
  const notebookId = c.req.param("id");
  const targetUserId = c.req.param("targetUserId");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  const notebook = getDb().prepare("SELECT userId FROM notebooks WHERE id = ? AND isDeleted = 0")
    .get(notebookId) as { userId: string } | undefined;
  if (!notebook) return c.json({ error: "目录不存在" }, 404);
  if (notebook.userId === targetUserId) return c.json({ error: "不能覆盖目录拥有者权限" }, 400);
  const target = getDb().prepare("SELECT id FROM users WHERE id = ? AND isDisabled = 0")
    .get(targetUserId) as { id: string } | undefined;
  if (!target) return c.json({ error: "用户不存在" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const permission = String(body.permission || "");
  if (!["none", "read", "comment", "write", "manage"].includes(permission)) {
    return c.json({ error: "permission 无效" }, 400);
  }
  const allowDownload = body.allowDownload === false ? 0 : 1;
  const allowReshare = body.allowReshare === true ? 1 : 0;
  getDb().prepare(`
    INSERT INTO notebook_acl_overrides (
      notebookId, userId, permission, allowDownload, allowReshare, createdBy, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(notebookId, userId) DO UPDATE SET
      permission = excluded.permission,
      allowDownload = excluded.allowDownload,
      allowReshare = excluded.allowReshare,
      createdBy = excluded.createdBy,
      updatedAt = datetime('now')
  `).run(notebookId, targetUserId, permission, allowDownload, allowReshare, access.userId);
  return c.json({ success: true, notebookId, userId: targetUserId, permission, allowDownload: !!allowDownload, allowReshare: !!allowReshare });
});

notebooksRouter.delete("/:id/permission-overrides/:targetUserId", (c) => {
  ensureNotebookPublicationTables();
  const notebookId = c.req.param("id");
  const targetUserId = c.req.param("targetUserId");
  const access = requireManageNotebook(c, notebookId);
  if (!access.ok) return access.response;
  getDb().prepare("DELETE FROM notebook_acl_overrides WHERE notebookId = ? AND userId = ?")
    .run(notebookId, targetUserId);
  return c.json({ success: true });
});

if (!(globalThis as any)[PUBLICATION_INSTALLED]) {
  (globalThis as any)[PUBLICATION_INSTALLED] = true;
  ensureNotebookPublicationTables();
}
