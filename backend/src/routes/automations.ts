import { Hono } from "hono";
import { isSystemAdmin } from "../middleware/acl.js";
import { automationRuntime } from "../automation/runtime.js";
import { getWorkflowService } from "../automation/workflowService.js";

const router = new Hono();
const userId = (c: any) => c.req.header("X-User-Id") || "";
function errorResponse(c: any, error: unknown) {
  const coded = error as Error & { code?: string };
  const status = coded.code === "RESOURCE_FORBIDDEN" ? 403 : coded.code?.includes("NOT_FOUND") ? 404 : 400;
  return c.json({ error: coded.message || String(error), code: coded.code || "AUTOMATION_ERROR" }, status as any);
}

router.get("/", (c) => c.json(getWorkflowService().list(userId(c))));
router.post("/", async (c) => {
  try { return c.json(getWorkflowService().create(userId(c), await c.req.json()), 201); }
  catch (error) { return errorResponse(c, error); }
});
router.get("/events", (c) => c.json(getWorkflowService().events(userId(c))));
router.post("/events/:id/replay", (c) => {
  try { return c.json(getWorkflowService().replayEvent(c.req.param("id"), userId(c)), 201); }
  catch (error) { return errorResponse(c, error); }
});
router.get("/status", (c) => isSystemAdmin(userId(c)) ? c.json(automationRuntime.status()) : c.json({ error: "Forbidden" }, 403));
router.get("/runs/:id", (c) => {
  try { return c.json(getWorkflowService().runDetail(c.req.param("id"), userId(c))); }
  catch (error) { return errorResponse(c, error); }
});
router.post("/runs/:id/cancel", (c) => {
  try { return c.json(getWorkflowService().cancelRun(c.req.param("id"), userId(c))); }
  catch (error) { return errorResponse(c, error); }
});
router.get("/:id", (c) => {
  try { return c.json(getWorkflowService().get(c.req.param("id"), userId(c))); }
  catch (error) { return errorResponse(c, error); }
});
router.put("/:id", async (c) => {
  try { return c.json(getWorkflowService().update(c.req.param("id"), userId(c), await c.req.json())); }
  catch (error) { return errorResponse(c, error); }
});
router.delete("/:id", (c) => {
  try { getWorkflowService().remove(c.req.param("id"), userId(c)); return c.json({ success: true }); }
  catch (error) { return errorResponse(c, error); }
});
router.post("/:id/enable", (c) => {
  try { return c.json(getWorkflowService().enable(c.req.param("id"), userId(c), true)); }
  catch (error) { return errorResponse(c, error); }
});
router.post("/:id/disable", (c) => {
  try { return c.json(getWorkflowService().enable(c.req.param("id"), userId(c), false)); }
  catch (error) { return errorResponse(c, error); }
});
router.post("/:id/run", (c) => {
  try { return c.json(getWorkflowService().run(c.req.param("id"), userId(c)), 202); }
  catch (error) { return errorResponse(c, error); }
});
router.get("/:id/runs", (c) => {
  try { return c.json(getWorkflowService().runs(c.req.param("id"), userId(c))); }
  catch (error) { return errorResponse(c, error); }
});

export default router;
