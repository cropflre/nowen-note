import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { compress } from "hono/compress";
import path from "path";
import fs from "fs";
import { verifyLoginToken, getCachedAuthUser, setCachedAuthUser } from "./lib/auth-security";
import notebooksRouter from "./routes/notebooks";
import notesRouter from "./routes/notes";
import tagsRouter from "./routes/tags";
import searchRouter from "./routes/search";
import tasksRouter from "./routes/tasks";
import exportRouter from "./routes/export";
import dataFileRouter from "./routes/data-file";
import settingsRouter from "./routes/settings";
import fontsRouter from "./routes/fonts";
import attachmentsRouter, { handleDownloadAttachment } from "./routes/attachments";
import taskAttachmentsRouter, { handleDownloadTaskAttachment } from "./routes/task-attachments";
import taskRemindersRouter from "./routes/task-reminders";
import taskProjectsRouter from "./routes/task-projects";
import taskTemplatesRouter from "./routes/task-templates";
import taskDependenciesRouter from "./routes/task-dependencies";
import taskCalendarRouter from "./routes/task-calendar";
import folderSyncRouter from "./routes/folder-sync";
import attachmentFoldersRouter from "./routes/attachment-folders";
import imageHostingRouter from "./routes/image-hosting";
import filesRouter from "./routes/files";
import micloudRouter from "./routes/micloud";
import oppoCloudRouter from "./routes/oppocloud";
import icloudRouter from "./routes/icloud";
import mindmapsRouter from "./routes/mindmaps";
import mindmapFoldersRouter from "./routes/mindmap-folders";
import diaryRouter, { handleDownloadDiaryImage } from "./routes/diary";
import journalsRouter from "./routes/journals";
import urlImportRouter from "./routes/url-import";

import aiRouter from "./routes/ai";
import pluginsRouter from "./routes/plugins";
import webhooksRouter from "./routes/webhooks";
import auditRouter from "./routes/audit";
import backupsRouter from "./routes/backups";
import emailRouter from "./routes/email";
import { sharesRouter, sharedRouter } from "./routes/shares";
import workspacesRouter from "./routes/workspaces";
import authRouter from "./routes/auth";
import usersRouter from "./routes/users";
import tokensRouter from "./routes/tokens";
import userMigrationRouter from "./routes/user-migration";
import versionRouter, { resolveAppVersion } from "./routes/version";
import releasesRouter from "./routes/releases";
import { seedDatabase } from "./db/seed";
import { initApiTokensTable, looksLikeApiToken, resolveApiToken } from "./lib/api-tokens";
import { getDb, closeDb } from "./db/schema";
import { generateOpenAPISpec } from "./services/openapi";
import { getBackupManager } from "./services/backup";
import { attachRealtimeServer, getRealtimeStats, shutdownRealtime } from "./services/realtime";
import { getYjsStats } from "./services/yjs";
import { initWebhookTables } from "./services/webhook";
import { initAuditTables } from "./services/audit";
import { publishMdns, stopMdns } from "./services/discovery";
import { startEmbeddingWorker, stopEmbeddingWorker } from "./services/embedding-worker";
import { initVecStore, reindexAllVectors, isVecAvailable } from "./services/vec-store";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({
  origin: (origin) => origin || "*",
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  // 注意：自定义 header 必须在这里逐一列出，浏览器/WebView 跨域时才会让 OPTIONS 预检放行。
  //   - X-Sudo-Token：管理员高危操作（备份配置、删除、恢复、邮件发送等）必带；
  //     之前漏掉会让手机 App / Capacitor webview 跨域调用时直接 "TypeError: Failed to fetch"
  //     —— 因为预检失败连后端都到不了。
  //   - X-Connection-Id：P0-3 自回声排除（前端把当前 WebSocket connectionId 透传给 PUT
  //     /notes/:id，后端据此从广播中跳过发起者连接）。这是个**自定义 header**，会触发
  //     CORS 预检；如果没列入白名单，OPTIONS 直接 403/被浏览器拦下，所有"WS 连上之后"
  //     的 fetch 都会报 TypeError: Failed to fetch（典型现象：APK 列表能加载但点笔记
  //     立刻 Failed to fetch、点同一个笔记没反应）。
  allowHeaders: ["Content-Type", "X-User-Id", "Authorization", "X-Sudo-Token", "X-Connection-Id", "X-Requested-With", "X-Request-Id"],
  credentials: true,
}));

// HTTP 响应压缩（gzip/deflate）。
//   - 针对 /api/* 的 JSON 响应启用；大多数"图片以 base64 内联在 notes.content"的
//     笔记返回体能压到原大小的 20~30%，显著降低 GET /api/notes/:id 的网络耗时。
//   - threshold 默认 1KB，小响应不压缩（避免无谓 CPU）。
//   - 静态资源（字体、前端 dist）已有自己的 Cache-Control，这里不覆盖它们；
//     仅包裹 /api/* 足够。
app.use("/api/*", compress());

// 初始化数据库
getDb();
seedDatabase();

// 提前创建 webhooks / audit_logs 表。
// 这两张表原本是"路由被访问时懒初始化"，但 notes/notebooks/tasks 等路由会在写操作中
// 同步调用 emitWebhook() / logAudit()，如果用户从未访问过 /api/webhooks 或 /api/audit，
// 表就不存在，会在每次写操作时打印：
//   [Webhook] 事件分发错误: no such table: webhooks
//   [Audit] 日志记录失败: no such table: audit_logs
// 在启动时强制建表即可消除这些噪音日志。CREATE TABLE IF NOT EXISTS 幂等，重复调用无害。
try { initWebhookTables(); } catch (e) { console.warn("[init] initWebhookTables failed:", e); }
try { initAuditTables(); } catch (e) { console.warn("[init] initAuditTables failed:", e); }
try { initApiTokensTable(getDb()); } catch (e) { console.warn("[init] initApiTokensTable failed:", e); }

// 认证路由（无需 JWT）
app.route("/api/auth", authRouter);

// TASK-CALENDAR-SUBSCRIBE-01-RV1: 公开 ICS 订阅端点（无需 JWT）
// 注册在 auth middleware 之前，让手机系统日历可以直接订阅。
import { buildIcsForToken } from "./routes/task-calendar";

const icsRateLimitMap = new Map<string, { count: number; resetAt: number }>();
app.get("/api/calendar/ics/:token", (c) => {
  // 基础限流：每 IP 每分钟 30 次
  const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const entry = icsRateLimitMap.get(ip);
  if (entry && entry.resetAt > now) {
    if (entry.count >= 30) return c.text("Rate limited", 429);
    entry.count++;
  } else {
    icsRateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 });
  }
  // 清理过期条目
  if (icsRateLimitMap.size > 5000) {
    for (const [k, v] of icsRateLimitMap.entries()) {
      if (v.resetAt < now) icsRateLimitMap.delete(k);
    }
  }

  const rawToken = c.req.param("token");
  // 支持 /api/calendar/ics/:token 和 /api/calendar/ics/:token.ics
  const token = rawToken.replace(/\.ics$/, "");
  if (!token || token.length < 16) return c.text("Not found", 404);

  const result = buildIcsForToken(token);
  if (!result) return c.text("Not found", 404);

  return new Response(result.body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="nowen-tasks.ics"',
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// 分享公开访问路由（无需 JWT）
// Phase 5: 速率限制 — 防止暴力破解密码和恶意轮询
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

app.use("/api/shared/*", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
  const now = Date.now();
  const windowMs = 60000; // 1分钟窗口
  const maxRequests = 60;  // 每分钟最多60次

  const entry = rateLimitMap.get(ip);
  if (entry && entry.resetAt > now) {
    if (entry.count >= maxRequests) {
      return c.json({ error: "请求过于频繁，请稍后重试" }, 429);
    }
    entry.count++;
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
  }

  // 定期清理过期条目（每1000次请求清理一次）
  if (rateLimitMap.size > 1000) {
    for (const [key, val] of rateLimitMap.entries()) {
      if (val.resetAt <= now) rateLimitMap.delete(key);
    }
  }

  // Phase 5: 安全响应头
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-XSS-Protection", "1; mode=block");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");

  await next();
});

// 密码验证接口加强速率限制（每分钟最多10次）
const passwordRateLimitMap = new Map<string, { count: number; resetAt: number }>();

app.use("/api/shared/*/verify", async (c, next) => {
  const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
  const now = Date.now();
  const windowMs = 60000;
  const maxAttempts = 10;

  const entry = passwordRateLimitMap.get(ip);
  if (entry && entry.resetAt > now) {
    if (entry.count >= maxAttempts) {
      return c.json({ error: "密码验证过于频繁，请1分钟后重试" }, 429);
    }
    entry.count++;
  } else {
    passwordRateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
  }

  await next();
});

app.route("/api/shared", sharedRouter);

// 健康检查（无需 JWT）
// version 字段动态读取根 package.json / ENV，避免常年停在 1.0.0 误导运维。
app.get("/api/health", (c) => c.json({ status: "ok", version: resolveAppVersion() }));

// 版本信息 & GitHub 最新 release（无需 JWT）
//
// 这两个接口需要在 JWT 中间件**之前**挂：
//   - 前端 UpdateNotifier 在未登录状态也要能轮询版本；
//   - 关于页 / 登录页都可能展示最新发布信息。
// 故意放在 health 旁边；与 /api/auth 不同的是它们是完全公开的只读查询，
// 不涉及写操作、不记录审计日志。
app.route("/api/version", versionRouter);
app.route("/api/releases", releasesRouter);

// OpenAPI 规范（无需 JWT）
app.get("/api/openapi.json", (c) => c.json(generateOpenAPISpec()));

// 站点设置（GET 无需 JWT，允许未登录时加载品牌信息）
app.get("/api/settings", (c) => {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM system_settings WHERE key LIKE 'site_%' OR key LIKE 'editor_%' OR key LIKE 'debug_%' OR key = 'web_ui_enabled'").all() as { key: string; value: string }[];
  const result: Record<string, string> = { site_title: "nowen-note", site_favicon: "", editor_font_family: "", debug_files_query: "false", web_ui_enabled: "true" };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return c.json(result);
});

// 字体文件下载 & 字体列表（无需 JWT，@font-face 浏览器请求不带 Authorization）
app.get("/api/fonts", (c) => {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, name, fileName, format, createdAt FROM custom_fonts ORDER BY createdAt DESC"
  ).all();
  return c.json(rows);
});
app.get("/api/fonts/file/:id", (c) => {
  const id = c.req.param("id");
  const db = getDb();
  const row = db.prepare("SELECT id, fileName, format FROM custom_fonts WHERE id = ?").get(id) as any;
  if (!row) return c.json({ error: "字体不存在" }, 404);

  const fontsDir = path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "fonts");
  const filePath = path.join(fontsDir, `${row.id}.${row.format}`);
  if (!fs.existsSync(filePath)) return c.json({ error: "字体文件丢失" }, 404);

  const mimeMap: Record<string, string> = {
    otf: "font/otf", ttf: "font/ttf", otc: "font/collection",
    ttc: "font/collection", woff: "font/woff", woff2: "font/woff2",
  };
  const buffer = fs.readFileSync(filePath);
  return new Response(buffer, {
    headers: {
      "Content-Type": mimeMap[row.format] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

// 附件下载（无需 JWT）。
//   - <img src="/api/attachments/<id>"> 浏览器请求不会自动带 Authorization，
//     走 JWT 中间件必然 401。和字体一样把下载 handler 注册在 JWT 中间件之前。
//   - 授权靠附件 id 不可枚举（uuid）保护；详细权衡见 routes/attachments.ts 顶部注释。
app.get("/api/attachments/:id", handleDownloadAttachment);

// 任务附件下载（无需 JWT），与 attachments 同款"id 不可枚举"授权模型。
// 任务列表里的图片缩略图通过 <img src="/api/task-attachments/<id>"> 拉取。
app.get("/api/task-attachments/:id", handleDownloadTaskAttachment);

// 说说图片下载（同样不走 JWT，授权模型同上）。
//   注意路径具体：/api/diary/attachments/:id，必须比 diaryRouter（在 JWT 之后挂的
//   /api/diary/*）注册得**更早**，否则会被 JWT 中间件拦截。
app.get("/api/diary/attachments/:id", handleDownloadDiaryImage);

// JWT 鉴权中间件：保护所有 /api/* 路由（auth 和 health 已在上方注册，不受影响）
//
// 安全加固（C3）：
//   - 校验 JWT 签名后，还要查 DB 确认用户仍存在、未被禁用，并且 JWT 里的
//     tokenVersion（tver）与 DB 中的一致；禁用 / 改密 / factory-reset 会 bump
//     tokenVersion，从而让所有旧 token 立即失效。
//   - 为避免每个请求都撞 DB，做了一个 60s 的轻量缓存（在 lib/auth-security 中）。
//     用户状态变更（禁用、改密、删除、bumpTokenVersion）路径上会主动 invalidate，
//     确保敏感操作即时生效；其它场景最多 60s 自然过期。
function lookupUserForAuth(userId: string) {
  const cached = getCachedAuthUser(userId);
  if (cached) return cached;

  const db = getDb();
  const row = db
    .prepare("SELECT username, tokenVersion, isDisabled, role FROM users WHERE id = ?")
    .get(userId) as
    | { username: string; tokenVersion: number; isDisabled: number; role: string | null }
    | undefined;
  if (!row) return null;

  const entry = {
    username: row.username,
    tokenVersion: row.tokenVersion ?? 0,
    isDisabled: row.isDisabled ?? 0,
    role: row.role || "user",
  };
  setCachedAuthUser(userId, entry);
  return entry;
}

// Phase 6: lastSeenAt 更新节流（同一 session 60 秒内只写一次 DB）。
//
//   单机部署内存 Map 足够；多实例部署时每个实例最多写一次/分钟 × 实例数，依旧可接受。
const SESSION_TOUCH_INTERVAL_MS = 60_000;
const sessionLastTouched = new Map<string, number>();
function touchSessionLastSeen(sessionId: string) {
  const now = Date.now();
  const last = sessionLastTouched.get(sessionId) || 0;
  if (now - last < SESSION_TOUCH_INTERVAL_MS) return;
  sessionLastTouched.set(sessionId, now);
  try {
    getDb()
      .prepare("UPDATE user_sessions SET lastSeenAt = datetime('now') WHERE id = ?")
      .run(sessionId);
  } catch {
    /* 更新失败不阻塞请求 */
  }
  // 防止 Map 无限增长：超过 5000 条时清理过期条目
  if (sessionLastTouched.size > 5000) {
    const cutoff = now - SESSION_TOUCH_INTERVAL_MS * 10;
    for (const [k, v] of sessionLastTouched.entries()) {
      if (v < cutoff) sessionLastTouched.delete(k);
    }
  }
}

app.use("/api/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "未授权，请先登录", code: "UNAUTHENTICATED" }, 401);
  }

  const token = authHeader.slice(7);

  // ===== 分支 1：Personal API Token（长期凭证，浏览器剪藏 / CLI / 自动化脚本用） =====
  //
  //   - 以 "nkn_" 前缀区分，避免与 JWT 混淆
  //   - 走 DB 查询（hash 比对），命中即下发 X-User-Id
  //   - 不走 user_sessions / tokenVersion 体系（token 有独立的 revokedAt / expiresAt）
  //   - 仍然要校验用户未禁用、未删除
  if (looksLikeApiToken(token)) {
    const ipForAudit =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "";
    const resolved = resolveApiToken(getDb(), token, ipForAudit);
    if (!resolved) {
      return c.json({ error: "API Token 无效或已吊销", code: "API_TOKEN_INVALID" }, 401);
    }
    const user = lookupUserForAuth(resolved.userId);
    if (!user) {
      return c.json({ error: "账号不存在或已被删除", code: "USER_NOT_FOUND" }, 401);
    }
    if (user.isDisabled) {
      return c.json({ error: "该账号已被禁用，请联系管理员", code: "ACCOUNT_DISABLED" }, 403);
    }
    c.req.raw.headers.set("X-User-Id", resolved.userId);
    c.req.raw.headers.set("X-Auth-Mode", "api-token");
    if (resolved.scopes.length > 0) {
      c.req.raw.headers.set("X-Api-Scopes", resolved.scopes.join(","));
    }
    await next();
    return;
  }

  // ===== 分支 2：登录 JWT（原逻辑，不动） =====
  const payload = verifyLoginToken(token);
  if (!payload || !payload.userId) {
    return c.json({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }, 401);
  }

  // C3: DB 校验 —— 用户存在 + 未被禁用 + tokenVersion 一致
  const user = lookupUserForAuth(payload.userId);
  if (!user) {
    return c.json({ error: "账号不存在或已被删除", code: "USER_NOT_FOUND" }, 401);
  }
  if (user.isDisabled) {
    return c.json({ error: "该账号已被禁用，请联系管理员", code: "ACCOUNT_DISABLED" }, 403);
  }
  if ((payload.tver ?? 0) !== user.tokenVersion) {
    return c.json(
      { error: "会话已失效，请重新登录", code: "TOKEN_REVOKED" },
      401,
    );
  }

  // Phase 6: 会话级校验
  //
  //   - 登录成功时会生成一条 user_sessions 记录并把 id 放进 JWT 的 jti；
  //   - 被"单端下线"时把 revokedAt 置为非 NULL → 这里检测到就拒绝；
  //   - 旧 token 没有 jti（升级前签发的）→ 按兼容路径放行，但不更新 lastSeenAt；
  //   - lastSeenAt 每 60 秒内同用户同 session 只更新一次，避免高频写 DB。
  if (payload.jti) {
    const db = getDb();
    const sess = db
      .prepare("SELECT id, revokedAt FROM user_sessions WHERE id = ? AND userId = ?")
      .get(payload.jti, payload.userId) as { id: string; revokedAt: string | null } | undefined;
    if (!sess) {
      // 签发时有 jti，但 DB 里找不到对应 session（可能被 factory-reset 清库） → 视为吊销
      return c.json({ error: "会话已失效，请重新登录", code: "TOKEN_REVOKED" }, 401);
    }
    if (sess.revokedAt) {
      return c.json({ error: "该会话已被下线", code: "SESSION_REVOKED" }, 401);
    }
    touchSessionLastSeen(payload.jti);
  }

  c.req.raw.headers.set("X-User-Id", payload.userId);
  if (payload.jti) c.req.raw.headers.set("X-Session-Id", payload.jti);
  await next();
});

// API 路由（受 JWT 保护）
app.route("/api/notebooks", notebooksRouter);
app.route("/api/notes", notesRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/search", searchRouter);
app.route("/api/tasks", tasksRouter);
app.route("/api/export", exportRouter);
app.route("/api/data-file", dataFileRouter);
app.route("/api/micloud", micloudRouter);
app.route("/api/oppocloud", oppoCloudRouter);
app.route("/api/icloud", icloudRouter);
app.route("/api/mindmaps", mindmapsRouter);
app.route("/api/mindmap-folders", mindmapFoldersRouter);
app.route("/api/diary", diaryRouter);
app.route("/api/journals", journalsRouter);
app.route("/api/url-import", urlImportRouter);
app.route("/api/ai", aiRouter);
app.route("/api/plugins", pluginsRouter);
app.route("/api/webhooks", webhooksRouter);
app.route("/api/audit", auditRouter);
app.route("/api/backups", backupsRouter);
app.route("/api/email", emailRouter);
app.route("/api/shares", sharesRouter);
app.route("/api/workspaces", workspacesRouter);
app.route("/api/users", usersRouter);
app.route("/api/tokens", tokensRouter);
app.route("/api/user-migration", userMigrationRouter);

app.route("/api/settings", settingsRouter);
app.route("/api/fonts", fontsRouter);
app.route("/api/attachments", attachmentsRouter);
app.route("/api/task-attachments", taskAttachmentsRouter);
app.route("/api/task-reminders", taskRemindersRouter);
app.route("/api/task-projects", taskProjectsRouter);
app.route("/api/task-templates", taskTemplatesRouter);
app.route("/api/task-dependencies", taskDependenciesRouter);
app.route("/api/task-calendar", taskCalendarRouter);
app.route("/api/folder-sync", folderSyncRouter);
app.route("/api/attachment-folders", attachmentFoldersRouter);
app.route("/api/image-hosting", imageHostingRouter);
app.route("/api/files", filesRouter);


// Reminder scanner: check due reminders every 30s
import { scanDueReminders, markReminderNotified, type PendingReminder } from "./routes/task-reminders";
import { scanDependencyReadyNotifications, scanOverdueDailyNotifications, type SystemReminder } from "./routes/automation-scanner";

// In-memory ring buffer of recently triggered reminders (last 5 min)
type RecentItem = (PendingReminder | SystemReminder) & { _triggeredAt: number; type: string };
const recentReminders: RecentItem[] = [];
const RECENT_TTL = 5 * 60 * 1000;

let lastReminderScan = 0;
setInterval(() => {
  const now = Date.now();
  if (now - lastReminderScan < 30000) return;
  lastReminderScan = now;
  try {
    // Purge expired entries
    for (let i = recentReminders.length - 1; i >= 0; i--) {
      if (now - recentReminders[i]._triggeredAt > RECENT_TTL) recentReminders.splice(i, 1);
    }
    const pending = scanDueReminders();
    for (const r of pending) {
      console.log(`[reminder] Task "${r.taskTitle}" (${r.taskId}) reminder due for user ${r.userId}`);
      recentReminders.push({ ...r, _triggeredAt: now, type: "task_reminder" });
      markReminderNotified(r.reminderId);
    }

    // Phase 6.4: dependency-ready notifications
    const depReady = scanDependencyReadyNotifications();
    for (const d of depReady) {
      console.log(`[automation] Dependency ready: "${d.taskTitle}" (${d.taskId}) for user ${d.userId}`);
      recentReminders.push({ ...d, _triggeredAt: now, type: "dependency_ready" });
    }

    // Phase 6.4: overdue daily notifications
    const overdueDaily = scanOverdueDailyNotifications();
    for (const o of overdueDaily) {
      console.log(`[automation] Overdue daily: "${o.taskTitle}" (${o.taskId}) for user ${o.userId}`);
      recentReminders.push({ ...o, _triggeredAt: now, type: "overdue_daily" });
    }
  } catch (e) {
    console.error("[reminder] scan failed:", e);
  }
}, 30000);

// Endpoint for frontend polling of recently triggered reminders
app.get("/api/task-reminders/recent", (c) => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const since = c.req.query("since");
  const sinceMs = since ? Number(since) : 0;
  const mine = recentReminders
    .filter((r) => r.userId === userId && r._triggeredAt > sinceMs)
    .map((r) => ({ reminderId: r.reminderId, taskId: r.taskId, taskTitle: r.taskTitle, triggeredAt: r._triggeredAt, type: r.type || "task_reminder" }));
  return c.json({ reminders: mine });
});


// 获取当前登录用户信息
app.get("/api/me", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const user = db
    .prepare(
      `SELECT id, username, email, avatarUrl, displayName, role, isDemo,
              personalExportEnabled, personalImportEnabled,
              createdAt
       FROM users WHERE id = ?`,
    )
    .get(userId) as any;
  if (user) {
    if (!user.role) user.role = "user";
    user.isDemo = user.isDemo === 1;
    // v6：把 users.personalExport/ImportEnabled 以 boolean 形式下发，
    // 前端 Sidebar / DataManager 直接按布尔判定 UI 可见性。
    // 即使列缺失（例如旧库迁移失败），也兜底为 true，保持与 DEFAULT 1 一致。
    user.personalExportEnabled = user.personalExportEnabled === undefined
      ? true
      : user.personalExportEnabled !== 0;
    user.personalImportEnabled = user.personalImportEnabled === undefined
      ? true
      : user.personalImportEnabled !== 0;
  }
  return c.json(user);
});

// Phase 2: 实时协作调试端点（仅开发期使用，不暴露敏感信息）
app.get("/api/realtime/stats", (c) => {
  return c.json(getRealtimeStats());
});

// Phase 3: Y.js CRDT 调试端点
app.get("/api/yjs/stats", (c) => {
  return c.json(getYjsStats());
});

const port = Number(process.env.PORT) || 3001;

function isWebUiEnabled(): boolean {
  try {
    const row = getDb()
      .prepare("SELECT value FROM system_settings WHERE key = 'web_ui_enabled'")
      .get() as { value?: string } | undefined;
    const value = row?.value;
    return value === undefined || value === null || value === "" || value === "true" || value === "1";
  } catch {
    return true;
  }
}

function webUiDisabledResponse(): Response {
  return new Response(
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Web UI Disabled</title></head>" +
    "<body style=\"font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#334155\">" +
    "<main style=\"max-width:520px;padding:32px;text-align:center\"><h1 style=\"font-size:22px;color:#0f172a\">网页端已被管理员关闭</h1>" +
    "<p style=\"line-height:1.7\">当前服务器仅提供 API 服务。请使用 Nowen Note 桌面客户端连接该服务器。</p></main></body></html>",
    { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// 生产模式：服务前端静态文件
if (process.env.NODE_ENV === "production") {
  const frontendDist = process.env.FRONTEND_DIST || path.resolve(process.cwd(), "frontend/dist");
  console.log("[Static] Serving frontend from:", frontendDist);

  // MIME 类型映射
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".webp": "image/webp",
    ".map": "application/json",
  };

  const frontendRoot = path.resolve(frontendDist);
  const resolveFrontendFilePath = (reqPath: string): string | null => {
    const normalizedPath = reqPath === "/" ? "/index.html" : reqPath;
    const candidates = [normalizedPath];

    if (path.extname(normalizedPath) !== "") {
      const parts = normalizedPath.split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        candidates.push(`/${parts.slice(i).join("/")}`);
      }
    }

    for (const candidate of candidates) {
      const filePath = path.resolve(frontendRoot, `.${candidate}`);
      if (filePath !== frontendRoot && !filePath.startsWith(frontendRoot + path.sep)) {
        continue;
      }
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return filePath;
      }
    }

    return null;
  };

  // 静态资源 + SPA fallback（排除 /api 路径）
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api")) {
      return c.json({ error: "Not Found" }, 404);
    }
    if (!isWebUiEnabled()) {
      return webUiDisabledResponse();
    }
    // 尝试提供静态文件
    const filePath = resolveFrontendFilePath(c.req.path);
    // 安全检查：防止路径遍历
    if (filePath) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || "application/octet-stream";
      const content = fs.readFileSync(filePath);
      return c.body(content, 200, { "Content-Type": contentType });
    }
    if (path.extname(c.req.path) !== "") {
      return c.json({ error: "Not Found" }, 404);
    }
    // SPA fallback：返回 index.html
    const indexPath = path.join(frontendDist, "index.html");
    if (fs.existsSync(indexPath)) {
      return c.html(fs.readFileSync(indexPath, "utf-8"));
    }
    return c.json({ error: "Not Found" }, 404);
  });
}

// 启动自动备份：按 system_settings + ENV 决定是否启动及间隔
// （管理员可在备份页关闭/调整间隔，重启后仍生效；首次安装走 ENV 默认 24h）
try {
  const mgr = getBackupManager();
  const cfg = mgr.readEffectiveAutoConfig();
  if (cfg.enabled) {
    // 用对象签名传完整配置，让 mode/dailyAt/keepCount/邮件设置在重启后能恢复
    mgr.startAutoBackup(cfg, { persist: false });
  } else {
    console.log("[Backup] 自动备份已禁用（system_settings 或 ENV 配置）");
  }
} catch { /* 备份启动失败不阻塞服务 */ }

// 启动 RAG Phase 2：sqlite-vec 扩展加载 + worker
//   - initVecStore：把 sqlite-vec 加载进当前 db 连接；失败时自动 noop（worker
//     仍能正常算 embedding 写 note_embeddings.vectorJson，只是没有 KNN 加速）
//   - 加载成功后若 note_embeddings 已有数据但 vec 表是空（升级场景）→ 自动 reindex
//   - startEmbeddingWorker：完全异步、不阻塞主流程
//   - 进程退出时由 gracefulShutdown 调 stopEmbeddingWorker 清理 timer
try {
  const vecInit = initVecStore();
  if (vecInit.loaded && isVecAvailable()) {
    // 检查是否需要冷启动重建（vec 表为空但 note_embeddings 非空）
    try {
      const db = getDb();
      const vecCount = (db.prepare("SELECT COUNT(*) as c FROM vec_note_chunks").get() as { c: number }).c;
      const embCount = (db.prepare("SELECT COUNT(*) as c FROM note_embeddings").get() as { c: number }).c;
      if (vecCount === 0 && embCount > 0) {
        console.log(`[init] vec_note_chunks empty but ${embCount} embeddings present, reindexing...`);
        const r = reindexAllVectors();
        console.log(`[init] reindex done: ${r.written}/${r.total} rows, dim=${r.dim}`);
      }
    } catch (e) {
      console.warn("[init] vec cold-start reindex check failed:", e);
    }
  }
} catch (e) {
  console.warn("[init] initVecStore failed:", e);
}

try {
  startEmbeddingWorker();
} catch (e) {
  console.warn("[init] startEmbeddingWorker failed:", e);
}

console.log(`🚀 nowen-note API running on http://localhost:${port}`);
console.log(`📖 OpenAPI 文档: http://localhost:${port}/api/openapi.json`);

// @hono/node-server 的 serve 返回底层 http.Server；拿到后挂 WebSocket
const server = serve({ fetch: app.fetch, port });
// serve() 签名在不同版本返回不同对象；实际运行时是 http.Server
attachRealtimeServer(server as unknown as import("http").Server);
console.log(`🛰  WebSocket endpoint: ws://localhost:${port}/ws`);

// mDNS 广播：让同局域网内的桌面/移动客户端免输入发现本实例。
//   - 仅在"对外暴露的端口"上广播才有意义（127.0.0.1 绑定的 Electron 内嵌后端
//     也可以广播，但旁路设备根本连不上）。这里不做 bind 地址判断，保持无脑广播；
//     如果想限制，可加 DISABLE_MDNS=1 环境变量。
//   - 失败不影响主流程，函数内部已做 warn-only 降级。
if (process.env.DISABLE_MDNS !== "1") {
  try {
    publishMdns({
      port,
      version: resolveAppVersion(),
    });
  } catch (e) {
    console.warn("[discovery] publishMdns threw:", e);
  }
}

// Phase 3: 优雅关停 —— 把内存中的 Y.Doc 状态 flush 到磁盘
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] received ${signal}, flushing Y.js state...`);
  const timeoutId = setTimeout(() => {
    console.warn("[shutdown] flush timeout (3s), force exit");
    process.exit(1);
  }, 3000);
  try {
    await shutdownRealtime();
  } catch (e) {
    console.warn("[shutdown] failed:", e);
  } finally {
    // 停掉 embedding worker 的轮询定时器，避免 process.exit 之前还在发起 fetch
    try { stopEmbeddingWorker(); } catch { /* ignore */ }
    // mDNS 停播放在最后：即使 realtime shutdown 抛错，也要尽量通知网络"下线"
    try { stopMdns(); } catch { /* ignore */ }
    // 关停 DB 连接：内部会先 wal_checkpoint(TRUNCATE)，把 -wal 中的事务全部
    // 写回主 .db 文件。这样无论用户接下来是 cp 冷备、docker volume snapshot
    // 还是直接关机，拿到的 .db 都是完整的一致快照，不会丢最近事务。
    try { closeDb(); } catch (e) { console.warn("[shutdown] closeDb failed:", e); }
    clearTimeout(timeoutId);
    process.exit(0);
  }
}
process.once("SIGINT", () => { gracefulShutdown("SIGINT"); });
process.once("SIGTERM", () => { gracefulShutdown("SIGTERM"); });
