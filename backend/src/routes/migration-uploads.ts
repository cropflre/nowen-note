import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod";
import { MigrationError, type MigrationActor } from "../services/migrationService.js";
import {
  MIGRATION_CHUNK_BYTES, cancelMigrationUploadSession, completeMigrationUploadSession,
  createMigrationUploadSession, getMigrationUploadSession, putMigrationUploadChunk,
} from "../services/migrationUploads.js";

const app = new Hono();
const actor = (c: any): MigrationActor => ({ userId: c.req.header("X-User-Id") || "", tokenId: c.req.header("X-Auth-Mode") === "api-token" ? c.req.header("X-Api-Token-Id") || "" : null });
app.onError((error, c) => {
  if (error instanceof MigrationError) return c.json({ code: error.code, error: error.message }, error.status as never);
  if (error instanceof ZodError || error instanceof SyntaxError) return c.json({ code: "MIGRATION_INVALID_INPUT", error: "上传会话参数无效" }, 400);
  return c.json({ code: "MIGRATION_UPLOAD_FAILED", error: "上传未确认，请查询会话偏移后重试" }, 500);
});
app.use("/:id/upload-sessions/*", bodyLimit({ maxSize: MIGRATION_CHUNK_BYTES, onError: (c) => c.json({ code: "MIGRATION_CHUNK_TOO_LARGE", error: "上传分块不能超过 4MiB" }, 413) }));
app.post("/:id/upload-sessions", bodyLimit({ maxSize: 16 * 1024 }), async (c) => c.json(createMigrationUploadSession(actor(c), c.req.param("id"), await c.req.json()), 201));
app.get("/:id/upload-sessions/:uploadId", (c) => c.json(getMigrationUploadSession(actor(c), c.req.param("id"), c.req.param("uploadId"))));
app.put("/:id/upload-sessions/:uploadId/chunks", async (c) => {
  const rawOffset = c.req.query("offset") || "";
  if (!/^\d+$/.test(rawOffset)) throw new MigrationError("MIGRATION_UPLOAD_OFFSET", "请提供已确认的上传偏移", 409);
  return c.json(await putMigrationUploadChunk(actor(c), c.req.param("id"), c.req.param("uploadId"), Number(rawOffset), c.req.header("X-Chunk-SHA256") || "", c.req.raw.body));
});
app.post("/:id/upload-sessions/:uploadId/complete", async (c) => c.json(await completeMigrationUploadSession(actor(c), c.req.param("id"), c.req.param("uploadId")), 202));
app.delete("/:id/upload-sessions/:uploadId", (c) => c.json(cancelMigrationUploadSession(actor(c), c.req.param("id"), c.req.param("uploadId"))));

export default app;
