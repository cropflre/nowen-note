import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import path from "path";
import notebooksRouter from "./routes/notebooks";
import notesRouter from "./routes/notes";
import tagsRouter from "./routes/tags";
import searchRouter from "./routes/search";
import { seedDatabase } from "./db/seed";
import { getDb } from "./db/schema";

const app = new Hono();

app.use("*", logger());
app.use("*", cors({
  origin: ["http://localhost:5173", "http://localhost:3000"],
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowHeaders: ["Content-Type", "X-User-Id"],
}));

// 初始化数据库
getDb();
seedDatabase();

// 中间件：自动注入用户 ID
app.use("/api/*", async (c, next) => {
  let userId = c.req.header("X-User-Id");
  if (!userId || userId === "demo") {
    const db = getDb();
    const user = db.prepare("SELECT id FROM users LIMIT 1").get() as { id: string } | undefined;
    if (user) {
      c.req.raw.headers.set("X-User-Id", user.id);
    }
  }
  await next();
});

// API 路由
app.route("/api/notebooks", notebooksRouter);
app.route("/api/notes", notesRouter);
app.route("/api/tags", tagsRouter);
app.route("/api/search", searchRouter);

// 健康检查
app.get("/api/health", (c) => c.json({ status: "ok", version: "1.0.0" }));

// 获取 demo 用户信息
app.get("/api/me", (c) => {
  const db = getDb();
  const user = db.prepare("SELECT id, username, email, avatarUrl, createdAt FROM users LIMIT 1").get();
  return c.json(user);
});

const port = Number(process.env.PORT) || 3001;

// 生产模式：服务前端静态文件
if (process.env.NODE_ENV === "production") {
  app.use("/*", serveStatic({ root: path.resolve(process.cwd(), "frontend/dist") }));
  app.get("*", (c) => {
    return c.html(require("fs").readFileSync(path.resolve(process.cwd(), "frontend/dist/index.html"), "utf-8"));
  });
}

console.log(`🚀 MyStation API running on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
