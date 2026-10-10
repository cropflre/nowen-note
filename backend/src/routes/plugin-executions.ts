import { Hono } from "hono";
import { isSystemAdmin } from "../middleware/acl.js";
import { getPluginService } from "../plugins/pluginService.js";

const router = new Hono();

router.get("/:executionId", (c) => {
  const row = getPluginService().executions.get(c.req.param("executionId")) as { userId?: string } | undefined;
  if (!row) return c.json({ error: "执行记录不存在", code: "NOT_FOUND" }, 404);
  const actor = c.req.header("X-User-Id") || "";
  if (row.userId !== actor && !isSystemAdmin(actor)) return c.json({ error: "无权查看该执行记录", code: "FORBIDDEN" }, 403);
  return c.json(row);
});

router.post("/:executionId/cancel", (c) => {
  const row = getPluginService().executions.get(c.req.param("executionId")) as { userId?: string } | undefined;
  if (!row) return c.json({ error: "执行记录不存在", code: "NOT_FOUND" }, 404);
  const actor = c.req.header("X-User-Id") || "";
  if (row.userId !== actor && !isSystemAdmin(actor)) return c.json({ error: "无权取消该执行", code: "FORBIDDEN" }, 403);
  return c.json({ success: getPluginService().executions.cancel(c.req.param("executionId")) });
});

export default router;
