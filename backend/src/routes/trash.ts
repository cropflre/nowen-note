import { Hono } from "hono";
import { KnowledgeTreeError } from "../services/knowledgeTree.js";
import { listTrash, mutateTrash, emptyTrash } from "../services/trash/trashService.js";

const app = new Hono();
app.use("*", async (c, next) => {
  if (!c.req.header("X-User-Id")) return c.json({ error: "请先登录" }, 401);
  // Mixed-resource lifecycle scopes have not been exposed to API tokens yet.
  // Do not let the generic unsupported-endpoint fallback widen token authority.
  if (c.req.header("X-Auth-Mode") === "api-token") return c.json({ error: "回收站管理需要登录会话", code: "TRASH_LOGIN_REQUIRED" }, 403);
  await next();
});
const scopeOf = (c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } }) => ({
  userId: c.req.header("X-User-Id")!,
  workspaceId: c.req.query("workspaceId") && c.req.query("workspaceId") !== "personal" ? c.req.query("workspaceId")! : null,
});
app.onError((error, c) => {
  if (error instanceof KnowledgeTreeError) return c.json({ error: error.message, code: error.code }, error.status);
  console.error("[trash] request failed", error);
  return c.json({ error: "回收站操作失败" }, 500);
});
app.get("/", (c) => c.json({ items: listTrash(scopeOf(c)) }));
app.post("/batch", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !["restore", "permanent"].includes(body.action) || !Array.isArray(body.ids)
    || body.ids.length === 0 || body.ids.length > 500 || body.ids.some((id: unknown) => typeof id !== "string" || !id || id.length > 256)) {
    return c.json({ error: "无效的回收站操作", code: "INVALID_TRASH_OPERATION" }, 400);
  }
  return c.json(mutateTrash(scopeOf(c), body.action, [...new Set(body.ids)] as string[]));
});
app.delete("/", (c) => c.json(emptyTrash(scopeOf(c))));
export default app;
