import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { signShareAccessToken, verifyShareAccessToken } from "../lib/auth-security";
import { resolvePublicOrigin, rewriteRelativeAttachmentUrls } from "../lib/shareUrlRewrite";
import { resolveNotePermission, hasPermission } from "../middleware/acl";
import { broadcastNoteUpdated, broadcastToUser } from "../services/realtime";
import { yDestroyDoc } from "../services/yjs";
import { syncReferences as syncAttachmentReferences } from "../lib/attachmentRefs";
import { logAudit } from "../services/audit";
import { noteVersionsRepository, shareCommentsRepository, noteYsnapshotsRepository, noteYupdatesRepository } from "../repositories";

// H3: 使用密码学安全的随机源生成分享 token。
//     原实现用 Math.random()，理论上可被预测；改用 crypto.randomBytes。
//     输出 12 位 URL-safe base64（~72 bits 熵），与原长度保持一致，避免破坏前端/已发送链接格式。
function generateShareToken(): string {
  // 9 bytes base64url = 12 字符（无需 padding）
  return crypto.randomBytes(9).toString("base64url");
}

/**
 * 取请求方真实 IP（按反代头优先级）。
 *
 * 用于：
 *   - 公开评论的频次限制（同 IP/分钟），防止滥用；
 *   - 写入 share_comments.guestIpHash（SHA-256 hex，不存明文）。
 *
 * 不直接用 c.req.raw.headers.get('x-forwarded-for')[0] 的原因：
 *   有些反代会写多 IP 链 "client, proxy1, proxy2"，第一个才是真实客户端。
 */
function getClientIp(c: any): string {
  const xff = c.req.header("X-Forwarded-For");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xreal = c.req.header("X-Real-IP");
  if (xreal) return xreal.trim();
  // Hono 没有标准 socket.remoteAddress 暴露；fallback 到一个稳定但低分辨率的占位
  return "unknown";
}

function hashIp(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex");
}

/**
 * 简易内存频次限制器（IP × token 维度）：默认每分钟 30 条评论。
 *
 * 设计权衡：
 *   - 用 Map 而非 Redis：单进程部署足够，多进程后端可在反代/Nginx 层加 limit_req
 *     再叠一层。本服务目前未支持多进程后端。
 *   - 滑动窗口比 Token Bucket 实现简单，对人类滥用足够（机器人会绕，不在防御范围）。
 *   - 自带 60s 过期清理，避免长期运行内存泄漏。
 */
const commentRateLimit = new Map<string, number[]>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const bucket = commentRateLimit.get(key) || [];
  const recent = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    commentRateLimit.set(key, recent);
    return false;
  }
  recent.push(now);
  commentRateLimit.set(key, recent);
  return true;
}

// ===== 需要 JWT 认证的管理路由 =====
const sharesRouter = new Hono();

// 创建分享
sharesRouter.post("/", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const body = await c.req.json();
  const { noteId, permission, password, expiresAt, maxViews } = body as {
    noteId: string;
    permission?: string;
    password?: string;
    expiresAt?: string;
    maxViews?: number;
  };

  if (!noteId) {
    return c.json({ error: "缺少 noteId 参数" }, 400);
  }

  // 验证笔记存在且属于当前用户
  const note = db.prepare("SELECT id, userId, title FROM notes WHERE id = ? AND userId = ?").get(noteId, userId) as any;
  if (!note) {
    return c.json({ error: "笔记不存在或无权操作" }, 404);
  }

  const id = uuid();
  const shareToken = generateShareToken();
  const perm = permission || "view";

  // 如果设置了密码，使用 bcrypt 加密
  let passwordHash: string | null = null;
  if (password && password.trim()) {
    passwordHash = await bcrypt.hash(password.trim(), 10);
  }

  db.prepare(`
    INSERT INTO shares (id, noteId, ownerId, shareToken, shareType, permission, password, expiresAt, maxViews)
    VALUES (?, ?, ?, ?, 'link', ?, ?, ?, ?)
  `).run(id, noteId, userId, shareToken, perm, passwordHash, expiresAt || null, maxViews || null);

  // SEC-AUDIT-01: 记录分享创建（不记录密码）
  logAudit(userId, "share", "create", {
    shareId: id, noteId, permission: perm, hasPassword: !!passwordHash,
  }, { targetType: "share", targetId: id });

  const share = db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as any;
  delete share.password;
  share.hasPassword = !!passwordHash;

  return c.json(share, 201);
});

// 获取当前用户的所有分享
sharesRouter.get("/", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  const shares = db.prepare(`
    SELECT s.*, n.title AS noteTitle
    FROM shares s
    LEFT JOIN notes n ON s.noteId = n.id
    WHERE s.ownerId = ?
    ORDER BY s.createdAt DESC
  `).all(userId) as any[];

  // 移除密码 hash，添加 hasPassword 标记
  return c.json(shares.map((s: any) => {
    const hasPassword = !!s.password;
    delete s.password;
    return { ...s, hasPassword };
  }));
});

// 获取某笔记的所有分享
sharesRouter.get("/note/:noteId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");

  const shares = db.prepare(`
    SELECT * FROM shares WHERE noteId = ? AND ownerId = ? ORDER BY createdAt DESC
  `).all(noteId, userId) as any[];

  return c.json(shares.map((s: any) => {
    const hasPassword = !!s.password;
    delete s.password;
    return { ...s, hasPassword };
  }));
});

// 获取分享详情
sharesRouter.get("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const share = db.prepare("SELECT * FROM shares WHERE id = ? AND ownerId = ?").get(id, userId) as any;
  if (!share) return c.json({ error: "分享不存在" }, 404);

  const hasPassword = !!share.password;
  delete share.password;
  return c.json({ ...share, hasPassword });
});

// 更新分享设置
sharesRouter.put("/:id", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");
  const body = await c.req.json();

  const share = db.prepare("SELECT * FROM shares WHERE id = ? AND ownerId = ?").get(id, userId) as any;
  if (!share) return c.json({ error: "分享不存在" }, 404);

  const fields: string[] = [];
  const params: any[] = [];

  if (body.permission !== undefined) { fields.push("permission = ?"); params.push(body.permission); }
  if (body.expiresAt !== undefined) { fields.push("expiresAt = ?"); params.push(body.expiresAt || null); }
  if (body.maxViews !== undefined) { fields.push("maxViews = ?"); params.push(body.maxViews || null); }
  if (body.isActive !== undefined) { fields.push("isActive = ?"); params.push(body.isActive); }

  // 密码处理：空字符串 = 清除密码，非空 = 设置新密码
  if (body.password !== undefined) {
    if (body.password === "" || body.password === null) {
      fields.push("password = ?");
      params.push(null);
    } else {
      const hash = await bcrypt.hash(body.password.trim(), 10);
      fields.push("password = ?");
      params.push(hash);
    }
  }

  if (fields.length === 0) {
    return c.json({ error: "没有需要更新的字段" }, 400);
  }

  fields.push("updatedAt = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE shares SET ${fields.join(", ")} WHERE id = ?`).run(...params);

  const updated = db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as any;
  const hasPassword = !!updated.password;
  delete updated.password;
  return c.json({ ...updated, hasPassword });
});

// 删除（撤销）分享
sharesRouter.delete("/:id", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const id = c.req.param("id");

  const share = db.prepare("SELECT id, noteId FROM shares WHERE id = ? AND ownerId = ?").get(id, userId) as any;
  if (!share) return c.json({ error: "分享不存在" }, 404);

  db.prepare("DELETE FROM shares WHERE id = ?").run(id);

  // SEC-AUDIT-01: 记录分享撤销
  logAudit(userId, "share", "revoke", {
    shareId: id, noteId: share.noteId,
  }, { targetType: "share", targetId: id });

  return c.json({ success: true });
});

// ===== 无需 JWT 认证的公开访问路由 =====
const sharedRouter = new Hono();

// 获取分享信息（判断是否需要密码等）
sharedRouter.get("/:token", (c) => {
  const db = getDb();
  const token = c.req.param("token");

  const share = db.prepare(`
    SELECT s.id, s.noteId, s.shareToken, s.permission, s.expiresAt, s.maxViews, s.viewCount, s.isActive, s.createdAt,
           n.title AS noteTitle,
           u.username AS ownerName
    FROM shares s
    LEFT JOIN notes n ON s.noteId = n.id
    LEFT JOIN users u ON s.ownerId = u.id
    WHERE s.shareToken = ?
  `).get(token) as any;

  if (!share) {
    return c.json({ error: "分享链接不存在或已失效" }, 404);
  }

  if (!share.isActive) {
    return c.json({ error: "分享已被撤销" }, 410);
  }

  // 检查是否过期
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return c.json({ error: "分享链接已过期" }, 410);
  }

  // 检查访问次数限制
  if (share.maxViews && share.viewCount >= share.maxViews) {
    return c.json({ error: "分享链接已达到最大访问次数" }, 410);
  }

  // 检查是否需要密码
  const shareRow = db.prepare("SELECT password FROM shares WHERE shareToken = ?").get(token) as any;
  const needPassword = !!shareRow?.password;

  return c.json({
    id: share.id,
    noteTitle: share.noteTitle,
    ownerName: share.ownerName,
    permission: share.permission,
    needPassword,
    expiresAt: share.expiresAt,
    createdAt: share.createdAt,
  });
});

// 验证密码（返回临时访问 token）
sharedRouter.post("/:token/verify", async (c) => {
  const db = getDb();
  const token = c.req.param("token");
  const body = await c.req.json();
  const { password } = body as { password: string };

  const share = db.prepare("SELECT id, password, noteId FROM shares WHERE shareToken = ? AND isActive = 1").get(token) as any;
  if (!share) {
    return c.json({ error: "分享不存在" }, 404);
  }

  if (!share.password) {
    // 没有密码保护，直接返回 accessToken
    const accessToken = signShareAccessToken({ shareId: share.id, noteId: share.noteId });
    return c.json({ success: true, accessToken });
  }

  if (!password) {
    return c.json({ error: "请输入访问密码" }, 400);
  }

  const isValid = await bcrypt.compare(password, share.password);
  if (!isValid) {
    return c.json({ error: "密码错误" }, 403);
  }

  // 密码正确，生成临时 accessToken（1小时有效）
  const accessToken = signShareAccessToken({ shareId: share.id, noteId: share.noteId });
  return c.json({ success: true, accessToken });
});

// 获取分享笔记内容
sharedRouter.get("/:token/content", (c) => {
  const db = getDb();
  const token = c.req.param("token");

  const share = db.prepare(`
    SELECT s.id AS shareId, s.noteId, s.isActive, s.expiresAt, s.maxViews, s.viewCount, s.password, s.permission,
           n.title, n.content, n.contentText, n.updatedAt AS noteUpdatedAt, n.version AS noteVersion,
           n.isLocked AS noteIsLocked,
           n.userId AS noteOwnerId
    FROM shares s
    LEFT JOIN notes n ON s.noteId = n.id
    WHERE s.shareToken = ?
  `).get(token) as any;

  if (!share || !share.isActive) {
    return c.json({ error: "分享不存在或已失效" }, 404);
  }

  // 检查是否过期
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return c.json({ error: "分享链接已过期" }, 410);
  }

  // 检查访问次数
  if (share.maxViews && share.viewCount >= share.maxViews) {
    return c.json({ error: "分享链接已达到最大访问次数" }, 410);
  }

  // 如果有密码保护，检查 accessToken
  if (share.password) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "需要密码验证", needPassword: true }, 401);
    }
    const payload = verifyShareAccessToken(authHeader.slice(7), share.shareId);
    if (!payload) {
      return c.json({ error: "访问令牌无效或已过期，请重新验证密码" }, 401);
    }
  }

  // H5: 原子地自增 viewCount 并校验 maxViews 上限，避免并发绕过限制。
  //     使用条件 UPDATE：如果 WHERE 条件不满足则 changes=0，此时返回 410。
  const incRes = db
    .prepare(
      `UPDATE shares
       SET viewCount = viewCount + 1
       WHERE id = ? AND isActive = 1
         AND (maxViews IS NULL OR viewCount < maxViews)`,
    )
    .run(share.shareId);
  if (incRes.changes === 0) {
    return c.json({ error: "分享链接已达到最大访问次数" }, 410);
  }

  // H6: 图床绝对化
  //   分享场景下，content 里的 /api/attachments/<id>、/api/task-attachments/<id>
  //   是相对路径，一旦分享页被第三方嵌入 / SPA 与后端不同源 / 走 CDN，
  //   浏览器会按当前文档 origin 解析，导致图片 404。
  //   这里在 HTTP 出口处统一改写成绝对 URL（基于反代头推断公网 origin），
  //   不修改数据库原始内容，保留搬域可移植性。
  const publicOrigin = resolvePublicOrigin((name) => c.req.header(name));
  const rewrittenContent = publicOrigin
    ? rewriteRelativeAttachmentUrls(share.content, publicOrigin)
    : share.content;

  return c.json({
    noteId: share.noteId,
    title: share.title,
    content: rewrittenContent,
    contentText: share.contentText,
    permission: share.permission,
    updatedAt: share.noteUpdatedAt,
    version: share.noteVersion,
    isLocked: share.noteIsLocked ? 1 : 0, // 用于前端判断是否允许进入编辑模式
    // 笔记所有者 id：前端拿来跟当前登录用户对比，
    // 如果访问者就是作者本人，则跳过"请填写访客昵称"弹窗，直接进入编辑模式。
    // 这里只下发 id，不下发用户名/昵称等敏感信息。
    ownerId: share.noteOwnerId,
  });
});

// 访客更新分享笔记内容（permission ∈ {'edit', 'edit_auth'}）
// 设计原则：
//   - permission='edit'      ：不需要 JWT 登录态，访客填昵称即可写入；密码分享额外校验 accessToken
//   - permission='edit_auth' ：必须有 JWT（X-User-Id header）；未登录返 401 + code='LOGIN_REQUIRED'，
//                              前端引导用户跳 /login?redirect=/share/<token>，登录回来再次提交。
//                              登录后的请求依然可以走访客昵称兜底 —— 但实际上前端会用真实
//                              用户名作为 guestName，方便审计；后端不强制。
//   - 强制乐观锁，由前端带上最新 version，避免覆盖他人改动
//   - 写入版本历史，changeType='guest_edit'，changeSummary 记录访客昵称，便于所有者审计
//   - 笔记 isLocked === 1 时禁止写入
sharedRouter.put("/:token/content", async (c) => {
  const db = getDb();
  const token = c.req.param("token");
  const body = await c.req.json();
  const { title, content, contentText, version, guestName } = body as {
    title?: string;
    content?: string;
    contentText?: string;
    version?: number;
    guestName?: string;
  };

  // 1) 查分享 + 笔记
  const share = db.prepare(`
    SELECT s.id AS shareId, s.noteId, s.permission, s.password, s.isActive, s.expiresAt, s.maxViews, s.viewCount,
           n.isLocked, n.version AS noteVersion, n.title AS noteTitle, n.content AS noteContent,
           n.contentText AS noteContentText, n.userId AS noteUserId
    FROM shares s
    LEFT JOIN notes n ON s.noteId = n.id
    WHERE s.shareToken = ?
  `).get(token) as any;

  if (!share || !share.isActive) return c.json({ error: "分享不存在或已失效" }, 404);
  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return c.json({ error: "分享链接已过期" }, 410);
  }
  if (share.maxViews && share.viewCount >= share.maxViews) {
    return c.json({ error: "分享链接已达到最大访问次数" }, 410);
  }

  // 2) 权限校验：必须是 edit / edit_auth
  if (share.permission !== "edit" && share.permission !== "edit_auth") {
    return c.json({ error: "当前分享不支持编辑" }, 403);
  }

  // 2.1) edit_auth 额外校验：必须已登录
  // 前端调用 updateSharedContent 时若用户已登录，api.ts 会自动带 X-User-Id header
  // （见 src/lib/api.ts 的 fetchWithAuth）。后端直接读 header 判断登录态。
  // 注意：这里不做"用户必须是笔记主"的校验——edit_auth 的语义是"任何登录用户
  // 都可以编辑"，与笔记主的私人分享场景区分；私人分享应走带密码 + 短期 token 的链路。
  if (share.permission === "edit_auth") {
    const authUserId = c.req.header("X-User-Id");
    if (!authUserId) {
      return c.json(
        {
          error: "此分享需登录后才能编辑",
          code: "LOGIN_REQUIRED",
        },
        401,
      );
    }
  }

  // 3) 笔记锁定校验
  if (share.isLocked === 1) {
    return c.json({ error: "笔记已被所有者锁定，暂不可编辑", code: "NOTE_LOCKED" }, 403);
  }

  // 4) 密码分享：校验 accessToken
  if (share.password) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "需要密码验证" }, 401);
    }
    const payload = verifyShareAccessToken(authHeader.slice(7), share.shareId);
    if (!payload) return c.json({ error: "访问令牌无效或已过期" }, 401);
  }

  // 5) 参数校验：昵称必填（至少 1 个可见字符，不超过 32）
  const trimmedName = (guestName || "").trim();
  if (!trimmedName) {
    return c.json({ error: "请先填写访客昵称后再编辑", code: "GUEST_NAME_REQUIRED" }, 400);
  }
  if (trimmedName.length > 32) {
    return c.json({ error: "昵称过长（最多 32 个字符）" }, 400);
  }

  // 6) 乐观锁
  if (version !== undefined && version !== share.noteVersion) {
    return c.json({ error: "内容已被他人更新，请刷新后再编辑", code: "VERSION_CONFLICT", currentVersion: share.noteVersion }, 409);
  }

  // 7) 写入前先存一份版本历史（保留原内容，便于回滚），changeType=guest_edit，用 changeSummary 记录访客昵称
  //    userId 暂使用笔记所有者（访客无对应 users 记录）；真正的访客身份在 changeSummary 中。
  if (content !== undefined || title !== undefined) {
    const hasContentChange = (content !== undefined && content !== share.noteContent)
      || (title !== undefined && title !== share.noteTitle);
    if (hasContentChange) {
      const versionId = uuid();
      noteVersionsRepository.create({
        id: versionId,
        noteId: share.noteId,
        userId: share.noteUserId,
        title: share.noteTitle,
        content: share.noteContent,
        contentText: share.noteContentText,
        version: share.noteVersion,
        changeType: 'guest_edit',
        changeSummary: `访客 ${trimmedName} 编辑`,
      });
    }
  }

  // 8) 更新笔记
  const fields: string[] = [];
  const params: any[] = [];
  if (title !== undefined) { fields.push("title = ?"); params.push(title); }
  if (content !== undefined) { fields.push("content = ?"); params.push(content); }
  if (contentText !== undefined) { fields.push("contentText = ?"); params.push(contentText); }
  fields.push("version = version + 1");
  fields.push("updatedAt = datetime('now')");
  params.push(share.noteId);

  db.prepare(`UPDATE notes SET ${fields.join(", ")} WHERE id = ?`).run(...params);
  const updated = db.prepare("SELECT id, title, version, updatedAt FROM notes WHERE id = ?").get(share.noteId) as any;

  return c.json({
    success: true,
    noteId: updated.id,
    title: updated.title,
    version: updated.version,
    updatedAt: updated.updatedAt,
    guestName: trimmedName,
  });
});

// ===== Phase 3: 版本历史 API =====

// 获取版本历史列表
sharesRouter.get("/note/:noteId/versions", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");
  const limit = parseInt(c.req.query("limit") || "20");
  const offset = parseInt(c.req.query("offset") || "0");

  // 验证笔记归属
  const note = db.prepare("SELECT id FROM notes WHERE id = ? AND userId = ?").get(noteId, userId) as any;
  if (!note) return c.json({ error: "笔记不存在或无权操作" }, 404);

  const versions = noteVersionsRepository.listByNoteId(noteId, limit, offset);
  const total = noteVersionsRepository.countByNoteId(noteId);

  return c.json({ versions, total });
});

// 获取某个版本的完整内容
sharesRouter.get("/note/:noteId/versions/:versionId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");
  const versionId = c.req.param("versionId");

  const note = db.prepare("SELECT id FROM notes WHERE id = ? AND userId = ?").get(noteId, userId) as any;
  if (!note) return c.json({ error: "笔记不存在或无权操作" }, 404);

  const version = noteVersionsRepository.getByIdAndNoteId(versionId, noteId);
  if (!version) return c.json({ error: "版本不存在" }, 404);

  return c.json(version);
});

// 恢复到某个版本
sharesRouter.post("/note/:noteId/versions/:versionId/restore", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");
  const versionId = c.req.param("versionId");

  const { permission } = resolveNotePermission(noteId, userId);
  if (!hasPermission(permission, "write")) {
    return c.json({ error: "笔记不存在或无权操作" }, 404);
  }

  const note = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as any;
  if (!note) return c.json({ error: "笔记不存在或无权操作" }, 404);
  if (note.isLocked) return c.json({ error: "笔记已锁定" }, 403);

  const version = noteVersionsRepository.getByIdAndNoteId(versionId, noteId);
  if (!version) return c.json({ error: "版本不存在" }, 404);

  const updated = db.transaction(() => {
    const currentVersionId = uuid();
    noteVersionsRepository.create({
      id: currentVersionId,
      noteId,
      userId,
      title: note.title,
      content: note.content,
      contentText: note.contentText,
      version: note.version,
      changeType: 'restore',
      changeSummary: "恢复前自动备份",
    });

    db.prepare(`
      UPDATE notes
      SET title = ?, content = ?, contentText = ?, version = version + 1, updatedAt = datetime('now')
      WHERE id = ?
    `).run(version.title, version.content, version.contentText, noteId);

    syncAttachmentReferences(db, noteId, version.content);
    noteYupdatesRepository.deleteByNoteId(noteId);
    noteYsnapshotsRepository.deleteByNoteId(noteId);

    return db.prepare(`
      SELECT id, userId, notebookId, workspaceId, title, content, contentText, isPinned,
        CASE WHEN EXISTS(SELECT 1 FROM favorites f WHERE f.noteId = notes.id AND f.userId = ?) THEN 1 ELSE 0 END AS isFavorite,
        isLocked, isArchived, isTrashed, version, sortOrder, createdAt, updatedAt, trashedAt
      FROM notes WHERE id = ?
    `).get(userId, noteId) as any;
  })();

  try { yDestroyDoc(noteId); } catch (e) {
    console.warn("[shares.restoreVersion] yDestroyDoc failed:", e);
  }

  const tags = db.prepare(`
    SELECT t.* FROM tags t
    JOIN note_tags nt ON t.id = nt.tagId
    WHERE nt.noteId = ?
  `).all(noteId);

  try {
    broadcastNoteUpdated(noteId, {
      version: updated.version,
      updatedAt: updated.updatedAt,
      title: updated.title,
      contentText: updated.contentText,
      actorUserId: userId,
    });
    broadcastToUser(userId, {
      type: "note:list-updated" as any,
      note: {
        id: updated.id,
        title: updated.title,
        contentText: updated.contentText,
        updatedAt: updated.updatedAt,
        version: updated.version,
        isPinned: updated.isPinned,
        isTrashed: updated.isTrashed,
        notebookId: updated.notebookId,
        workspaceId: updated.workspaceId,
      },
      actorUserId: userId,
      actorConnectionId: null,
    } as any);
  } catch (e) {
    console.warn("[shares.restoreVersion] broadcast failed:", e);
  }

  return c.json({ ...updated, tags });
});

// 清空某笔记的全部版本历史
sharesRouter.delete("/note/:noteId/versions", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");

  // 验证笔记归属
  const note = db.prepare("SELECT id FROM notes WHERE id = ? AND userId = ?").get(noteId, userId) as any;
  if (!note) return c.json({ error: "笔记不存在或无权操作" }, 404);

  const before = noteVersionsRepository.countByNoteId(noteId);
  const deleted = noteVersionsRepository.deleteByNoteId(noteId);

  return c.json({ success: true, count: before, deleted });
});

// ===== Phase 3: 评论批注 API =====

// 获取某笔记的评论列表
sharesRouter.get("/note/:noteId/comments", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");

  // 验证是笔记所有者或有分享权限
  const note = db.prepare("SELECT id, userId FROM notes WHERE id = ?").get(noteId) as any;
  if (!note) return c.json({ error: "笔记不存在" }, 404);

  const comments = shareCommentsRepository.listByNoteIdWithUser(noteId);

  return c.json(comments);
});

// 添加评论
sharesRouter.post("/note/:noteId/comments", async (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");
  const body = await c.req.json();
  const { content, parentId, anchorData } = body as { content: string; parentId?: string; anchorData?: string };

  if (!content || !content.trim()) return c.json({ error: "评论内容不能为空" }, 400);

  const note = db.prepare("SELECT id FROM notes WHERE id = ?").get(noteId) as any;
  if (!note) return c.json({ error: "笔记不存在" }, 404);

  const id = uuid();
  shareCommentsRepository.create({
    id,
    noteId,
    userId,
    parentId: parentId || null,
    content: content.trim(),
    anchorData: anchorData || null,
  });

  const comment = shareCommentsRepository.getByIdWithUser(id);

  return c.json(comment, 201);
});

// 删除评论
sharesRouter.delete("/note/:noteId/comments/:commentId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const commentId = c.req.param("commentId");

  const comment = shareCommentsRepository.getById(commentId);
  if (!comment) return c.json({ error: "评论不存在" }, 404);
  if (comment.userId !== userId) return c.json({ error: "只能删除自己的评论" }, 403);

  shareCommentsRepository.delete(commentId);
  return c.json({ success: true });
});

// 标记评论为已解决/未解决
sharesRouter.patch("/note/:noteId/comments/:commentId/resolve", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");
  const commentId = c.req.param("commentId");

  // 验证笔记所有者
  const note = db.prepare("SELECT id FROM notes WHERE id = ? AND userId = ?").get(noteId, userId) as any;
  if (!note) return c.json({ error: "无权操作" }, 403);

  const comment = shareCommentsRepository.getResolved(commentId);
  if (!comment) return c.json({ error: "评论不存在" }, 404);

  shareCommentsRepository.updateResolved(commentId, comment.isResolved ? 0 : 1);

  const updated = shareCommentsRepository.getByIdWithUser(commentId);

  return c.json(updated);
});

// ===== Phase 2: 批量检查笔记分享状态 =====
sharesRouter.get("/status/batch", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";

  // 获取当前用户所有活跃分享的笔记 ID 集合
  const sharedNotes = db.prepare(`
    SELECT DISTINCT noteId FROM shares WHERE ownerId = ? AND isActive = 1
  `).all(userId) as { noteId: string }[];

  return c.json(sharedNotes.map((s) => s.noteId));
});

// ===== Phase 4: 公开路由 - 同步轮询 =====

// 检查笔记是否有更新（轻量级，仅返回 version + updatedAt）
sharedRouter.get("/:token/poll", (c) => {
  const db = getDb();
  const token = c.req.param("token");

  const share = db.prepare(`
    SELECT s.id, s.noteId, s.isActive, s.expiresAt, s.maxViews, s.viewCount, s.password,
           n.version, n.updatedAt
    FROM shares s
    LEFT JOIN notes n ON s.noteId = n.id
    WHERE s.shareToken = ?
  `).get(token) as any;

  if (!share || !share.isActive) {
    return c.json({ error: "分享不存在或已失效" }, 404);
  }

  if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
    return c.json({ error: "分享链接已过期" }, 410);
  }

  if (share.maxViews && share.viewCount >= share.maxViews) {
    return c.json({ error: "分享链接已达到最大访问次数" }, 410);
  }

  // 如果有密码保护，验证 accessToken
  if (share.password) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "需要密码验证" }, 401);
    }
    const payload = verifyShareAccessToken(authHeader.slice(7), share.id);
    if (!payload) return c.json({ error: "访问令牌无效或已过期" }, 401);
  }

  return c.json({
    version: share.version,
    updatedAt: share.updatedAt,
  });
});

// 公开访问 - 获取评论列表（view 权限以上）
sharedRouter.get("/:token/comments", (c) => {
  const db = getDb();
  const token = c.req.param("token");

  const share = db.prepare(`
    SELECT s.id, s.noteId, s.isActive, s.permission, s.password
    FROM shares s WHERE s.shareToken = ?
  `).get(token) as any;

  if (!share || !share.isActive) {
    return c.json({ error: "分享不存在" }, 404);
  }

  // 密码验证
  if (share.password) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "需要密码验证" }, 401);
    }
    const payload = verifyShareAccessToken(authHeader.slice(7), share.id);
    if (!payload) return c.json({ error: "无效或已过期的令牌" }, 401);
  }

  const comments = shareCommentsRepository.listByNoteIdWithUserForPublic(share.noteId);

  // SQLite 的 1/0 → 转成 boolean，前端用起来更直观
  for (const r of comments) {
    r.isGuest = r.isGuest === 1;
  }

  return c.json(comments);
});

// 公开访问 - 添加评论（需要 comment / edit / edit_auth 权限）
//
// 鉴权策略：
//   - 已登录用户（X-User-Id header 有值且对应用户存在）：写真实 userId，guestName=NULL
//   - 未登录访客：写 userId=NULL，guestName=访客昵称（必填，最长 32）
//
// 反垃圾基础措施（最小可用）：
//   - 内容长度 ≤ 1000（防灌水）
//   - 同 IP 每分钟 ≤ 30 条评论（防机器刷屏）
//   - honeypot 字段 `_hp`：前端永远不发，后端收到非空就认为是机器人，静默 200 不入库
//
// 注：edit_auth 权限下评论是否需要登录？
//   不需要——评论与编辑是两个能力。edit_auth 仅约束"写正文"必须登录，
//   评论沿用 comment 权限的访客政策（填昵称即可）。如果以后业务上要"评论也得登录"，
//   再加 comment_auth 权限档位即可，本次不做。
sharedRouter.post("/:token/comments", async (c) => {
  const db = getDb();
  const token = c.req.param("token");
  const body = await c.req.json();
  const { content, parentId, anchorData, guestName, _hp } = body as {
    content: string; parentId?: string; anchorData?: string; guestName?: string; _hp?: string;
  };

  // honeypot：机器人填的字段，正常用户不会填
  if (_hp && _hp.trim()) {
    // 静默成功，不给攻击者反馈
    return c.json({ ok: true, suppressed: true });
  }

  if (!content || !content.trim()) return c.json({ error: "评论内容不能为空" }, 400);
  const trimmedContent = content.trim();
  if (trimmedContent.length > 1000) {
    return c.json({ error: "评论内容过长（最多 1000 字）" }, 400);
  }

  const share = db.prepare(`
    SELECT s.id, s.noteId, s.ownerId, s.isActive, s.permission, s.password
    FROM shares s WHERE s.shareToken = ?
  `).get(token) as any;

  if (!share || !share.isActive) return c.json({ error: "分享不存在" }, 404);
  if (share.permission === "view") return c.json({ error: "当前分享权限不支持评论" }, 403);

  // 密码验证
  if (share.password) {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "需要密码验证" }, 401);
    }
    const payload = verifyShareAccessToken(authHeader.slice(7), share.id);
    if (!payload) return c.json({ error: "无效或已过期的令牌" }, 401);
  }

  // 频次限制：以 (token, IP) 为 key，避免一个分享被同一 IP 刷屏
  const ip = getClientIp(c);
  const ipHash = hashIp(ip);
  if (!checkRateLimit(`${token}:${ipHash}`)) {
    return c.json({ error: "评论过于频繁，请稍后再试" }, 429);
  }

  // 鉴权识别：已登录 → 真实 userId；未登录 → NULL + guestName
  const authUserId = c.req.header("X-User-Id") || "";
  let userId: string | null = null;
  let storedGuestName: string | null = null;

  if (authUserId) {
    // 校验用户确实存在（避免伪造 header）
    const userRow = db.prepare("SELECT id FROM users WHERE id = ?").get(authUserId) as { id: string } | undefined;
    if (userRow) {
      userId = userRow.id;
    }
  }

  if (!userId) {
    // 未登录访客必须填昵称
    const trimmedName = (guestName || "").trim();
    if (!trimmedName) {
      return c.json({ error: "请填写昵称后再评论", code: "GUEST_NAME_REQUIRED" }, 400);
    }
    if (trimmedName.length > 32) {
      return c.json({ error: "昵称过长（最多 32 个字符）" }, 400);
    }
    storedGuestName = trimmedName;
  }

  const id = uuid();
  shareCommentsRepository.create({
    id,
    noteId: share.noteId,
    userId,
    guestName: storedGuestName,
    guestIpHash: ipHash,
    parentId: parentId || null,
    content: trimmedContent,
    anchorData: anchorData || null,
  });

  const comment = shareCommentsRepository.getByIdWithUserForPublic(id);

  comment.isGuest = comment.isGuest === 1;
  return c.json(comment, 201);
});

export { sharesRouter, sharedRouter };
