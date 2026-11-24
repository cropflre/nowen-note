import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { extractArchive, MigrationSourceError } from "../services/migrationSourceAdapter";
import { aiConversationSnapshotSchema, type AIConversationSnapshot } from "../services/aiMemoryService";

export const AI_IMPORT_LIMITS = { uploadBytes: 64 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024,
  jsonBytes: 32 * 1024 * 1024, conversationBytes: 2 * 1024 * 1024, conversations: 2000, messages: 1000 };
export class AIImportError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export type ImportedMessage = AIConversationSnapshot["messages"][number] & { externalMessageId: string };
export type ImportedSnapshot = Omit<AIConversationSnapshot, "provider" | "messages"> & { provider: string; messages: ImportedMessage[] };
export type ImportParseReport = { accepted: number; skipped: number; warnings: string[] };
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function warn(report: ImportParseReport, message: string): void { if (report.warnings.length < 100) report.warnings.push(message); }
function textFile(filename: string, bytes: number): string {
  if (fs.statSync(filename).size > bytes) throw new AIImportError("AI_IMPORT_FILE_LIMIT", "单个 JSON 文件超过 32MB，请使用分卷导出");
  try { return new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(filename)).replace(/^\uFEFF/, ""); }
  catch { throw new AIImportError("AI_IMPORT_INVALID_UTF8", "文件必须使用 UTF-8 编码"); }
}
function message(id: string, role: unknown, text: string, index: number, partial = false): ImportedMessage {
  return { externalMessageId: id, localSequence: index,
    role: ["user", "assistant", "system", "tool"].includes(String(role)) ? role as ImportedMessage["role"] : "unknown",
    blocks: [{ type: "markdown", text }], text, contentHash: hash(text), captureState: partial ? "partial" : "stable" };
}
function chatgpt(value: Record<string, any>, source: { provider: string; accountScope: string }, report: ImportParseReport): ImportedSnapshot | null {
  if (source.provider !== "chatgpt") throw new AIImportError("AI_IMPORT_SOURCE_MISMATCH", "ChatGPT 导出文件需要选择 ChatGPT 来源");
  const id = value.conversation_id || value.id;
  if (typeof id !== "string" || !id || id.length > 200 || !object(value.mapping)) return null;
  const nodes = value.mapping as Record<string, any>, selected: any[] = [], seen = new Set<string>();
  let partial = false, cursor = typeof value.current_node === "string" ? value.current_node : "";
  if (!cursor || !nodes[cursor]) {
    const leaves = Object.keys(nodes).filter(key => object(nodes[key]) && (!Array.isArray(nodes[key].children) || !nodes[key].children.length));
    if (leaves.length !== 1) { warn(report, `${id}: 无法确定会话分支，已跳过`); return null; }
    cursor = leaves[0]; partial = true;
  }
  while (cursor) {
    if (seen.has(cursor) || !object(nodes[cursor]) || seen.size > 10_000) { partial = true; break; }
    seen.add(cursor); const node = nodes[cursor]; selected.unshift({ ...node, captureNodeId: cursor });
    if (node.parent != null && typeof node.parent !== "string") { partial = true; break; }
    cursor = node.parent || "";
  }
  const otherBranches = Object.keys(nodes).filter(key => !seen.has(key) && object(nodes[key]?.message)).length;
  if (otherBranches) { partial = true; warn(report, `${id}: 已导入所选分支，另有 ${otherBranches} 条分支消息未纳入`); }
  const messages: ImportedMessage[] = [];
  for (const node of selected) {
    if (!object(node.message)) continue;
    const raw = node.message, content = raw.content;
    if (!object(content)) { partial = true; continue; }
    const parts = Array.isArray(content.parts) ? content.parts : typeof content.text === "string" ? [content.text] : [];
    let text = parts.filter((part: unknown) => typeof part === "string").join("\n");
    if (content.content_type === "code") {
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
      text = `${fence}${typeof content.language === "string" ? content.language.replace(/[^a-z0-9_+-]/gi, "") : ""}\n${text}\n${fence}`;
    }
    const missing = parts.some((part: unknown) => typeof part !== "string") || (Array.isArray(raw.metadata?.attachments) && raw.metadata.attachments.length > 0)
      || !["text", "code", "multimodal_text"].includes(content.content_type);
    if (missing) { partial = true; warn(report, `${id}: 图片、附件或非文本内容仅保留缺失提示`); }
    const body = text + (missing ? "\n\n[未导入的图片、附件或非文本内容]" : "");
    if (!body) continue;
    const incomplete = raw.status && raw.status !== "finished_successfully";
    partial ||= Boolean(incomplete);
    const messageId = String(raw.id || node.id || node.captureNodeId);
    if (messageId.length > 200) { warn(report, `${id}: 消息标识过长，已跳过此会话`); return null; }
    messages.push(message(messageId, raw.author?.role, body, messages.length, Boolean(missing || incomplete)));
  }
  if (!messages.length) return null;
  return { provider: source.provider, accountScope: source.accountScope, externalConversationId: id,
    title: String(value.title || "ChatGPT 对话").slice(0, 500), sourceUrl: `https://chatgpt.com/c/${encodeURIComponent(id)}`,
    messages, completeness: partial ? "partial" : "unknown", capturedAt: new Date().toISOString() };
}
function standard(value: Record<string, any>, source: { provider: string; accountScope: string }): ImportedSnapshot | null {
  if (typeof value.externalConversationId !== "string" || !value.externalConversationId || value.externalConversationId.length > 200 || !Array.isArray(value.messages)) return null;
  const messages = value.messages.map((entry: unknown, index: number) => {
    if (!object(entry) || typeof entry.text !== "string" || typeof entry.externalMessageId !== "string" || !entry.externalMessageId || entry.externalMessageId.length > 200) return null;
    return message(entry.externalMessageId, entry.role, entry.text, index);
  });
  if (messages.some(entry => !entry) || !messages.length) return null;
  return { provider: source.provider, accountScope: source.accountScope, externalConversationId: value.externalConversationId,
    title: String(value.title || "导入的 AI 对话").slice(0, 500), sourceUrl: "", messages: messages as ImportedMessage[], completeness: "unknown", capturedAt: new Date().toISOString() };
}
function nativeConversation(value: Record<string, any>, source: { provider: string; accountScope: string }, report: ImportParseReport): ImportedSnapshot {
  if (value.format !== "nowen-ai-conversation" || value.schemaVersion !== 1) throw new AIImportError("AI_IMPORT_FORMAT_UNSUPPORTED", "不支持此 Nowen 原始会话格式版本，请使用兼容的导出文件");
  const { format, schemaVersion, ...input } = value;
  const parsed = aiConversationSnapshotSchema.safeParse(input);
  if (!parsed.success || parsed.data.messages.some(entry => !entry.externalMessageId)) throw new AIImportError("AI_IMPORT_INVALID_TRANSCRIPT", "Nowen 原始会话结构无效或超出导入限制");
  const snapshot = parsed.data;
  if (snapshot.provider !== source.provider) throw new AIImportError("AI_IMPORT_SOURCE_MISMATCH", "导出平台与所选来源不一致，请选择匹配的平台来源");
  if (snapshot.accountScope !== source.accountScope) warn(report, `原始来源账号标识 ${snapshot.accountScope}；将按你选择的来源 ${source.accountScope} 导入`);
  return { ...snapshot, accountScope: source.accountScope, messages: snapshot.messages as ImportedMessage[] };
}

/** ZIP bytes are expanded to a private directory with the existing migration traversal/size guards. */
export async function parseAIImport(input: { filePath: string; filename: string; directory: string; source: { provider: string; accountScope: string };
  onSnapshot: (snapshot: ImportedSnapshot) => Promise<void>; assertActive?: () => void }): Promise<ImportParseReport> {
  const report: ImportParseReport = { accepted: 0, skipped: 0, warnings: [] };
  if (fs.statSync(input.filePath).size > AI_IMPORT_LIMITS.uploadBytes) throw new AIImportError("AI_IMPORT_UPLOAD_LIMIT", "导入文件不能超过 64MB", 413);
  const isZip = /\.zip$/i.test(input.filename);
  let files: Array<{ filename: string; diskPath: string }>;
  try {
    if (isZip) {
      const entries = await extractArchive(input.filePath, path.join(input.directory, "expanded"), AI_IMPORT_LIMITS.expandedBytes, input.assertActive);
      files = [...entries].filter(([name]) => /(?:^|\/)conversations(?:[ _-]?\d+)?\.json$/i.test(name)).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
        .map(([filename, file]) => ({ filename, diskPath: file.diskPath }));
      if (!files.length) throw new AIImportError("AI_IMPORT_FORMAT_UNSUPPORTED", "ZIP 中未找到 conversations.json 或分卷 JSON");
      warn(report, "仅解析 conversations JSON；ZIP 内附件和其他文件不会保存为附件");
    } else files = [{ filename: input.filename, diskPath: input.filePath }];
  } catch (error) {
    if (error instanceof MigrationSourceError) throw new AIImportError("AI_IMPORT_UNSAFE_ZIP", "ZIP 文件无效、包含不安全路径或超过解压限制");
    throw error;
  }
  const identities = new Map<string, string>();
  for (const file of files) {
    input.assertActive?.();
    const text = textFile(file.diskPath, AI_IMPORT_LIMITS.jsonBytes);
    let records: unknown[];
    if (/\.(md|markdown|txt)$/i.test(file.filename)) {
      const snapshot: ImportedSnapshot = { provider: input.source.provider, accountScope: input.source.accountScope,
        externalConversationId: `file:${hash(text)}`, title: path.basename(file.filename).slice(0, 500), sourceUrl: "",
        messages: [message(`text:${hash(text)}`, "unknown", text, 0)], completeness: "unknown", capturedAt: new Date().toISOString() };
      records = [snapshot];
      warn(report, "Markdown/TXT 作为一条原始文本导入，未推断说话人或完整性");
    } else if (/\.json$/i.test(file.filename)) {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new AIImportError("AI_IMPORT_INVALID_JSON", "JSON 格式无效，请重新导出"); }
      records = Array.isArray(parsed) ? parsed : object(parsed) && Array.isArray(parsed.conversations) ? parsed.conversations : [parsed];
    } else throw new AIImportError("AI_IMPORT_FORMAT_UNSUPPORTED", "支持 ChatGPT ZIP、JSON、Markdown 和 TXT 文件");
    if (records.length + report.accepted + report.skipped > AI_IMPORT_LIMITS.conversations) throw new AIImportError("AI_IMPORT_RECORD_LIMIT", "单次最多导入 2000 个会话，请分批导入");
    for (const value of records) {
      input.assertActive?.();
      const snapshot = object(value) ? ("format" in value || "schemaVersion" in value) ? nativeConversation(value, input.source, report)
        : object(value.mapping) ? chatgpt(value, input.source, report) : standard(value, input.source) : null;
      if (!snapshot || snapshot.messages.length > AI_IMPORT_LIMITS.messages || Buffer.byteLength(JSON.stringify(snapshot)) > AI_IMPORT_LIMITS.conversationBytes
        || snapshot.messages.some(entry => Buffer.byteLength(entry.text) > 256 * 1024)) {
        report.skipped++; warn(report, "一条无效、空白或过大的会话已跳过（单会话最多 1000 条 / 2MB，单消息最多 256KB）"); continue;
      }
      const identityHash = hash(JSON.stringify([snapshot.title, snapshot.sourceUrl, snapshot.messages, snapshot.completeness]));
      if (identities.has(snapshot.externalConversationId)) {
        if (identities.get(snapshot.externalConversationId) !== identityHash) throw new AIImportError("AI_IMPORT_DUPLICATE_CONFLICT", "分卷中同一会话包含不同内容，请先选择正确版本后重新导入");
        report.skipped++; warn(report, "分卷中内容相同的重复会话已跳过"); continue;
      }
      identities.set(snapshot.externalConversationId, identityHash);
      await input.onSnapshot(snapshot); report.accepted++;
    }
  }
  if (!report.accepted) throw new AIImportError("AI_IMPORT_NO_CONVERSATIONS", "未找到可导入的有效会话");
  return report;
}
