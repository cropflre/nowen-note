import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { getDb } from "../db/schema.js";
import {
  getUserWorkspaceRole,
  hasPermission,
  hasRole,
  canManageResource,
  resolveNotePermission,
  resolveNotebookPermission,
} from "../middleware/acl.js";
import { ensureMindmapSchema } from "../lib/mindmap-schema.js";
import { PluginPermissions } from "./permissions.js";
import { PluginSecrets } from "./secrets.js";
import type { HostCall, PluginExecutionContext, PluginPermission } from "./types.js";

type JsonObject = Record<string, any>;

function forbidden(message: string, code = "RESOURCE_FORBIDDEN"): never {
  throw Object.assign(new Error(message), { code });
}

function argsObject(args: unknown): JsonObject {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Host API 参数必须是对象");
  return args as JsonObject;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value;
}

function allowedWorkspace(workspaceId: string | null, userId: string, write = false): boolean {
  if (!workspaceId) return true;
  const role = getUserWorkspaceRole(workspaceId, userId);
  return write ? hasRole(role, "editor") : role !== null;
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const lower = address.toLowerCase();
  return lower === "::1" || lower === "::" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

async function assertPublicHost(hostname: string): Promise<void> {
  if (hostname === "localhost" || net.isIP(hostname) && isPrivateAddress(hostname)) forbidden("禁止访问本机或私有网络", "EXTERNAL_FETCH_DENIED");
  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some((item) => isPrivateAddress(item.address))) {
    forbidden("目标解析到私有网络", "EXTERNAL_FETCH_DENIED");
  }
}

export class HostApiBroker {
  constructor(
    private readonly permissions = new PluginPermissions(),
    private readonly secrets = new PluginSecrets(),
  ) {}

  async call(context: PluginExecutionContext, call: HostCall): Promise<unknown> {
    const [namespace, operation] = call.method.split(".");
    const args = argsObject(call.args || {});
    switch (namespace) {
      case "notes": return this.notes(context, operation, args);
      case "notebooks": return this.notebooks(context, operation, args);
      case "tags": return this.tags(context, operation, args);
      case "tasks": return this.tasks(context, operation, args);
      case "attachments": return this.attachments(context, operation, args);
      case "diary": return this.diary(context, operation, args);
      case "mindmaps": return this.mindmaps(context, operation, args);
      case "storage": return this.storage(context, operation, args);
      case "external": return this.external(context, operation, args);
      default: throw Object.assign(new Error(`未知 Host API: ${call.method}`), { code: "HOST_METHOD_NOT_FOUND" });
    }
  }

  private require(context: PluginExecutionContext, permission: PluginPermission): void {
    this.permissions.require(context.pluginId, permission);
  }

  private notes(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    if (operation === "get") {
      this.require(context, "notes:read");
      const id = requireString(args.id ?? args.noteId, "noteId");
      if (!hasPermission(resolveNotePermission(id, context.userId).permission, "read")) forbidden("无权读取该笔记");
      return db.prepare("SELECT id, notebookId, title, content, contentText, contentFormat, workspaceId, version, createdAt, updatedAt FROM notes WHERE id=? AND isTrashed=0").get(id) || null;
    }
    if (operation === "list") {
      this.require(context, "notes:read");
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));
      const rows = db.prepare("SELECT id, notebookId, title, contentText, contentFormat, workspaceId, version, createdAt, updatedAt FROM notes WHERE isTrashed=0 ORDER BY updatedAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => hasPermission(resolveNotePermission(row.id, context.userId).permission, "read")).slice(0, limit);
    }
    if (operation === "create") {
      this.require(context, "notes:write");
      const notebookId = requireString(args.notebookId, "notebookId");
      const access = resolveNotebookPermission(notebookId, context.userId);
      if (!hasPermission(access.permission, "write")) forbidden("无权在该笔记本创建笔记");
      const id = crypto.randomUUID();
      const content = typeof args.content === "string" ? args.content : "";
      db.prepare(`INSERT INTO notes (id,userId,notebookId,title,content,contentText,contentFormat,workspaceId,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, context.userId, notebookId, String(args.title || "无标题笔记"), content, String(args.contentText ?? content), String(args.contentFormat || "markdown"), access.workspaceId, new Date().toISOString(), new Date().toISOString());
      return { id };
    }
    if (operation === "update") {
      this.require(context, "notes:write");
      const id = requireString(args.id ?? args.noteId, "noteId");
      if (!hasPermission(resolveNotePermission(id, context.userId).permission, "write")) forbidden("无权修改该笔记");
      const current = db.prepare("SELECT title,content,contentText,contentFormat,version FROM notes WHERE id=?").get(id) as JsonObject | undefined;
      if (!current) throw new Error("笔记不存在");
      db.prepare("UPDATE notes SET title=?,content=?,contentText=?,contentFormat=?,version=version+1,updatedAt=? WHERE id=?")
        .run(args.title ?? current.title, args.content ?? current.content, args.contentText ?? current.contentText, args.contentFormat ?? current.contentFormat, new Date().toISOString(), id);
      return { id, version: Number(current.version || 0) + 1 };
    }
    throw new Error(`未知 notes 操作: ${operation}`);
  }

  private notebooks(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    if (operation === "get") {
      this.require(context, "notebooks:read");
      const id = requireString(args.id ?? args.notebookId, "notebookId");
      if (!hasPermission(resolveNotebookPermission(id, context.userId).permission, "read")) forbidden("无权读取该笔记本");
      return db.prepare("SELECT id,parentId,name,description,icon,color,workspaceId,createdAt,updatedAt FROM notebooks WHERE id=? AND isDeleted=0").get(id) || null;
    }
    if (operation === "list") {
      this.require(context, "notebooks:read");
      const rows = db.prepare("SELECT id,parentId,name,description,icon,color,workspaceId,createdAt,updatedAt FROM notebooks WHERE isDeleted=0 ORDER BY sortOrder,name").all() as JsonObject[];
      return rows.filter((row) => hasPermission(resolveNotebookPermission(row.id, context.userId).permission, "read"));
    }
    if (operation === "create") {
      this.require(context, "notebooks:write");
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId, true)) forbidden("无权在该工作区创建笔记本");
      if (args.parentId && !hasPermission(resolveNotebookPermission(String(args.parentId), context.userId).permission, "write")) forbidden("无权使用该父笔记本");
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO notebooks (id,userId,parentId,name,description,icon,color,workspaceId,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, context.userId, args.parentId || null, requireString(args.name, "name"), String(args.description || ""), String(args.icon || "📒"), args.color || null, workspaceId, new Date().toISOString(), new Date().toISOString());
      return { id };
    }
    throw new Error(`未知 notebooks 操作: ${operation}`);
  }

  private tags(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    if (operation === "list") {
      this.require(context, "tags:read");
      const rows = db.prepare("SELECT id,name,color,workspaceId,createdAt FROM tags WHERE userId=? OR workspaceId IS NOT NULL ORDER BY name").all(context.userId) as JsonObject[];
      return rows.filter((row) => !row.workspaceId || allowedWorkspace(row.workspaceId, context.userId));
    }
    if (operation === "create") {
      this.require(context, "tags:write");
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId, true)) forbidden("无权在该工作区创建标签");
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO tags (id,userId,name,color,workspaceId,createdAt) VALUES (?,?,?,?,?,?)")
        .run(id, context.userId, requireString(args.name, "name"), String(args.color || "#58a6ff"), workspaceId, new Date().toISOString());
      return { id };
    }
    if (operation === "addToNote" || operation === "removeFromNote") {
      this.require(context, "tags:write");
      const noteId = requireString(args.noteId, "noteId");
      const tagId = requireString(args.tagId, "tagId");
      if (!hasPermission(resolveNotePermission(noteId, context.userId).permission, "write")) forbidden("无权修改该笔记标签");
      if (operation === "addToNote") db.prepare("INSERT OR IGNORE INTO note_tags(noteId,tagId) VALUES (?,?)").run(noteId, tagId);
      else db.prepare("DELETE FROM note_tags WHERE noteId=? AND tagId=?").run(noteId, tagId);
      return { success: true };
    }
    throw new Error(`未知 tags 操作: ${operation}`);
  }

  private tasks(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    if (operation === "get") {
      this.require(context, "tasks:read");
      const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(requireString(args.id ?? args.taskId, "taskId")) as JsonObject | undefined;
      if (!row || (row.userId !== context.userId && !allowedWorkspace(row.workspaceId, context.userId))) forbidden("无权读取该任务");
      return row;
    }
    if (operation === "list") {
      this.require(context, "tasks:read");
      const rows = db.prepare("SELECT * FROM tasks ORDER BY updatedAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => row.userId === context.userId || allowedWorkspace(row.workspaceId, context.userId)).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 50)));
    }
    if (operation === "create") {
      this.require(context, "tasks:write");
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId, true)) forbidden("无权在该工作区创建任务");
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO tasks (id,userId,title,isCompleted,priority,dueDate,noteId,workspaceId,createdAt,updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, context.userId, requireString(args.title, "title"), 0, Number(args.priority) || 2, args.dueDate || null, args.noteId || null, workspaceId, new Date().toISOString(), new Date().toISOString());
      return { id };
    }
    if (operation === "update") {
      this.require(context, "tasks:write");
      const id = requireString(args.id ?? args.taskId, "taskId");
      const current = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as JsonObject | undefined;
      if (!current || (current.userId !== context.userId && !allowedWorkspace(current.workspaceId, context.userId, true))) forbidden("无权修改该任务");
      db.prepare("UPDATE tasks SET title=?,isCompleted=?,priority=?,dueDate=?,updatedAt=? WHERE id=?")
        .run(args.title ?? current.title, args.isCompleted === undefined ? current.isCompleted : (args.isCompleted ? 1 : 0), args.priority ?? current.priority, args.dueDate ?? current.dueDate, new Date().toISOString(), id);
      return { id };
    }
    throw new Error(`未知 tasks 操作: ${operation}`);
  }

  private attachments(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    this.require(context, "attachments:read");
    if (operation === "get") {
      const row = db.prepare("SELECT id,noteId,filename,mimeType,size,createdAt FROM attachments WHERE id=?").get(requireString(args.id ?? args.attachmentId, "attachmentId")) as JsonObject | undefined;
      if (!row || !hasPermission(resolveNotePermission(row.noteId, context.userId).permission, "read")) forbidden("无权读取该附件");
      return row;
    }
    if (operation === "list") {
      const rows = db.prepare("SELECT id,noteId,filename,mimeType,size,createdAt FROM attachments ORDER BY createdAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => hasPermission(resolveNotePermission(row.noteId, context.userId).permission, "read")).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 50)));
    }
    throw new Error(`未知 attachments 操作: ${operation}`);
  }

  private diary(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    if (operation === "get") {
      this.require(context, "diary:read");
      const row = db.prepare("SELECT id,userId,workspaceId,contentText,mood,images,media,createdAt FROM diaries WHERE id=?")
        .get(requireString(args.id ?? args.diaryId, "diaryId")) as JsonObject | undefined;
      if (!row || (row.userId !== context.userId && !allowedWorkspace(row.workspaceId, context.userId))) forbidden("无权读取该日记");
      return row;
    }
    if (operation === "list") {
      this.require(context, "diary:read");
      const rows = db.prepare("SELECT id,userId,workspaceId,contentText,mood,images,media,createdAt FROM diaries ORDER BY createdAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => row.userId === context.userId || allowedWorkspace(row.workspaceId, context.userId)).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 50)));
    }
    if (operation === "create") {
      this.require(context, "diary:write");
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId)) forbidden("无权在该工作区创建日记");
      const id = crypto.randomUUID();
      db.prepare("INSERT INTO diaries(id,userId,workspaceId,contentText,mood,images,media,createdAt) VALUES (?,?,?,?,?,'[]','[]',?)")
        .run(id, context.userId, workspaceId, String(args.contentText || ""), String(args.mood || ""), new Date().toISOString());
      return { id };
    }
    throw new Error(`未知 diary 操作: ${operation}`);
  }

  private mindmaps(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    ensureMindmapSchema();
    const db = getDb();
    if (operation === "get") {
      this.require(context, "mindmaps:read");
      const row = db.prepare("SELECT * FROM mindmaps WHERE id=?").get(requireString(args.id ?? args.mindmapId, "mindmapId")) as JsonObject | undefined;
      if (!row || (row.userId !== context.userId && !allowedWorkspace(row.workspaceId, context.userId))) forbidden("无权读取该思维导图");
      return row;
    }
    if (operation === "list") {
      this.require(context, "mindmaps:read");
      const rows = db.prepare("SELECT id,userId,workspaceId,title,starred,folderId,createdAt,updatedAt FROM mindmaps ORDER BY updatedAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => row.userId === context.userId || allowedWorkspace(row.workspaceId, context.userId)).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 50)));
    }
    if (operation === "create") {
      this.require(context, "mindmaps:write");
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId)) forbidden("无权在该工作区创建思维导图");
      const id = crypto.randomUUID();
      const title = String(args.title || "无标题导图");
      const data = args.data ?? { root: { id: "root", text: title, children: [] } };
      db.prepare("INSERT INTO mindmaps(id,userId,workspaceId,title,data) VALUES (?,?,?,?,?)")
        .run(id, context.userId, workspaceId, title, typeof data === "string" ? data : JSON.stringify(data));
      return { id };
    }
    if (operation === "update") {
      this.require(context, "mindmaps:write");
      const id = requireString(args.id ?? args.mindmapId, "mindmapId");
      const row = db.prepare("SELECT * FROM mindmaps WHERE id=?").get(id) as JsonObject | undefined;
      if (!row || !canManageResource(row.userId, row.workspaceId, context.userId)) forbidden("无权修改该思维导图");
      db.prepare("UPDATE mindmaps SET title=?,data=?,updatedAt=? WHERE id=?")
        .run(args.title ?? row.title, args.data === undefined ? row.data : (typeof args.data === "string" ? args.data : JSON.stringify(args.data)), new Date().toISOString(), id);
      return { id };
    }
    throw new Error(`未知 mindmaps 操作: ${operation}`);
  }

  private storage(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    const scopeType = args.scopeType === "workspace" ? "workspace" : "user";
    const scopeId = scopeType === "workspace" ? requireString(args.scopeId ?? context.workspaceId, "workspace scopeId") : context.userId;
    if (scopeType === "workspace" && !allowedWorkspace(scopeId, context.userId, operation !== "get")) forbidden("无权访问该工作区插件存储");
    const key = requireString(args.key, "key");
    if (Buffer.byteLength(key) > 200) throw new Error("storage key 过长");
    if (operation === "get") {
      this.require(context, "plugin-storage:read");
      const row = db.prepare("SELECT value FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=? AND key=?")
        .get(context.pluginId, scopeType, scopeId, key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : null;
    }
    if (operation === "set") {
      this.require(context, "plugin-storage:write");
      const value = JSON.stringify(args.value);
      if (Buffer.byteLength(value) > 256 * 1024) throw new Error("plugin storage value 超过 256KB");
      db.prepare(`INSERT INTO plugin_storage(pluginId,scopeType,scopeId,key,value,updatedAt) VALUES (?,?,?,?,?,?)
        ON CONFLICT(pluginId,scopeType,scopeId,key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`)
        .run(context.pluginId, scopeType, scopeId, key, value, new Date().toISOString());
      return { success: true };
    }
    if (operation === "delete") {
      this.require(context, "plugin-storage:write");
      db.prepare("DELETE FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=? AND key=?")
        .run(context.pluginId, scopeType, scopeId, key);
      return { success: true };
    }
    throw new Error(`未知 storage 操作: ${operation}`);
  }

  private async external(context: PluginExecutionContext, operation: string, args: JsonObject): Promise<unknown> {
    if (operation !== "fetch") throw new Error(`未知 external 操作: ${operation}`);
    const permission = this.permissions.require(context.pluginId, "external:fetch");
    const url = new URL(requireString(args.url, "url"));
    if (url.protocol !== "https:") forbidden("external.fetch 只允许 HTTPS", "EXTERNAL_FETCH_DENIED");
    const config = JSON.parse(permission.configJson || "{}") as { hosts?: string[] };
    if (!config.hosts?.includes(url.hostname)) forbidden(`Host 未在插件白名单: ${url.hostname}`, "EXTERNAL_FETCH_DENIED");
    await assertPublicHost(url.hostname);
    const headers = new Headers();
    for (const [name, value] of Object.entries(args.headers || {})) {
      if (/^(authorization|cookie|proxy-authorization)$/i.test(name)) continue;
      headers.set(name, String(value));
    }
    if (args.connection) {
      this.require(context, "secrets:use");
      headers.set("Authorization", `Bearer ${this.secrets.get(context.pluginId, context.userId, String(args.connection))}`);
    }
    const response = await fetch(url, {
      method: String(args.method || "GET").toUpperCase(),
      headers,
      body: args.body === undefined ? undefined : (typeof args.body === "string" ? args.body : JSON.stringify(args.body)),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 1024 * 1024) throw new Error("external.fetch 响应超过 1MB");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 1024 * 1024) throw new Error("external.fetch 响应超过 1MB");
    return { status: response.status, ok: response.ok, headers: { "content-type": response.headers.get("content-type") }, body };
  }
}
