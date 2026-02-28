import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import path from "path";
import fs from "fs";
import jwt from "jsonwebtoken";
import notebooksRouter from "./routes/notebooks";
import notesRouter from "./routes/notes";
import tagsRouter from "./routes/tags";
import searchRouter from "./routes/search";
import tasksRouter from "./routes/tasks";
import exportRouter from "./routes/export";
import settingsRouter from "./routes/settings";
import fontsRouter from "./routes/fonts";
import micloudRouter from "./routes/micloud";
import oppoCloudRouter from "./routes/oppocloud";
import mindmapsRouter from "./routes/mindmaps";
import authRouter, { JWT_SECRET } from "./routes/auth";
import { seedDatabase } from "./db/seed";
import { getDb } from "./db/schema";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({
  origin: ["http://localhost:5173", "http://localhost:3000"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowHeaders: ["Content-Type", "X-User-Id", "Authorization"],
}));

// 初始化数据库
getDb();
seedDatabase();

// 认证路由（无需 JWT）
app.route("/api/auth", authRouter);

// 健康检查（无需 JWT）
app.get("/api/health", (c) => c.json({ status: "ok", version: "1.0.0" }));

// 站点设置（GET 无需 JWT，允许未登录时加载品牌信息）
app.get("/api/settings", (c) => {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM system_settings WHERE key LIKE 'site_%' OR key LIKE 'editor_%'").all() as { key: string; value: string }[];
  const result: Record<string, string> = { site_title: "nowen-note", site_favicon: "", editor_font_family: "" };
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

  const fontsDir = path.join(process.cwd(), "data/fonts");
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

// JWT 鉴权中间件：保护所有 /api/* 路由（auth 和 health 已在上方注册，不受影响）
app.use("/api/*", async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; username: string };
      c.req.raw.headers.set("X-User-Id", decoded.userId);
    } catch {
      return c.json({ error: "Token 无效或已过期" }, 401);
    }
  } else {
    return c.json({ error: "未授权，请先登录" }, 401);
  }

  await next();
});

// API 路由（受 JWT 保护）
app.route("/api/notebooks", notebooksRouter);
app.route("/api/notes", notesRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/search", searchRouter);
app.route("/api/tasks", tasksRouter);
app.route("/api/export", exportRouter);
app.route("/api/micloud", micloudRouter);
app.route("/api/oppocloud", oppoCloudRouter);
app.route("/api/mindmaps", mindmapsRouter);
app.route("/api/settings", settingsRouter);
app.route("/api/fonts", fontsRouter);

// 获取当前登录用户信息
app.get("/api/me", (c) => {
  const db = getDb();
  const userId = c.req.header("X-User-Id");
  const user = db.prepare("SELECT id, username, email, avatarUrl, createdAt FROM users WHERE id = ?").get(userId);
  return c.json(user);
});

const port = Number(process.env.PORT) || 3001;

// 生产模式：服务前端静态文件
if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: path.resolve(process.cwd(), "frontend/dist") }));
  app.get("*", (c) => {
    return c.html(fs.readFileSync(path.resolve(process.cwd(), "frontend/dist/index.html"), "utf-8"));
  });
}

console.log(`🚀 nowen-note API running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
