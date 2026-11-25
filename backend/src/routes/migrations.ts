import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z, ZodError } from "zod";
import { MIGRATION_LIMITS, migrationRelativePathSchema, migrationStageSchema } from "../services/migrationFormat.js";
import { migrationDirectoryBytes, sniffMigrationAsset } from "../services/migrationSourceAdapter.js";
import { MIGRATION_SOURCE_ADAPTERS, MIGRATION_SOURCE_ADAPTER_API_VERSION } from "../services/migrationSourceAdapters.js";
import {
  MigrationError, approveMigration, beginMigrationUpload, controlMigration, createMigration, decideMigrationItem,
  failMigrationUpload, finishMigrationUpload, getMigration, listMigrations, migrationJobDirectory,
  migrationReport, previewMigration, registerMigrationAsset, stageMigrationItems, undoMigration,
  type MigrationActor,
} from "../services/migrationService.js";

const app = new Hono();
const actor = (c: any): MigrationActor => ({ userId: c.req.header("X-User-Id") || "", tokenId: c.req.header("X-Auth-Mode") === "api-token" ? c.req.header("X-Api-Token-Id") || "" : null });
app.use("*", async (c, next) => {
  if (!actor(c).userId) return c.json({ code: "UNAUTHENTICATED", error: "请先登录" }, 401);
  await next();
});
app.onError((error, c) => {
    if (error instanceof ZodError) return c.json({ code: "MIGRATION_INVALID_INPUT", error: "迁移数据不符合 NMF v1 格式或超出限制", issues: error.issues.map((issue) => ({ path: issue.path, code: issue.code })).slice(0, 20) }, 400);
    if (error instanceof MigrationError) return c.json({ code: error.code, error: error.message }, error.status as never);
    return c.json({ code: "MIGRATION_REQUEST_FAILED", error: "迁移请求失败，请重试或查看导入报告" }, 500);
});
app.use("*", async (c, next) => {
  if (c.req.path.endsWith("/uploads")) return next();
  return bodyLimit({ maxSize: MIGRATION_LIMITS.stageBytes, onError: (context) => context.json({ code: "MIGRATION_REQUEST_TOO_LARGE", error: "单次迁移请求不能超过 8MB" }, 413) })(c, next);
});
app.get("/capabilities", (c) => c.json({
  schemaVersion: 1, formats: ["markdown", "html", "txt", "zip", "nmf-v1"],
  sourceAdapters: ["notion-markdown-html-csv", "siyuan-native-zip"], resumableUploads: true, uploadChunkBytes: 4 * 1024 * 1024,
  adapterApiVersion: MIGRATION_SOURCE_ADAPTER_API_VERSION, adapters: MIGRATION_SOURCE_ADAPTERS,
  limits: MIGRATION_LIMITS, strategies: ["new-root", "skip-existing"],
  humanApprovalRequired: true, remoteFetch: false, overwrite: false,
  requiredScopes: ["export:import", "notes:read", "notes:write", "notebooks:read", "notebooks:write"],
  optionalScopes: { attachments: "attachments:write", tags: "tags:write" },
  permissions: { canApprove: Boolean(c.get("migrationApprovalSession" as never)) && !actor(c).tokenId },
  approvalUrl: "/settings/data/import-migration",
}));
app.get("/", (c) => c.json({ items: listMigrations(actor(c)) }));
app.post("/", async (c) => c.json(createMigration(actor(c), await c.req.json()), 201));
app.get("/:id", (c) => c.json(getMigration(actor(c), c.req.param("id"))));
app.post("/:id/items", async (c) => {
  const body = migrationStageSchema.parse(await c.req.json());
  return c.json(await stageMigrationItems(actor(c), c.req.param("id"), body.items));
});
app.post("/:id/preview", async (c) => c.json(await previewMigration(actor(c), c.req.param("id"))));
app.post("/:id/items/:itemId/decision", async (c) => c.json(await decideMigrationItem(actor(c), c.req.param("id"), c.req.param("itemId"), await c.req.json())));
function approvalSession(c: any): string {
  const session = c.get("migrationApprovalSession") as { userId: string; sessionId: string } | undefined;
  if (!session || session.userId !== actor(c).userId || actor(c).tokenId) throw new MigrationError("MIGRATION_HUMAN_APPROVAL_REQUIRED", "请在 Nowen Note 中登录并确认此操作", 403);
  return session.sessionId;
}
app.post("/:id/approve", async (c) => {
  const session = approvalSession(c);
  const body = z.object({ previewDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json());
  return c.json(approveMigration(actor(c), c.req.param("id"), body.previewDigest, session), 202);
});
for (const action of ["pause", "resume", "retry", "cancel"] as const) app.post(`/:id/${action}`, (c) => c.json(controlMigration(actor(c), c.req.param("id"), action)));
app.post("/:id/undo", (c) => c.json(undoMigration(actor(c), c.req.param("id"), approvalSession(c))));
app.get("/:id/report", (c) => c.json(migrationReport(actor(c), c.req.param("id"), c.req.query("cursor") || "", Number(c.req.query("limit")) || 100)));

app.post("/:id/uploads", async (c) => {
  const owner = actor(c), id = c.req.param("id");
  const filename = (c.req.query("filename") || "").normalize("NFC");
  if (!filename || filename.length > 200 || filename !== path.basename(filename) || /[\u0000-\u001f\\]/.test(filename)) throw new MigrationError("MIGRATION_FILENAME_INVALID", "请选择有效的文件名");
  const assetPath = c.req.query("assetPath");
  if (!assetPath && !/\.(md|markdown|html?|txt|zip)$/i.test(filename)) throw new MigrationError("MIGRATION_FORMAT_UNSUPPORTED", "请上传 Markdown、HTML、TXT 或 ZIP 文件");
  const relative = assetPath ? migrationRelativePathSchema.parse(assetPath) : `sources/${crypto.randomUUID()}/upload${path.extname(filename).toLowerCase()}`;
  if (assetPath && !relative.startsWith("assets/")) throw new MigrationError("MIGRATION_ASSET_PATH", "附件必须位于 assets 目录");
  const expectedHash = c.req.query("sha256");
  if (assetPath && (!expectedHash || !/^[a-fA-F0-9]{64}$/.test(expectedHash))) throw new MigrationError("MIGRATION_ASSET_HASH_REQUIRED", "上传附件需要 SHA-256 校验和");
  beginMigrationUpload(owner, id);
  const jobDir = migrationJobDirectory(id);
  const diskPath = path.join(jobDir, relative);
  const maxBytes = assetPath ? MIGRATION_LIMITS.assetBytes : /\.zip$/i.test(filename) ? MIGRATION_LIMITS.uploadBytes : MIGRATION_LIMITS.contentBytes;
  const initialBytes = migrationDirectoryBytes(jobDir);
  // One compressed upload and one expanded package fit within this independent temporary quota.
  const tempBudget = MIGRATION_LIMITS.temporaryBytes;
  let bytes = 0;
  let opened = false;
  const uploadStarted = performance.now();
  const digest = crypto.createHash("sha256");
  try {
    if (Number(c.req.header("content-length")) > maxBytes || initialBytes >= tempBudget) throw new MigrationError("MIGRATION_UPLOAD_TOO_LARGE", "文件或迁移临时目录超过容量限制", 413);
    const space = fs.statfsSync(jobDir);
    if (space.bavail * space.bsize < Math.max(0, Number(c.req.header("content-length")) || 0) + 1024 * 1024) throw new MigrationError("MIGRATION_STORAGE_FULL", "临时存储空间不足", 413);
    if (!c.req.raw.body) throw new MigrationError("MIGRATION_UPLOAD_EMPTY", "上传文件为空");
    fs.mkdirSync(path.dirname(diskPath), { recursive: true, mode: 0o700 });
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes || bytes + initialBytes > tempBudget) { callback(new MigrationError("MIGRATION_UPLOAD_TOO_LARGE", "文件或迁移临时目录超过容量限制", 413)); return; }
      digest.update(chunk);
      const wait = bytes / MIGRATION_LIMITS.uploadBytesPerSecond * 1000 - (performance.now() - uploadStarted);
      if (wait > 1) setTimeout(() => callback(null, chunk), wait);
      else callback(null, chunk);
    } });
    const output = fs.createWriteStream(diskPath, { flags: "wx", mode: 0o600 });
    output.on("open", () => { opened = true; });
    await pipeline(Readable.fromWeb(c.req.raw.body as never), meter, output);
    if (!bytes) throw new MigrationError("MIGRATION_UPLOAD_EMPTY", "上传文件为空");
    const sha256 = digest.digest("hex");
    if (expectedHash && sha256 !== expectedHash.toLowerCase()) throw new MigrationError("MIGRATION_HASH_MISMATCH", "上传文件校验失败");
    if (assetPath) {
      await sniffMigrationAsset(diskPath, relative);
      registerMigrationAsset(owner, id, relative, sha256, bytes);
      failMigrationUpload(owner, id);
    } else finishMigrationUpload(owner, id, { filename, path: relative });
    return c.json(getMigration(owner, id), 202);
  } catch (error) {
    // A cancelled job keeps committed notes; incomplete upload bytes are never a staged source.
    try { if (opened) fs.rmSync(diskPath, { force: true }); } catch { /* best effort */ }
    try { failMigrationUpload(owner, id); } catch { /* task may have been cancelled */ }
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw new MigrationError("MIGRATION_UPLOAD_CONFLICT", "文件已上传，请使用新的附件路径或继续现有任务", 409);
    throw error;
  }
});
export default app;
