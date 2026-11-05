import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { AIImportError, AI_IMPORT_LIMITS, parseAIImport, type ImportedSnapshot } from "./ai-memory-import-parser";
import { assertAIMemoryImportAccess, getAIMemorySource, ingestAIConversation, listAIConversations, type AIMemoryActor } from "../services/aiMemoryService";

type Status = "PREVIEW" | "IMPORTING" | "COMPLETED" | "PARTIAL" | "FAILED" | "CANCELLED" | "INTERRUPTED";
type Item = { index: number; title: string; messages: number; completeness: string; expectedRevision: number; preview: string; snapshotHash: string;
  status: "pending" | "saved" | "failed"; noteId?: string; error?: string };
type Job = { id: string; userId: string; tokenId: string | null; sourceId: string; filename: string; status: Status;
  createdAt: string; updatedAt: string; expiresAt: string; previewDigest: string; items: Item[]; skipped: number; warnings: string[] };
const running = new Set<string>();
const root = () => path.join(process.env.ELECTRON_USER_DATA || path.join(process.cwd(), "data"), "ai-memory-imports");
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function directory(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new AIImportError("AI_IMPORT_NOT_FOUND", "导入任务不存在", 404);
  return path.join(root(), id);
}
function save(job: Job): void {
  job.updatedAt = new Date().toISOString();
  const temporary = path.join(directory(job.id), "job.tmp");
  fs.writeFileSync(temporary, JSON.stringify(job), { mode: 0o600 });
  fs.renameSync(temporary, path.join(directory(job.id), "job.json"));
}
function read(id: string): Job {
  try { return JSON.parse(fs.readFileSync(path.join(directory(id), "job.json"), "utf8")) as Job; }
  catch (error) { if (error instanceof AIImportError) throw error; throw new AIImportError("AI_IMPORT_NOT_FOUND", "导入任务不存在或已经过期", 404); }
}
function owned(actor: AIMemoryActor, id: string, write = false): Job {
  const job = read(id);
  if (job.userId !== actor.userId || job.tokenId !== (actor.tokenId || null)) throw new AIImportError("AI_IMPORT_NOT_FOUND", "导入任务不存在", 404);
  if (Date.parse(job.expiresAt) <= Date.now()) throw new AIImportError("AI_IMPORT_EXPIRED", "临时导入资料已过期，请重新上传", 410);
  assertAIMemoryImportAccess(actor, job.sourceId, write);
  return job;
}
function publicJob(job: Job) {
  const { userId, tokenId, ...value } = job;
  return { ...value, counts: { total: job.items.length, saved: job.items.filter(item => item.status === "saved").length,
    failed: job.items.filter(item => item.status === "failed").length, pending: job.items.filter(item => item.status === "pending").length, skipped: job.skipped } };
}
function reserve(actor: AIMemoryActor): string {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 });
  let total = 0, user = 0;
  for (const entry of fs.readdirSync(root(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    const dir = directory(entry.name);
    if (!running.has(entry.name) && fs.statSync(dir).mtimeMs < Date.now() - 24 * 60 * 60_000) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
    total++;
    try { if (JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf8")).userId === actor.userId) user++; } catch { /* damaged jobs still count toward instance quota */ }
  }
  if (total >= 32 || user >= 3) throw new AIImportError("AI_IMPORT_QUOTA", "临时导入任务达到上限，请等待过期或清理已有任务", 429);
  const id = crypto.randomUUID(); fs.mkdirSync(directory(id), { mode: 0o700 });
  fs.writeFileSync(path.join(directory(id), "owner.json"), JSON.stringify({ userId: actor.userId }), { mode: 0o600 }); return id;
}

export async function previewAIImport(actor: AIMemoryActor, input: { sourceId: string; filename: string; body: ReadableStream<Uint8Array>; contentLength?: number }) {
  const source = assertAIMemoryImportAccess(actor, input.sourceId, true);
  if (source.permissionState !== "granted") throw new AIImportError("AI_SOURCE_NOT_AUTHORIZED", "来源授权已撤销，请先重新授权", 403);
  if (!input.filename || input.filename.length > 200 || input.filename !== path.basename(input.filename) || /[\\\u0000-\u001f]/.test(input.filename)
    || !/\.(zip|json|md|markdown|txt)$/i.test(input.filename)) throw new AIImportError("AI_IMPORT_FORMAT_UNSUPPORTED", "请选择 ZIP、JSON、Markdown 或 TXT 文件");
  if ((input.contentLength || 0) > AI_IMPORT_LIMITS.uploadBytes) throw new AIImportError("AI_IMPORT_UPLOAD_LIMIT", "导入文件不能超过 64MB", 413);
  const id = reserve(actor), dir = directory(id), uploaded = path.join(dir, "upload");
  running.add(id);
  try {
    let bytes = 0;
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > AI_IMPORT_LIMITS.uploadBytes ? new AIImportError("AI_IMPORT_UPLOAD_LIMIT", "导入文件不能超过 64MB", 413) : null, chunk);
    } });
    await pipeline(Readable.fromWeb(input.body as never), meter, fs.createWriteStream(uploaded, { flags: "wx", mode: 0o600 }));
    if (!bytes) throw new AIImportError("AI_IMPORT_UPLOAD_EMPTY", "导入文件为空");
    const items: Item[] = [], snapshots: string[] = [];
    const report = await parseAIImport({ filePath: uploaded, filename: input.filename, directory: dir, source,
      onSnapshot: async (snapshot) => {
        assertAIMemoryImportAccess(actor, input.sourceId, true);
        const existing = listAIConversations(actor, { sourceId: input.sourceId, externalConversationId: snapshot.externalConversationId, limit: 1 }).items[0];
        const index = items.length;
        const serialized = JSON.stringify(snapshot);
        fs.writeFileSync(path.join(dir, `${index}.json`), serialized, { mode: 0o600 });
        snapshots.push(digest(serialized));
        items.push({ index, title: snapshot.title, messages: snapshot.messages.length, completeness: snapshot.completeness, preview: snapshot.messages[0].text.slice(0, 600),
          expectedRevision: existing?.revision || 0, snapshotHash: digest(serialized), status: "pending" });
        await yieldEventLoop();
      } });
    const now = new Date().toISOString();
    const job: Job = { id, userId: actor.userId, tokenId: actor.tokenId || null, sourceId: input.sourceId, filename: input.filename,
      status: "PREVIEW", createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
      previewDigest: digest({ sourceId: input.sourceId, snapshots, items }), items, skipped: report.skipped, warnings: report.warnings };
    save(job);
    fs.rmSync(uploaded, { force: true }); fs.rmSync(path.join(dir, "expanded"), { recursive: true, force: true });
    return publicJob(job);
  } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  finally { running.delete(id); }
}
export function listAIImports(actor: AIMemoryActor) {
  if (!fs.existsSync(root())) return { items: [] };
  const jobs: ReturnType<typeof publicJob>[] = [];
  for (const entry of fs.readdirSync(root(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { jobs.push(getAIImport(actor, entry.name)); } catch { /* hide expired/inaccessible/other-account jobs */ }
  }
  return { items: jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}
export function getAIImport(actor: AIMemoryActor, id: string) {
  const job = owned(actor, id);
  if (job.status === "IMPORTING" && !running.has(id)) { job.status = "INTERRUPTED"; save(job); }
  return publicJob(job);
}
async function run(actor: AIMemoryActor, id: string): Promise<void> {
  try {
    for (let index = 0; index < read(id).items.length; index++) {
      await yieldEventLoop();
      let job = owned(actor, id, true);
      if (job.status !== "IMPORTING") break;
      if (job.items[index].status === "saved") continue;
      try {
        const serialized = fs.readFileSync(path.join(directory(id), `${index}.json`), "utf8");
        if (digest(serialized) !== job.items[index].snapshotHash) throw new AIImportError("AI_IMPORT_STAGING_CORRUPTED", "暂存内容与预览不一致，请重新上传", 409);
        const snapshot = JSON.parse(serialized) as ImportedSnapshot;
        const result = await ingestAIConversation(actor, { sourceId: job.sourceId, operationId: `import:${id}:${index}`, mode: "import",
          expectedRevision: job.items[index].expectedRevision, snapshot });
        job = read(id); job.items[index].status = "saved"; job.items[index].noteId = result.noteId; delete job.items[index].error;
      } catch (error) {
        job = read(id); job.items[index].status = "failed";
        job.items[index].error = typeof (error as any)?.code === "string" ? (error as any).code : "AI_IMPORT_ITEM_FAILED";
      }
      save(job);
    }
    const job = read(id);
    if (job.status === "IMPORTING") { const failed = job.items.filter(item => item.status === "failed").length;
      job.status = failed ? job.items.some(item => item.status === "saved") ? "PARTIAL" : "FAILED" : "COMPLETED"; save(job); }
  } catch {
    try { const job = read(id); if (job.status === "IMPORTING") { job.status = "INTERRUPTED"; save(job); } } catch { /* expired storage */ }
  } finally { running.delete(id); }
}
export function startAIImport(actor: AIMemoryActor, id: string, previewDigest: string, retry = false) {
  const job = owned(actor, id, true);
  if (assertAIMemoryImportAccess(actor, job.sourceId, true).permissionState !== "granted") throw new AIImportError("AI_SOURCE_NOT_AUTHORIZED", "来源授权已撤销，请先重新授权", 403);
  if (previewDigest !== job.previewDigest) throw new AIImportError("AI_IMPORT_PREVIEW_CHANGED", "导入预览发生变化，请重新检查", 409);
  if (job.status === "IMPORTING" || job.status === "COMPLETED") return publicJob(job);
  if (running.has(id)) throw new AIImportError("AI_IMPORT_BUSY", "正在停止当前处理，请稍后重试", 409);
  if (!(retry ? ["FAILED", "PARTIAL", "INTERRUPTED", "CANCELLED"] : ["PREVIEW"]).includes(job.status)) throw new AIImportError("AI_IMPORT_STATE", "当前任务状态不允许此操作", 409);
  job.status = "IMPORTING"; save(job); running.add(id);
  void run({ ...actor }, id);
  return publicJob(job);
}
export function cancelAIImport(actor: AIMemoryActor, id: string) {
  const job = owned(actor, id);
  getAIMemorySource(actor, job.sourceId, true);
  if (job.status !== "COMPLETED") { job.status = "CANCELLED"; save(job); }
  return publicJob(job);
}
export function discardAIImport(actor: AIMemoryActor, id: string) {
  const job = owned(actor, id);
  getAIMemorySource(actor, job.sourceId, true);
  if (running.has(id)) throw new AIImportError("AI_IMPORT_BUSY", "请先取消并等待当前会话保存结束", 409);
  fs.rmSync(directory(id), { recursive: true, force: true });
}
