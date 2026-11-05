import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import imports from "./ai-memory-imports.js";
import {
  AI_MEMORY_LIMITS, AIMemoryError, createAIMemorySource, deleteAIConversation, exportAIConversation, getAIConversation, getAIMemorySource,
  getAIConversationMessages, ingestAIConversation, listAIConversations, listAIMemorySources,
  rebuildAIConversationNote, restoreAIConversation, revokeAIMemorySource, updateAIMemorySource,
  type AIMemoryActor,
} from "../services/aiMemoryService.js";

const app = new Hono();
const actor = (c: any): AIMemoryActor => ({ userId: c.req.header("X-User-Id") || "", tokenId: c.req.header("X-Auth-Mode") === "api-token" ? c.req.header("X-Api-Token-Id") || "" : null });
app.use("*", async (c, next) => {
  if (!actor(c).userId) return c.json({ code: "UNAUTHENTICATED", error: "请先登录" }, 401);
  if (c.req.path.endsWith("/imports/preview")) return next();
  return bodyLimit({ maxSize: AI_MEMORY_LIMITS.requestBytes, onError: (context) => context.json({ code: "AI_CAPTURE_TOO_LARGE", error: "单次请求不能超过 4MB" }, 413) })(c, next);
});
app.onError((error, c) => {
  if (error instanceof ZodError) return c.json({ code: "AI_MEMORY_INVALID_INPUT", error: "对话数据格式无效或超过限制", issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })).slice(0, 20) }, 400);
  if (error instanceof AIMemoryError) return c.json({ code: error.code, error: error.message, ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }, error.status as never);
  if (error instanceof SyntaxError) return c.json({ code: "AI_MEMORY_INVALID_INPUT", error: "请求不是有效 JSON" }, 400);
  return c.json({ code: "AI_MEMORY_REQUEST_FAILED", error: "对话归档请求失败，请重试" }, 500);
});
app.get("/capabilities", (c) => c.json({ schemaVersion: 1, platforms: { chatgpt: "fixture-tested", doubao: "fixture-tested", claude: "planned", gemini: "planned", deepseek: "planned" }, limits: AI_MEMORY_LIMITS, rawArchiveSync: "instance-local", noteProjectionSync: "existing-note-sync", autoCaptureDefault: false, sourceScope: "personal-notebook" }));
app.route("/imports", imports);
app.get("/sources", (c) => c.json(listAIMemorySources(actor(c))));
app.get("/sources/:id", (c) => c.json(getAIMemorySource(actor(c), c.req.param("id"))));
app.post("/sources", async (c) => c.json(createAIMemorySource(actor(c), await c.req.json()), 201));
app.patch("/sources/:id", async (c) => c.json(updateAIMemorySource(actor(c), c.req.param("id"), await c.req.json())));
app.delete("/sources/:id", (c) => c.json(revokeAIMemorySource(actor(c), c.req.param("id"))));
app.post("/conversations/ingest", async (c) => c.json(ingestAIConversation(actor(c), await c.req.json())));
app.get("/conversations", (c) => c.json(listAIConversations(actor(c), {
  sourceId: c.req.query("sourceId"), externalConversationId: c.req.query("externalConversationId"), q: c.req.query("q"),
  limit: Number(c.req.query("limit")) || 50, offset: Number(c.req.query("offset")) || 0, includeDeleted: c.req.query("includeDeleted") === "true",
})));
app.get("/conversations/:id/messages", (c) => c.json(getAIConversationMessages(actor(c), c.req.param("id"))));
app.get("/conversations/:id/export", (c) => c.json(exportAIConversation(actor(c), c.req.param("id"))));
app.get("/conversations/:id", (c) => c.json(getAIConversation(actor(c), c.req.param("id"))));
app.delete("/conversations/:id", (c) => c.json(deleteAIConversation(actor(c), c.req.param("id"))));
app.post("/conversations/:id/restore", (c) => c.json(restoreAIConversation(actor(c), c.req.param("id"))));
app.post("/conversations/:id/rebuild-note", (c) => c.json(rebuildAIConversationNote(actor(c), c.req.param("id"))));
export default app;
