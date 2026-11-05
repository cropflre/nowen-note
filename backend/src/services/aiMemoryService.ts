import crypto from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/schema.js";
import { hasPermission, resolveNotebookPermission } from "../middleware/acl.js";
import { createKnowledgeChild, deleteKnowledgeNode, restoreKnowledgeNode } from "./knowledgeTree.js";
import { resolveKnowledgeNodeAccess } from "./knowledgeCapabilities.js";
import { syncNoteBlocks } from "../lib/noteBlocks.js";
import { syncNoteLinks } from "../lib/noteLinks.js";
import { syncReferences } from "../lib/attachmentRefs.js";
import { rebuildBlockAuthorityStore } from "../lib/blockAuthorityStore.js";
import { rebuildYjsSubdocumentsIfEnabled } from "./yjs-subdocuments.js";
import { notifySyncChanged } from "../sync/notify.js";
import { getYjsStats } from "./yjs.js";

export type AIMemoryActor = { userId: string; tokenId?: string | null };
export class AIMemoryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly currentRevision?: number) { super(message); }
}
export const AI_MEMORY_LIMITS = { requestBytes: 4 * 1024 * 1024, snapshotBytes: 2 * 1024 * 1024, messages: 1000, text: 256 * 1024, conversationMessages: 10_000, conversationBytes: 16 * 1024 * 1024 };
const id = z.string().trim().min(1).max(200);
const provider = z.enum(["chatgpt", "doubao", "claude", "gemini", "deepseek", "standard"]);
const role = z.enum(["user", "assistant", "system", "tool", "unknown"]);
const block = z.object({
  type: z.enum(["text", "markdown", "code", "image", "attachment", "tool"]),
  text: z.string().max(AI_MEMORY_LIMITS.text).optional(), language: z.string().max(80).optional(),
  url: z.string().max(2000).optional(), name: z.string().max(500).optional(),
}).strict();
export const aiConversationSnapshotSchema = z.object({
  provider, accountScope: id, externalConversationId: id,
  title: z.string().trim().min(1).max(500), sourceUrl: z.string().max(2000),
  messages: z.array(z.object({
    externalMessageId: id.optional(), localSequence: z.number().int().min(0).max(1_000_000), role,
    blocks: z.array(block).max(256), text: z.string().max(AI_MEMORY_LIMITS.text),
    contentHash: z.string().max(128).optional(), captureState: z.enum(["streaming", "stable", "partial"]),
    createdAt: z.string().datetime().optional(), updatedAt: z.string().datetime().optional(),
  }).strict()).min(1).max(AI_MEMORY_LIMITS.messages),
  completeness: z.enum(["complete", "partial", "unknown"]), capturedAt: z.string().datetime(),
}).strict();
export type AIConversationSnapshot = z.infer<typeof aiConversationSnapshotSchema>;
const sourceSchema = z.object({
  provider, accountScope: id, displayName: z.string().trim().min(1).max(200).optional(), notebookId: id,
  captureEnabled: z.boolean().default(false), permissionState: z.literal("granted"),
}).strict();
type Source = { id: string; userId: string; provider: string; accountScope: string; displayName: string; notebookId: string; captureEnabled: number; permissionState: string; createdAt: string; updatedAt: string; lastSyncedAt: string | null };
type Conversation = { id: string; userId: string; sourceId: string; externalConversationId: string; title: string; sourceUrl: string; completeness: string; noteId: string | null; projectionHash: string | null; projectionStatus: string; revision: number; contentHash: string; lastSnapshotHash: string; lastSyncedAt: string; createdAt: string; updatedAt: string; deletedAt: string | null };
type Message = { id: string; userId: string; conversationId: string; externalMessageId: string; identityState: string; sequence: number; role: string; blocksJson: string; contentText: string; contentHash: string; captureState: string; revision: number; createdAt: string; updatedAt: string };
type Projection = { id: string; userId: string; notebookId: string; workspaceId: string | null; title: string; content: string; contentFormat: string; isTrashed: number; isLocked: number; version: number };
const digest = (value: unknown) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const now = () => new Date().toISOString();
const sourceView = (row: Source) => ({ ...row, captureEnabled: Boolean(row.captureEnabled) });
const query = (sql: string) => getDb().prepare(sql);

function assertActor(actor: AIMemoryActor) {
  if (!actor.userId) throw new AIMemoryError("UNAUTHENTICATED", "请先登录", 401);
  const user = query("SELECT isDisabled,personalImportEnabled FROM users WHERE id=?").get(actor.userId) as { isDisabled: number; personalImportEnabled: number } | undefined;
  if (!user || user.isDisabled) throw new AIMemoryError("AI_CONTEXT_SCOPE_DENIED", "账号不可用", 403);
  return user;
}
function assertToken(actor: AIMemoryActor, notebookId: string | null, write: boolean) {
  if (!actor.tokenId) return;
  const token = query("SELECT userId,scopes,resourceMode,revokedAt,expiresAt FROM api_tokens WHERE id=?").get(actor.tokenId) as { userId: string; scopes: string; resourceMode: string; revokedAt: string | null; expiresAt: string | null } | undefined;
  if (!token || token.userId !== actor.userId || token.revokedAt || (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())) throw new AIMemoryError("AI_CONTEXT_SCOPE_DENIED", "授权已过期或被撤销", 403);
  const scopes = new Set(JSON.parse(token.scopes) as string[]);
  if (!scopes.has(write ? "notes:write" : "notes:read")) throw new AIMemoryError("API_TOKEN_SCOPE_REQUIRED", `需要 ${write ? "notes:write" : "notes:read"} 权限`, 403);
  if (token.resourceMode === "restricted") {
    if (!notebookId) throw new AIMemoryError("API_TOKEN_RESOURCE_DENIED", "请选择已授权的笔记本", 403);
    const allowed = query(`WITH RECURSIVE scope(id,permission,recurse) AS (
      SELECT resourceId,permission,includeDescendants FROM api_token_resources WHERE tokenId=? AND resourceType='notebook'
      UNION SELECT n.id,s.permission,s.recurse FROM notebooks n JOIN scope s ON n.parentId=s.id WHERE s.recurse=1 AND n.isDeleted=0
    ) SELECT 1 FROM scope WHERE id=? AND (?=0 OR permission='write') LIMIT 1`).get(actor.tokenId, notebookId, write ? 1 : 0);
    if (!allowed) throw new AIMemoryError("API_TOKEN_RESOURCE_DENIED", "Token 无权访问此来源的笔记本", 403);
  }
}
function assertNotebook(actor: AIMemoryActor, notebookId: string, write = false) {
  const user = assertActor(actor);
  if (write && user.personalImportEnabled === 0) throw new AIMemoryError("FEATURE_DISABLED", "管理员已禁用个人空间导入", 403);
  const notebook = query("SELECT userId,workspaceId,isDeleted FROM notebooks WHERE id=?").get(notebookId) as { userId: string; workspaceId: string | null; isDeleted: number } | undefined;
  if (!notebook || notebook.userId !== actor.userId || notebook.workspaceId || notebook.isDeleted
    || !hasPermission(resolveNotebookPermission(notebookId, actor.userId).permission, write ? "write" : "read")) throw new AIMemoryError("AI_CONTEXT_SCOPE_DENIED", "请选择自己的有效个人笔记本", 403);
  const protectedAncestor = query(`WITH RECURSIVE ancestors(id,parentId) AS (
    SELECT id,parentId FROM notebooks WHERE id=?
    UNION SELECT n.id,n.parentId FROM notebooks n JOIN ancestors a ON n.id=a.parentId
  ) SELECT 1 FROM ancestors JOIN notebook_passwords p ON p.notebookId=ancestors.id LIMIT 1`).get(notebookId);
  if (protectedAncestor) throw new AIMemoryError("AI_CONTEXT_SCOPE_DENIED", "当前归档暂不支持受密码保护的笔记本", 403);
  if (write && !resolveKnowledgeNodeAccess(`notebook:${notebookId}`, actor.userId, getDb()).capabilities.canCreate) throw new AIMemoryError("AI_CONTEXT_SCOPE_DENIED", "无权在目标笔记本创建内容", 403);
  assertToken(actor, notebookId, write);
}
export function getAIMemorySource(actor: AIMemoryActor, sourceId: string, write = false) {
  assertActor(actor);
  const source = query("SELECT * FROM external_ai_sources WHERE id=? AND userId=?").get(sourceId, actor.userId) as Source | undefined;
  if (!source) throw new AIMemoryError("AI_SOURCE_NOT_FOUND", "来源不存在", 404);
  assertNotebook(actor, source.notebookId, write);
  return sourceView(source);
}
export function assertAIMemoryImportAccess(actor: AIMemoryActor, sourceId: string, write = false) {
  const source = getAIMemorySource(actor, sourceId, write);
  if (write && source.permissionState !== "granted") throw new AIMemoryError("AI_SOURCE_NOT_AUTHORIZED", "来源授权已撤销，请先重新授权", 403);
  if (actor.tokenId) {
    const token = query("SELECT scopes FROM api_tokens WHERE id=?").get(actor.tokenId) as { scopes: string };
    if (!(JSON.parse(token.scopes) as string[]).includes("export:import")) throw new AIMemoryError("API_TOKEN_SCOPE_REQUIRED", "历史导入需要 export:import 权限", 403);
  }
  return source;
}
export function listAIMemorySources(actor: AIMemoryActor) {
  assertActor(actor);
  const sources = query("SELECT * FROM external_ai_sources WHERE userId=? ORDER BY updatedAt DESC,id").all(actor.userId) as Source[];
  const items = sources.filter((source) => {
    try { assertNotebook(actor, source.notebookId); return true; } catch (error) { if (error instanceof AIMemoryError && error.status === 403) return false; throw error; }
  }).map(sourceView);
  // An empty catalog must still enforce an unrestricted token's read scope.
  if (!actor.tokenId || items.length) return { items };
  const token = query("SELECT resourceMode FROM api_tokens WHERE id=?").get(actor.tokenId) as { resourceMode: string } | undefined;
  if (token?.resourceMode === "unrestricted") assertToken(actor, null, false);
  return { items };
}
export function createAIMemorySource(actor: AIMemoryActor, input: unknown) {
  const value = sourceSchema.parse(input);
  assertNotebook(actor, value.notebookId, true);
  return getDb().transaction(() => {
    const existing = query("SELECT * FROM external_ai_sources WHERE userId=? AND provider=? AND accountScope=?").get(actor.userId, value.provider, value.accountScope) as Source | undefined;
    if (existing) {
      if (existing.notebookId !== value.notebookId) throw new AIMemoryError("AI_SOURCE_BINDING_CONFLICT", "此来源已绑定其他笔记本，请创建新的来源标识", 409);
      // Idempotent creation cannot silently re-enable a paused/revoked source.
      return sourceView(existing);
    }
    const timestamp = now(), sourceId = crypto.randomUUID();
    query("INSERT INTO external_ai_sources(id,userId,provider,accountScope,displayName,notebookId,captureEnabled,permissionState,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(sourceId, actor.userId, value.provider, value.accountScope, value.displayName || value.provider, value.notebookId, Number(value.captureEnabled), value.permissionState, timestamp, timestamp);
    return getAIMemorySource(actor, sourceId);
  })();
}
export function updateAIMemorySource(actor: AIMemoryActor, sourceId: string, input: unknown) {
  const value = z.object({ displayName: z.string().trim().min(1).max(200).optional(), captureEnabled: z.boolean().optional(), permissionState: z.enum(["granted", "revoked"]).optional() }).strict().parse(input);
  const source = getAIMemorySource(actor, sourceId, true);
  const permission = value.permissionState ?? source.permissionState;
  const enabled = permission === "revoked" ? false : value.captureEnabled ?? source.captureEnabled;
  query("UPDATE external_ai_sources SET displayName=?,captureEnabled=?,permissionState=?,updatedAt=? WHERE id=? AND userId=?")
    .run(value.displayName ?? source.displayName, Number(enabled), permission, now(), sourceId, actor.userId);
  return getAIMemorySource(actor, sourceId);
}
export function revokeAIMemorySource(actor: AIMemoryActor, sourceId: string) { return updateAIMemorySource(actor, sourceId, { permissionState: "revoked", captureEnabled: false }); }

/** The existing account-transfer path does not migrate the complete archive/knowledge-tree graph. */
export function assertAIMemoryOwnershipTransferAllowed(db: ReturnType<typeof getDb>, fromId: string): void {
  if (db.prepare("SELECT 1 FROM external_ai_sources WHERE userId=? LIMIT 1").get(fromId)) {
    throw new AIMemoryError("AI_ARCHIVE_TRANSFER_REQUIRES_EXPORT", "此用户包含 AI 归档来源，暂不支持直接转移账号数据。请先导出原始会话并由接收人导入；原用户及数据均未修改。", 409);
  }
}

function normalizedUrl(value: string) {
  if (!value) return "";
  try { const url = new URL(value); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error(); url.search = ""; url.hash = ""; return url.href; }
  catch { throw new AIMemoryError("AI_MESSAGE_PARSE_FAILED", "来源链接格式无效"); }
}
function ownedConversation(actor: AIMemoryActor, conversationId: string, write = false, deleted = false): Conversation {
  const row = query(`SELECT * FROM external_ai_conversations WHERE id=? AND userId=? ${deleted ? "" : "AND deletedAt IS NULL"}`).get(conversationId, actor.userId) as Conversation | undefined;
  if (!row) throw new AIMemoryError("AI_CONVERSATION_NOT_FOUND", "对话归档不存在", 404);
  getAIMemorySource(actor, row.sourceId, write);
  return row;
}
function messages(conversationId: string) { return query("SELECT * FROM external_ai_messages WHERE conversationId=? ORDER BY sequence,id").all(conversationId) as Message[]; }
function projection(row: Conversation): Projection | undefined { return row.noteId ? query("SELECT id,userId,notebookId,workspaceId,title,content,contentFormat,isTrashed,isLocked,version FROM notes WHERE id=?").get(row.noteId) as Projection | undefined : undefined; }
function projectionFingerprint(note: Pick<Projection, "title" | "content" | "contentFormat">) { return digest([note.title, note.content, note.contentFormat]); }
function untouched(row: Conversation, source: ReturnType<typeof getAIMemorySource>, note: Projection | undefined) {
  if (!note || note.userId !== row.userId || note.workspaceId || note.notebookId !== source.notebookId || note.isTrashed || note.isLocked || note.contentFormat !== "markdown" || projectionFingerprint(note) !== row.projectionHash) return false;
  // A previously opened CRDT document can retain edits outside notes.content.
  // Preserve its room/history; rebuilding a fresh projection is the safe explicit action.
  return !getYjsStats().details.some((room) => room.noteId === note.id)
    && !query("SELECT 1 FROM note_yupdates WHERE noteId=? LIMIT 1").get(note.id)
    && !query("SELECT 1 FROM note_ysnapshots WHERE noteId=? LIMIT 1").get(note.id);
}
function assertArchiveRead(actor: AIMemoryActor, row: Conversation, allowTrashed = false) {
  if (!row.noteId) {
    if (row.projectionHash) throw new AIMemoryError("AI_CONTEXT_SCOPE_DENIED", "关联笔记已永久删除，请停止此会话的自动保存", 403);
    return;
  }
  const note = projection(row);
  // Source grants cannot bypass a projection moved into another notebook or protected later.
  if (!note || note.userId !== actor.userId || note.workspaceId || (note.isTrashed && !allowTrashed) || note.isLocked || note.contentFormat.startsWith("encrypted-")) throw new AIMemoryError("AI_CONTEXT_SCOPE_DENIED", "关联笔记已删除、受保护或不在当前个人空间", 403);
  assertNotebook(actor, note.notebookId);
  if (!resolveKnowledgeNodeAccess(`note:${note.id}`, actor.userId, getDb(), { includeDeleted: allowTrashed }).capabilities.canView) throw new AIMemoryError("AI_CONTEXT_SCOPE_DENIED", "无权读取关联笔记", 403);
}
export function listAIConversations(actor: AIMemoryActor, options: { sourceId?: string; externalConversationId?: string; q?: string; limit?: number; offset?: number; includeDeleted?: boolean } = {}) {
  assertActor(actor);
  const sources = options.sourceId ? [getAIMemorySource(actor, options.sourceId)] : listAIMemorySources(actor).items;
  const permitted = new Set(sources.map((source) => source.id));
  const rows = query("SELECT *, (SELECT COUNT(*) FROM external_ai_messages m WHERE m.conversationId=external_ai_conversations.id) AS messageCount FROM external_ai_conversations WHERE userId=? ORDER BY updatedAt DESC,id").all(actor.userId) as Array<Conversation & { messageCount: number }>;
  const matching = rows.filter((row) => {
    if (!permitted.has(row.sourceId) || (!options.includeDeleted && row.deletedAt) || (options.externalConversationId && row.externalConversationId !== options.externalConversationId) || (options.q && !row.title.toLocaleLowerCase().includes(options.q.toLocaleLowerCase()))) return false;
    try { assertArchiveRead(actor, row, Boolean(row.deletedAt)); } catch (error) { if (error instanceof AIMemoryError && error.status === 403) return false; throw error; }
    return true;
  });
  const offset = Math.max(0, Math.floor(options.offset || 0)), limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
  return { items: matching.slice(offset, offset + limit), total: matching.length };
}
export function getAIConversation(actor: AIMemoryActor, conversationId: string) { const row = ownedConversation(actor, conversationId); assertArchiveRead(actor, row); return { ...row, messageCount: messages(conversationId).length }; }
export function getAIConversationMessages(actor: AIMemoryActor, conversationId: string) { const row = ownedConversation(actor, conversationId); assertArchiveRead(actor, row); return { items: messages(conversationId).map((message) => ({ ...message, blocks: JSON.parse(message.blocksJson), text: message.contentText })) }; }
export function exportAIConversation(actor: AIMemoryActor, conversationId: string) {
  return getDb().transaction(() => {
    const row = ownedConversation(actor, conversationId);
    assertArchiveRead(actor, row);
    const source = getAIMemorySource(actor, row.sourceId);
    return {
      format: "nowen-ai-conversation", schemaVersion: 1, provider: source.provider, accountScope: source.accountScope,
      externalConversationId: row.externalConversationId, title: row.title, sourceUrl: row.sourceUrl,
      completeness: row.completeness, capturedAt: row.lastSyncedAt,
      messages: messages(conversationId).map((message) => ({
        externalMessageId: message.externalMessageId, localSequence: message.sequence, role: message.role,
        blocks: JSON.parse(message.blocksJson), text: message.contentText, contentHash: message.contentHash,
        captureState: message.captureState, createdAt: message.createdAt, updatedAt: message.updatedAt,
      })),
    };
  })();
}

function markdown(row: Conversation, entries: Message[]) {
  const plain = (value: string) => value.replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character]!);
  const safeMarkdown = (value: string) => {
    let fence = "", width = 0;
    return value.split("\n").map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && !fence) { fence = marker[0]; width = marker.length; return line; }
      if (fence) { if (marker?.[0] === fence && marker.length >= width) fence = ""; return line; }
      return line.split(/(`+[^`]*`+)/g).map((part) => part.startsWith("`") ? part : plain(part)).join("");
    }).join("\n");
  };
  const lines = [`# ${plain(row.title).replace(/\n/g, " ")}`, "", `来源：${row.sourceUrl ? `<${row.sourceUrl}>` : "文件导入"}`, `完整性：${row.completeness}`, "", "此笔记由对话归档生成。编辑后将停止自动覆盖。", ""];
  for (const message of entries) {
    lines.push(`## ${message.role}`, "");
    const blocks = JSON.parse(message.blocksJson) as z.infer<typeof block>[];
    const textBlocks = blocks.filter((item) => typeof item.text === "string" && item.type !== "image" && item.type !== "attachment");
    const rendered = textBlocks.map((item) => {
      if (item.type !== "code") return safeMarkdown(item.text!);
      const fence = "`".repeat(Math.max(3, ...Array.from(item.text!.matchAll(/`+/g), (match) => match[0].length + 1)));
      return `${fence}${(item.language || "").replace(/[^A-Za-z0-9_+-]/g, "")}\n${item.text}\n${fence}`;
    }).join("\n\n");
    lines.push(rendered || safeMarkdown(message.contentText), "");
    const refs = blocks.filter((item) => item.type === "image" || item.type === "attachment");
    for (const reference of refs) lines.push(`> 未下载的${reference.type === "image" ? "图片" : "附件"}引用：${plain(reference.name || reference.url || "未提供地址")}`, "");
  }
  return lines.join("\n");
}
function writeProjection(actor: AIMemoryActor, row: Conversation, source: ReturnType<typeof getAIMemorySource>, forceCopy = false) {
  const db = getDb();
  let note = projection(row);
  if (row.noteId && !forceCopy && !untouched(row, source, note)) { query("UPDATE external_ai_conversations SET projectionStatus='conflict' WHERE id=?").run(row.id); return "conflict"; }
  if (!note || forceCopy) {
    const created = createKnowledgeChild({ actorUserId: actor.userId, workspaceId: null, parentId: `notebook:${source.notebookId}`, nodeType: "markdown", title: row.title, db });
    row.noteId = created.resourceId;
    note = projection(row)!;
  }
  const synced = syncNoteBlocks(db, note.id, markdown(row, messages(row.id)), "markdown");
  query("UPDATE notes SET title=?,content=?,contentText=?,contentFormat='markdown',version=version+1,updatedAt=? WHERE id=?")
    .run(row.title, synced.content, synced.contentText, now(), note.id);
  syncReferences(db, note.id, synced.content);
  syncNoteLinks(db, actor.userId, note.id, synced.content);
  rebuildBlockAuthorityStore(db, note.id, synced.content, "markdown", { noteVersion: note.version + 1, operationType: "update" });
  rebuildYjsSubdocumentsIfEnabled(db, note.id, synced.content, "markdown");
  query("UPDATE external_ai_conversations SET noteId=?,projectionHash=?,projectionStatus='updated' WHERE id=?")
    .run(note.id, projectionFingerprint({ title: row.title, content: synced.content, contentFormat: "markdown" }), row.id);
  return "updated";
}
function publish(actor: AIMemoryActor) { notifySyncChanged(getDb(), actor.userId); }
export function ingestAIConversation(actor: AIMemoryActor, input: unknown) {
  const request = z.object({ sourceId: id, operationId: z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/), expectedRevision: z.number().int().min(0).optional(), mode: z.enum(["manual", "automatic", "import"]).default("manual"), snapshot: aiConversationSnapshotSchema }).strict().parse(input);
  if (Buffer.byteLength(JSON.stringify(request.snapshot), "utf8") > AI_MEMORY_LIMITS.snapshotBytes) throw new AIMemoryError("AI_CAPTURE_TOO_LARGE", "对话批次超过 2MB，请分批保存", 413);
  const snapshot = { ...request.snapshot, sourceUrl: normalizedUrl(request.snapshot.sourceUrl) };
  const source = getAIMemorySource(actor, request.sourceId, true);
  if (source.permissionState !== "granted") throw new AIMemoryError("AI_SOURCE_NOT_AUTHORIZED", "此来源授权已撤销，请重新授权", 403);
  if (request.mode === "automatic" && !source.captureEnabled) throw new AIMemoryError("AI_CAPTURE_PAUSED", "此来源已暂停自动保存", 409);
  if (source.provider !== snapshot.provider || source.accountScope !== snapshot.accountScope) throw new AIMemoryError("AI_SOURCE_NOT_AUTHORIZED", "来源账号与当前授权不一致", 403);
  if (request.mode === "import") assertAIMemoryImportAccess(actor, source.id, true);
  const entries = snapshot.messages.filter((message) => message.captureState !== "streaming").sort((a, b) => a.localSequence - b.localSequence);
  if (!entries.length) throw new AIMemoryError("AI_MESSAGE_PARSE_FAILED", "尚无稳定消息可保存");
  const seen = new Set<string>(), sequences = new Set<number>(), occurrences = new Map<string, number>();
  const normalized = entries.map((message) => {
    const contentHash = digest([message.role, message.text, message.blocks]);
    const inferred = !message.externalMessageId || message.externalMessageId.startsWith("inferred:");
    const occurrence = occurrences.get(contentHash) || 0;
    occurrences.set(contentHash, occurrence + 1);
    const externalMessageId = inferred ? `inferred:${contentHash}:${occurrence}` : message.externalMessageId!;
    if (seen.has(externalMessageId) || sequences.has(message.localSequence)) throw new AIMemoryError("AI_MESSAGE_IDENTITY_AMBIGUOUS", "消息标识重复或顺序不明确，请检查对话后重试", 409);
    if (inferred && request.mode === "automatic") throw new AIMemoryError("AI_MESSAGE_IDENTITY_AMBIGUOUS", "网站未提供稳定消息标识，无法安全自动保存", 409);
    seen.add(externalMessageId); sequences.add(message.localSequence);
    return { ...message, externalMessageId, identityState: inferred ? "inferred" : "platform", contentHash };
  });
  const snapshotHash = digest([snapshot.title, snapshot.sourceUrl, snapshot.completeness, normalized.map((entry) => [entry.externalMessageId, entry.localSequence, entry.role, entry.blocks, entry.text, entry.captureState])]);
  const payloadHash = digest(request);
  const result = getDb().transaction(() => {
    // All access checks and persistence receipts share the archive/projection transaction.
    getAIMemorySource(actor, source.id, true);
    const previousOperation = query("SELECT payloadHash,resultJson,conversationId FROM ai_conversation_sync_operations WHERE userId=? AND sourceId=? AND operationId=?").get(actor.userId, source.id, request.operationId) as { payloadHash: string; resultJson: string; conversationId: string } | undefined;
    if (previousOperation) {
      if (previousOperation.payloadHash !== payloadHash) throw new AIMemoryError("AI_SYNC_OPERATION_CONFLICT", "同一操作标识不能用于不同内容", 409);
      const priorConversation = ownedConversation(actor, previousOperation.conversationId, true, true);
      if (priorConversation.deletedAt) throw new AIMemoryError("AI_CONVERSATION_DELETED", "归档已删除，请先恢复或创建新的来源", 409);
      assertArchiveRead(actor, priorConversation);
      return { ...JSON.parse(previousOperation.resultJson), status: "duplicate" };
    }
    let row = query("SELECT * FROM external_ai_conversations WHERE userId=? AND sourceId=? AND externalConversationId=?").get(actor.userId, source.id, snapshot.externalConversationId) as Conversation | undefined;
    const timestamp = now();
    if (row?.deletedAt) throw new AIMemoryError("AI_CONVERSATION_DELETED", "归档已删除，请先恢复或创建新的来源", 409);
    if (row) assertArchiveRead(actor, row);
    const unchanged = row?.lastSnapshotHash === snapshotHash;
    if (row && !unchanged && request.expectedRevision !== row.revision) throw new AIMemoryError("AI_SYNC_VERSION_CONFLICT", "归档已更新，请检查最新版本后重试", 409, row.revision);
    if (!row && request.expectedRevision && request.expectedRevision !== 0) throw new AIMemoryError("AI_SYNC_VERSION_CONFLICT", "归档版本不匹配", 409, 0);
    if (row && !unchanged) {
      const oldEntries = messages(row.id);
      if (normalized.some((entry) => entry.identityState === "inferred") || oldEntries.some((entry) => entry.identityState === "inferred")) throw new AIMemoryError("AI_MESSAGE_IDENTITY_AMBIGUOUS", "此归档缺少稳定消息标识，无法安全更新；请保存为新的会话", 409);
      const positions = new Map(oldEntries.map((entry, index) => [entry.externalMessageId, index]));
      let lastPosition = -1, sawNew = false;
      for (const entry of normalized) {
        const position = positions.get(entry.externalMessageId);
        if (position === undefined) { sawNew = true; continue; }
        if (sawNew || position <= lastPosition) throw new AIMemoryError("AI_MESSAGE_ORDER_CONFLICT", "检测到历史补载或对话分支变化，请检查归档并另存新的会话", 409);
        lastPosition = position;
      }
      if (sawNew && lastPosition !== oldEntries.length - 1) throw new AIMemoryError("AI_MESSAGE_ORDER_CONFLICT", "新消息缺少末尾衔接标识，无法确认顺序；请加载更多历史消息后重试", 409);
    }
    if (!row) {
      const conversationId = crypto.randomUUID();
      query("INSERT INTO external_ai_conversations(id,userId,sourceId,externalConversationId,title,sourceUrl,completeness,contentHash,lastSnapshotHash,lastSyncedAt,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(conversationId, actor.userId, source.id, snapshot.externalConversationId, snapshot.title, snapshot.sourceUrl, snapshot.completeness, "", snapshotHash, timestamp, timestamp, timestamp);
      row = ownedConversation(actor, conversationId, true);
    }
    if (!unchanged) {
      const existing = new Map(messages(row.id).map((entry) => [entry.externalMessageId, entry]));
      let nextSequence = Math.max(-1, ...Array.from(existing.values(), (entry) => entry.sequence)) + 1;
      for (const entry of normalized) {
        const current = existing.get(entry.externalMessageId);
        if (current && current.contentHash === entry.contentHash && current.captureState === entry.captureState) continue;
        if (current) {
          query("INSERT INTO external_ai_message_revisions(messageId,revision,blocksJson,contentText,role,contentHash,createdAt) VALUES (?,?,?,?,?,?,?)")
            .run(current.id, current.revision, current.blocksJson, current.contentText, current.role, current.contentHash, timestamp);
          query("UPDATE external_ai_messages SET role=?,blocksJson=?,contentText=?,contentHash=?,captureState=?,revision=revision+1,updatedAt=? WHERE id=?")
            .run(entry.role, JSON.stringify(entry.blocks), entry.text, entry.contentHash, entry.captureState, entry.updatedAt || timestamp, current.id);
        } else {
          query("INSERT INTO external_ai_messages(id,userId,conversationId,externalMessageId,identityState,sequence,role,blocksJson,contentText,contentHash,captureState,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(crypto.randomUUID(), actor.userId, row.id, entry.externalMessageId, entry.identityState, nextSequence++, entry.role, JSON.stringify(entry.blocks), entry.text, entry.contentHash, entry.captureState, entry.createdAt || timestamp, entry.updatedAt || timestamp);
        }
      }
      // Missing messages are not deletion instructions, even in a claimed complete snapshot.
      const size = query("SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(CAST(contentText AS BLOB))+LENGTH(CAST(blocksJson AS BLOB))),0) AS bytes FROM external_ai_messages WHERE conversationId=?").get(row.id) as { count: number; bytes: number };
      if (size.count > AI_MEMORY_LIMITS.conversationMessages || size.bytes > AI_MEMORY_LIMITS.conversationBytes) throw new AIMemoryError("AI_CAPTURE_TOO_LARGE", "单篇归档超过 10000 条消息或 16MB，请另建会话保存", 413);
      const contentHash = digest(messages(row.id).map((entry) => [entry.externalMessageId, entry.contentHash]));
      const revision = existing.size ? row.revision + 1 : row.revision;
      const completeness = snapshot.messages.length !== entries.length || Array.from(existing.keys()).some((key) => !seen.has(key)) ? "partial" : snapshot.completeness;
      query("UPDATE external_ai_conversations SET title=?,sourceUrl=?,completeness=?,contentHash=?,lastSnapshotHash=?,revision=?,lastSyncedAt=?,updatedAt=? WHERE id=?")
        .run(snapshot.title, snapshot.sourceUrl, completeness, contentHash, snapshotHash, revision, timestamp, timestamp, row.id);
      row = ownedConversation(actor, row.id, true);
      writeProjection(actor, row, source);
    }
    const saved = ownedConversation(actor, row.id, true);
    const receipt = { operationId: request.operationId, sourceId: source.id, conversationId: saved.id, noteId: saved.noteId, revision: saved.revision, status: unchanged ? "duplicate" : "applied", persisted: true, persistedAt: timestamp, completeness: saved.completeness, projectionStatus: saved.projectionStatus };
    query("UPDATE external_ai_sources SET lastSyncedAt=?,updatedAt=? WHERE id=?").run(timestamp, timestamp, source.id);
    query("INSERT INTO ai_conversation_sync_operations(id,userId,sourceId,conversationId,operationId,payloadHash,status,resultJson,createdAt) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), actor.userId, source.id, saved.id, request.operationId, payloadHash, receipt.status, JSON.stringify(receipt), timestamp);
    return receipt;
  })();
  publish(actor);
  return result;
}

export function rebuildAIConversationNote(actor: AIMemoryActor, conversationId: string) {
  const result = getDb().transaction(() => {
    const row = ownedConversation(actor, conversationId, true), source = getAIMemorySource(actor, row.sourceId, true);
    assertArchiveRead(actor, row);
    // Rebuild means create a new projection. The previous note and user edits remain intact.
    writeProjection(actor, row, source, true);
    return { conversationId, noteId: row.noteId, projectionStatus: "updated" };
  })();
  publish(actor); return result;
}
export function deleteAIConversation(actor: AIMemoryActor, conversationId: string) {
  const result = getDb().transaction(() => {
    const row = ownedConversation(actor, conversationId, true), source = getAIMemorySource(actor, row.sourceId, true), note = projection(row);
    let projectionPreserved = true;
    if (untouched(row, source, note)) {
      deleteKnowledgeNode({ actorUserId: actor.userId, nodeId: `note:${note!.id}`, mode: "subtree", db: getDb() });
      projectionPreserved = false;
    }
    query("UPDATE external_ai_conversations SET deletedAt=?,updatedAt=? WHERE id=?").run(now(), now(), row.id);
    return { success: true, conversationId, projectionPreserved, thirdPartyOriginalDeleted: false };
  })();
  publish(actor); return result;
}
export function restoreAIConversation(actor: AIMemoryActor, conversationId: string) {
  const result = getDb().transaction(() => {
    const row = ownedConversation(actor, conversationId, true, true), source = getAIMemorySource(actor, row.sourceId, true), note = projection(row);
    if (note?.isTrashed && note.userId === actor.userId && !note.workspaceId && note.notebookId === source.notebookId && projectionFingerprint(note) === row.projectionHash) restoreKnowledgeNode({ actorUserId: actor.userId, nodeId: `note:${note.id}`, includeSubtree: false, db: getDb() });
    query("UPDATE external_ai_conversations SET deletedAt=NULL,updatedAt=? WHERE id=?").run(now(), row.id);
    return { success: true, conversationId };
  })();
  publish(actor); return result;
}
