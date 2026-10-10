import { getDb } from "../../db/schema.js";
import { syncReferences } from "../../lib/attachmentRefs.js";
import { rebuildBlockAuthorityStore } from "../../lib/blockAuthorityStore.js";
import { syncNoteBlocks } from "../../lib/noteBlocks.js";
import { syncNoteLinks } from "../../lib/noteLinks.js";
import { getUserWorkspaceRole, isSystemAdmin } from "../../middleware/acl.js";
import { createKnowledgeChild, type KnowledgeTreeNode } from "../../services/knowledgeTree.js";
import { rebuildYjsSubdocumentsIfEnabled } from "../../services/yjs-subdocuments.js";
import type { PluginNoteTemplateContribution, PluginStaticInputField } from "../types.js";

export class PluginNoteTemplateError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "PluginNoteTemplateError"; }
}

function workspaceId(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return !normalized || normalized === "personal" || normalized === "null" ? null : normalized;
}
function requireWorkspace(userId: string, id: string | null) {
  if (!id || isSystemAdmin(userId) || getUserWorkspaceRole(id, userId)) return;
  throw new PluginNoteTemplateError("PLUGIN_TEMPLATE_WORKSPACE_FORBIDDEN", "无权在该工作区使用插件模板");
}
function valuesFor(fields: PluginStaticInputField[] | undefined, input: Record<string, unknown>) {
  const values: Record<string, string | number | boolean> = {};
  for (const field of fields || []) {
    const value = input[field.id] ?? field.default;
    if (value === undefined || value === null || value === "") {
      if (field.required) throw new PluginNoteTemplateError("PLUGIN_TEMPLATE_VARIABLE_REQUIRED", `缺少模板变量: ${field.id}`);
      values[field.id] = "";
      continue;
    }
    if (typeof value !== field.type) throw new PluginNoteTemplateError("PLUGIN_TEMPLATE_VARIABLE_INVALID", `模板变量类型错误: ${field.id}`);
    values[field.id] = value as string | number | boolean;
  }
  return values;
}
function renderText(source: string, values: Record<string, string | number | boolean>): string {
  return source.replace(/\{\{\s*([a-z][a-z0-9_-]{0,63})\s*\}\}/gi, (_all, key: string) => key in values ? String(values[key]) : `{{${key}}}`);
}
function renderBody(template: PluginNoteTemplateContribution, input: Record<string, unknown>): { content: string; contentText: string } {
  const values = valuesFor(template.variables, input);
  if (template.contentFormat === "markdown") {
    const content = renderText(template.body, values);
    return { content, contentText: content };
  }
  let document: unknown;
  try { document = JSON.parse(template.body); } catch { throw new PluginNoteTemplateError("PLUGIN_TEMPLATE_BODY_INVALID", "富文本模板 JSON 无效"); }
  const textParts: string[] = [];
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "text" && typeof value === "string") { const text = renderText(value, values); output[key] = text; textParts.push(text); }
      else output[key] = visit(value);
    }
    return output;
  };
  const rendered = visit(document);
  return { content: JSON.stringify(rendered), contentText: textParts.join(" ") };
}

export function createNoteFromPluginTemplate(input: {
  userId: string; workspaceId?: string | null; parentId: string | null; template: PluginNoteTemplateContribution; values?: Record<string, unknown>;
}): { noteId: string; node: KnowledgeTreeNode } {
  const db = getDb();
  const scope = workspaceId(input.workspaceId);
  requireWorkspace(input.userId, scope);
  if (input.parentId) {
    const parent = db.prepare("SELECT workspaceId FROM knowledge_tree_nodes WHERE id=? AND isDeleted=0").get(input.parentId) as { workspaceId: string | null } | undefined;
    if (!parent) throw new PluginNoteTemplateError("PLUGIN_TEMPLATE_PARENT_NOT_FOUND", "目标目录不存在");
    if (workspaceId(parent.workspaceId) !== scope) throw new PluginNoteTemplateError("PLUGIN_TEMPLATE_SCOPE_MISMATCH", "模板与目标目录不在同一空间");
  }
  const rendered = renderBody(input.template, input.values || {});
  const node = db.transaction(() => {
    const created = createKnowledgeChild({ actorUserId: input.userId, workspaceId: scope, parentId: input.parentId, nodeType: input.template.contentFormat === "markdown" ? "markdown" : "note", title: input.template.name, db });
    const note = db.prepare("SELECT version FROM notes WHERE id=?").get(created.resourceId) as { version: number } | undefined;
    if (!note) throw new PluginNoteTemplateError("PLUGIN_TEMPLATE_NOTE_CREATE_FAILED", "模板笔记创建失败");
    const synced = syncNoteBlocks(db, created.resourceId, rendered.content, input.template.contentFormat);
    db.prepare("UPDATE notes SET content=?,contentText=?,contentFormat=?,updatedAt=datetime('now') WHERE id=?").run(synced.content, rendered.contentText, input.template.contentFormat, created.resourceId);
    syncReferences(db, created.resourceId, synced.content);
    syncNoteLinks(db, input.userId, created.resourceId, synced.content);
    rebuildBlockAuthorityStore(db, created.resourceId, synced.content, input.template.contentFormat, { noteVersion: note.version, operationType: "create" });
    rebuildYjsSubdocumentsIfEnabled(db, created.resourceId, synced.content, input.template.contentFormat);
    return created;
  })();
  return { noteId: node.resourceId, node };
}
