import { Hono } from "hono";
import { z } from "zod";
import { AIMemoryError, type AIMemoryActor } from "../services/aiMemoryService";
import { AIImportError } from "../lib/ai-memory-import-parser";
import { cancelAIImport, discardAIImport, getAIImport, listAIImports, previewAIImport, startAIImport } from "../lib/ai-memory-import-jobs";
const app = new Hono();
const actor = (c: any): AIMemoryActor => ({ userId: c.req.header("X-User-Id") || "", tokenId: c.req.header("X-Auth-Mode") === "api-token" ? c.req.header("X-Api-Token-Id") || "" : null });
app.use("*", async (c, next) => { if (!actor(c).userId) return c.json({ code: "UNAUTHENTICATED", error: "请先登录" }, 401); await next(); });
app.onError((error, c) => {
  if (error instanceof AIImportError || error instanceof AIMemoryError) return c.json({ code: error.code, error: error.message }, error.status as never);
  if (error instanceof z.ZodError) return c.json({ code: "AI_IMPORT_INVALID_INPUT", error: "导入请求无效" }, 400);
  return c.json({ code: "AI_IMPORT_FAILED", error: "导入失败，请重新上传或查看任务报告" }, 500);
});
app.get("/", c => c.json(listAIImports(actor(c))));
app.post("/preview", async c => {
  if (!c.req.raw.body) throw new AIImportError("AI_IMPORT_UPLOAD_EMPTY", "请选择导入文件");
  return c.json(await previewAIImport(actor(c), { sourceId: z.string().min(1).max(200).parse(c.req.query("sourceId")),
    filename: c.req.query("filename") || "", body: c.req.raw.body, contentLength: Number(c.req.header("content-length")) || 0 }), 201);
});
const start = z.object({ jobId: z.string().uuid(), previewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
app.post("/", async c => { const body = start.parse(await c.req.json()); return c.json(startAIImport(actor(c), body.jobId, body.previewDigest), 202); });
app.get("/:jobId", c => c.json(getAIImport(actor(c), c.req.param("jobId"))));
app.post("/:jobId/cancel", c => c.json(cancelAIImport(actor(c), c.req.param("jobId"))));
app.post("/:jobId/retry", async c => {
  const body = start.pick({ previewDigest: true }).parse(await c.req.json());
  return c.json(startAIImport(actor(c), c.req.param("jobId"), body.previewDigest, true), 202);
});
app.delete("/:jobId", c => { discardAIImport(actor(c), c.req.param("jobId")); return c.json({ deleted: true }); });
export default app;
