import { Hono } from "hono";
import { getDb } from "../db/schema";
import { v4 as uuid } from "uuid";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "nowen-note-secret-key-change-in-production";
const JWT_EXPIRES_IN = "30d"; // 30天免登录

const auth = new Hono();

// 登录
auth.post("/login", async (c) => {
  const body = await c.req.json();
  const { username, password } = body as { username: string; password: string };

  if (!username || !password) {
    return c.json({ error: "用户名和密码不能为空" }, 400);
  }

  const db = getDb();
  const user = db.prepare(
    "SELECT id, username, email, avatarUrl, passwordHash, createdAt FROM users WHERE username = ?"
  ).get(username) as any;

  if (!user) {
    return c.json({ error: "用户名或密码错误" }, 401);
  }

  // 校验密码（兼容旧的 SHA256 和新的 bcrypt）
  let isValid = false;
  if (user.passwordHash.startsWith("$2")) {
    // bcrypt hash
    isValid = await bcrypt.compare(password, user.passwordHash);
  } else {
    // 旧的 SHA256 hash（兼容 seed 数据）
    const crypto = require("crypto");
    const sha256 = crypto.createHash("sha256").update(password).digest("hex");
    isValid = sha256 === user.passwordHash;

    // 如果 SHA256 匹配，自动升级为 bcrypt
    if (isValid) {
      const newHash = await bcrypt.hash(password, 10);
      db.prepare("UPDATE users SET passwordHash = ? WHERE id = ?").run(newHash, user.id);
    }
  }

  if (!isValid) {
    return c.json({ error: "用户名或密码错误" }, 401);
  }

  // 生成 JWT
  const token = jwt.sign(
    { userId: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  return c.json({
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      createdAt: user.createdAt,
    },
  });
});

// 修改账号安全信息（用户名 + 密码）
auth.post("/change-password", async (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "未授权" }, 401);

  const body = await c.req.json();
  const { currentPassword, newUsername, newPassword } = body as {
    currentPassword: string;
    newUsername?: string;
    newPassword?: string;
  };

  if (!currentPassword) {
    return c.json({ error: "必须提供当前密码" }, 400);
  }

  if (!newUsername && !newPassword) {
    return c.json({ error: "请填写要修改的用户名或新密码" }, 400);
  }

  if (newPassword && newPassword.length < 6) {
    return c.json({ error: "新密码长度至少为6位" }, 400);
  }

  const db = getDb();
  const user = db.prepare("SELECT id, username, passwordHash FROM users WHERE id = ?").get(userId) as any;
  if (!user) return c.json({ error: "用户不存在" }, 404);

  // 校验当前密码
  let isValid = false;
  if (user.passwordHash.startsWith("$2")) {
    isValid = await bcrypt.compare(currentPassword, user.passwordHash);
  } else {
    const crypto = require("crypto");
    const sha256 = crypto.createHash("sha256").update(currentPassword).digest("hex");
    isValid = sha256 === user.passwordHash;
  }

  if (!isValid) {
    return c.json({ error: "当前密码错误" }, 403);
  }

  // 检查新用户名是否冲突
  if (newUsername && newUsername !== user.username) {
    const existing = db.prepare("SELECT id FROM users WHERE username = ? AND id != ?").get(newUsername, userId) as any;
    if (existing) {
      return c.json({ error: "该用户名已被使用" }, 409);
    }
  }

  // 执行更新
  const updates: string[] = [];
  const params: any[] = [];

  if (newUsername && newUsername !== user.username) {
    updates.push("username = ?");
    params.push(newUsername);
  }

  if (newPassword) {
    const newHash = await bcrypt.hash(newPassword, 10);
    updates.push("passwordHash = ?");
    params.push(newHash);
  }

  updates.push("updatedAt = datetime('now')");
  params.push(userId);

  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  return c.json({ success: true, message: "账户信息更新成功" });
});

// 恢复出厂设置
auth.post("/factory-reset", async (c) => {
  // auth 路由不经过 JWT 中间件，需要自行解析 token 获取 userId
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "未授权" }, 401);
  }

  let userId: string;
  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; username: string };
    userId = decoded.userId;
  } catch {
    return c.json({ error: "Token 无效或已过期" }, 401);
  }

  const body = await c.req.json();
  const { confirmText } = body as { confirmText: string };

  if (confirmText !== "RESET") {
    return c.json({ error: "校验码不正确" }, 400);
  }

  const db = getDb();

  // 在事务中执行所有清理操作
  const resetTransaction = db.transaction(() => {
    // 1. 重建 FTS 索引（FTS5 虚拟表不支持普通 DELETE，用 rebuild 清空）
    db.prepare("INSERT INTO notes_fts(notes_fts) VALUES('rebuild')").run();
    // 2. 清空关联表
    db.prepare("DELETE FROM note_tags").run();
    db.prepare("DELETE FROM attachments").run();
    // 3. 清空任务
    db.prepare("DELETE FROM tasks").run();
    // 4. 清空笔记
    db.prepare("DELETE FROM notes").run();
    // 5. 清空标签
    db.prepare("DELETE FROM tags").run();
    // 6. 清空笔记本
    db.prepare("DELETE FROM notebooks").run();
    // 7. 重置管理员密码为默认值 admin123 (SHA256)
    const crypto = require("crypto");
    const defaultHash = crypto.createHash("sha256").update("admin123").digest("hex");
    db.prepare("UPDATE users SET username = 'admin', passwordHash = ?, updatedAt = datetime('now') WHERE id = ?").run(defaultHash, userId);
  });

  try {
    resetTransaction();
    console.log("💥 系统已恢复出厂设置：数据已清空，密码已重置为 admin123");
    return c.json({ success: true, message: "系统已恢复出厂设置" });
  } catch (error) {
    console.error("恢复出厂设置失败:", error);
    return c.json({ error: "恢复出厂设置失败" }, 500);
  }
});

// 验证 token（前端刷新时调用）
auth.get("/verify", (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "未授权" }, 401);
  }

  try {
    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; username: string };

    const db = getDb();
    const user = db.prepare(
      "SELECT id, username, email, avatarUrl, createdAt FROM users WHERE id = ?"
    ).get(decoded.userId) as any;

    if (!user) return c.json({ error: "用户不存在" }, 401);

    return c.json({ user });
  } catch {
    return c.json({ error: "Token 无效或已过期" }, 401);
  }
});

export { JWT_SECRET };
export default auth;
