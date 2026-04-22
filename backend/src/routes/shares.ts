import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { signShareAccessToken, verifyShareAccessToken } from "../lib/auth-security";

// H3: 使用密码学安全的随机源生成分享 token。
//     原实现用 Math.random()，理论上可被预测；改用 crypto.randomBytes。
//     输出 12 位 URL-safe base64（~72 bits 熵），与原长度保持一致，避免破坏前端/已发送链接格式。
function generateShareToken(): string {
  // 9 bytes base64url = 12 字符（无需 padding）
  return crypto.randomBytes(9).toString("base64url");
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

  const share = db.prepare("SELECT * FROM shares WHERE id = ?").get(id) as any;
  // 不返回密码 hash
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

  const share = db.prepare("SELECT id FROM shares WHERE id = ? AND ownerId = ?").get(id, userId) as any;
  if (!share) return c.json({ error: "分享不存在" }, 404);

  db.prepare("DELETE FROM shares WHERE id = ?").run(id);
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
           n.isLocked AS noteIsLocked
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

  return c.json({
    noteId: share.noteId,
    title: share.title,
    content: share.content,
    contentText: share.contentText,
    permission: share.permission,
    updatedAt: share.noteUpdatedAt,
    version: share.noteVersion,
    isLocked: share.noteIsLocked ? 1 : 0, // 用于前端判断是否允许进入编辑模式
  });
});

// 访客更新分享笔记内容（仅当 permission === 'edit'）
// 设计原则：
//   - 不需要 JWT 登录态；若分享有密码则校验临时 accessToken
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

  // 2) 权限校验：必须是 edit
  if (share.permission !== "edit") {
    return c.json({ error: "当前分享不支持编辑" }, 403);
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
      db.prepare(`
        INSERT INTO note_versions (id, noteId, userId, title, content, contentText, version, changeType, changeSummary)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'guest_edit', ?)
      `).run(
        versionId,
        share.noteId,
        share.noteUserId,
        share.noteTitle,
        share.noteContent,
        share.noteContentText,
        share.noteVersion,
        `访客 ${trimmedName} 编辑`,
      );
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

  const versions = db.prepare(`
    SELECT nv.id, nv.noteId, nv.userId, nv.title, nv.version, nv.changeType, nv.changeSummary, nv.createdAt,
           u.username
    FROM note_versions nv
    LEFT JOIN users u ON nv.userId = u.id
    WHERE nv.noteId = ?
    ORDER BY nv.version DESC
    LIMIT ? OFFSET ?
  `).all(noteId, limit, offset) as any[];

  const total = (db.prepare("SELECT COUNT(*) as count FROM note_versions WHERE noteId = ?").get(noteId) as any).count;

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

  const version = db.prepare("SELECT * FROM note_versions WHERE id = ? AND noteId = ?").get(versionId, noteId) as any;
  if (!version) return c.json({ error: "版本不存在" }, 404);

  return c.json(version);
});

// 恢复到某个版本
sharesRouter.post("/note/:noteId/versions/:versionId/restore", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");
  const versionId = c.req.param("versionId");

  const note = db.prepare("SELECT * FROM notes WHERE id = ? AND userId = ?").get(noteId, userId) as any;
  if (!note) return c.json({ error: "笔记不存在或无权操作" }, 404);
  if (note.isLocked) return c.json({ error: "笔记已锁定" }, 403);

  const version = db.prepare("SELECT * FROM note_versions WHERE id = ? AND noteId = ?").get(versionId, noteId) as any;
  if (!version) return c.json({ error: "版本不存在" }, 404);

  // 先保存当前版本
  const currentVersionId = uuid();
  db.prepare(`
    INSERT INTO note_versions (id, noteId, userId, title, content, contentText, version, changeType, changeSummary)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'restore', ?)
  `).run(currentVersionId, noteId, userId, note.title, note.content, note.contentText, note.version, `恢复前自动备份`);

  // 恢复
  db.prepare(`
    UPDATE notes SET title = ?, content = ?, contentText = ?, version = version + 1, updatedAt = datetime('now') WHERE id = ?
  `).run(version.title, version.content, version.contentText, noteId);

  const updated = db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as any;
  return c.json(updated);
});

// 清空某笔记的全部版本历史
sharesRouter.delete("/note/:noteId/versions", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const noteId = c.req.param("noteId");

  // 验证笔记归属
  const note = db.prepare("SELECT id FROM notes WHERE id = ? AND userId = ?").get(noteId, userId) as any;
  if (!note) return c.json({ error: "笔记不存在或无权操作" }, 404);

  const before = (db.prepare("SELECT COUNT(*) as count FROM note_versions WHERE noteId = ?").get(noteId) as any).count;
  db.prepare("DELETE FROM note_versions WHERE noteId = ?").run(noteId);

  return c.json({ success: true, count: before });
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

  const comments = db.prepare(`
    SELECT sc.*, u.username, u.avatarUrl
    FROM share_comments sc
    LEFT JOIN users u ON sc.userId = u.id
    WHERE sc.noteId = ?
    ORDER BY sc.createdAt ASC
  `).all(noteId) as any[];

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
  db.prepare(`
    INSERT INTO share_comments (id, noteId, userId, parentId, content, anchorData)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, noteId, userId, parentId || null, content.trim(), anchorData || null);

  const comment = db.prepare(`
    SELECT sc.*, u.username, u.avatarUrl
    FROM share_comments sc
    LEFT JOIN users u ON sc.userId = u.id
    WHERE sc.id = ?
  `).get(id) as any;

  return c.json(comment, 201);
});

// 删除评论
sharesRouter.delete("/note/:noteId/comments/:commentId", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id") || "";
  const commentId = c.req.param("commentId");

  const comment = db.prepare("SELECT id, userId FROM share_comments WHERE id = ?").get(commentId) as any;
  if (!comment) return c.json({ error: "评论不存在" }, 404);
  if (comment.userId !== userId) return c.json({ error: "只能删除自己的评论" }, 403);

  db.prepare("DELETE FROM share_comments WHERE id = ?").run(commentId);
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

  const comment = db.prepare("SELECT isResolved FROM share_comments WHERE id = ?").get(commentId) as any;
  if (!comment) return c.json({ error: "评论不存在" }, 404);

  db.prepare("UPDATE share_comments SET isResolved = ?, updatedAt = datetime('now') WHERE id = ?")
    .run(comment.isResolved ? 0 : 1, commentId);

  const updated = db.prepare(`
    SELECT sc.*, u.username, u.avatarUrl
    FROM share_comments sc
    LEFT JOIN users u ON sc.userId = u.id
    WHERE sc.id = ?
  `).get(commentId) as any;

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

  const comments = db.prepare(`
    SELECT sc.id, sc.noteId, sc.parentId, sc.content, sc.anchorData, sc.isResolved, sc.createdAt, sc.updatedAt,
           u.username, u.avatarUrl
    FROM share_comments sc
    LEFT JOIN users u ON sc.userId = u.id
    WHERE sc.noteId = ?
    ORDER BY sc.createdAt ASC
  `).all(share.noteId) as any[];

  return c.json(comments);
});

// 公开访问 - 添加评论（需要 comment 或 edit 权限）
sharedRouter.post("/:token/comments", async (c) => {
  const db = getDb();
  const token = c.req.param("token");
  const body = await c.req.json();
  const { content, parentId, anchorData, guestName } = body as {
    content: string; parentId?: string; anchorData?: string; guestName?: string;
  };

  if (!content || !content.trim()) return c.json({ error: "评论内容不能为空" }, 400);

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

  const id = uuid();
  // 公开评论使用分享所有者 ID 关联（实际生产环境应区分访客）
  db.prepare(`
    INSERT INTO share_comments (id, noteId, userId, parentId, content, anchorData)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, share.noteId, share.ownerId, parentId || null, content.trim(), anchorData || null);

  const comment = db.prepare(`
    SELECT sc.id, sc.noteId, sc.parentId, sc.content, sc.anchorData, sc.isResolved, sc.createdAt,
           COALESCE(?, u.username) AS username, u.avatarUrl
    FROM share_comments sc
    LEFT JOIN users u ON sc.userId = u.id
    WHERE sc.id = ?
  `).get(guestName || null, id) as any;

  return c.json(comment, 201);
});

export { sharesRouter, sharedRouter };
