import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireWorkspaceFeature } from "../middleware/acl.js";
import { generateTaskPreview, previewInputSchema, TaskComposerError } from "../services/task-composer.js";

const router = new Hono();
router.post("/preview", bodyLimit({ maxSize: 64000, onError: c => c.json({ code: "REQUEST_TOO_LARGE", error: "Request too large" }, 413) }), requireWorkspaceFeature("tasks"), async c => {
  const userId = c.req.header("X-User-Id");
  if (!userId) return c.json({ code: "UNAUTHENTICATED", error: "Authentication required" }, 401);
  const parsed = previewInputSchema.safeParse(await c.req.json().catch(error => { if (error instanceof SyntaxError) return null; throw error; }));
  if (!parsed.success) return c.json({ code: "INVALID_TASK_INPUT", error: "Invalid task input" }, 400);
  const rawScope = c.req.query("workspaceId");
  const workspaceId = rawScope && rawScope !== "personal" ? rawScope : null;
  try { return c.json(await generateTaskPreview(userId, workspaceId, parsed.data, c.req.raw.signal)); }
  catch (error) {
    if (error instanceof TaskComposerError) return c.json({ code: error.code, error: error.message }, error.status);
    return c.json({ code: "AI_REQUEST_FAILED", error: "AI request failed" }, 502);
  }
});
export default router;
