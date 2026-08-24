import dns from "node:dns/promises";
import net from "node:net";
import { getDb } from "../db/schema.js";
import {
  getUserWorkspaceRole,
  hasPermission,
  hasRole,
  resolveNotePermission,
  resolveNotebookPermission,
} from "../middleware/acl.js";
import { ensureMindmapSchema } from "../lib/mindmap-schema.js";
import { ApplicationCommandGateway } from "../services/applicationCommandGateway.js";
import {
  createHostMethodNotFound,
  HOST_API_BUDGETS,
  HOST_API_CONTRACT,
  HOST_API_CONTRACT_VERSION,
  requireHostMethod,
  requireV2CombinationPermission,
  type HostRuntime,
} from "./hostApiContract.js";
import { PluginPermissions, type PermissionRow } from "./permissions.js";
import { PluginRegistry } from "./registry.js";
import { PluginSecrets } from "./secrets.js";
import type { HostCall, PluginExecutionContext, PluginManifest } from "./types.js";

type JsonObject = Record<string, any>;

function forbidden(message: string, code = "RESOURCE_FORBIDDEN"): never {
  throw Object.assign(new Error(message), { code });
}

function argsObject(args: unknown): JsonObject {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Host API 参数必须是对象");
  return args as JsonObject;
}

function requireJsonBudget(
  value: unknown,
  maxBytes: number,
  sizeErrorCode: "HOST_ARGS_TOO_LARGE" | "HOST_RESULT_TOO_LARGE",
  serializationErrorCode: "INVALID_ARGUMENT" | "PLUGIN_ERROR",
  label: string,
): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw Object.assign(new Error(`${label}必须是可序列化 JSON`), { code: serializationErrorCode });
  }
  if (serialized === undefined) {
    throw Object.assign(new Error(`${label}必须是可序列化 JSON`), { code: serializationErrorCode });
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw Object.assign(new Error(`${label}超过 ${maxBytes} 字节限制`), { code: sizeErrorCode });
  }
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
    private readonly commands = new ApplicationCommandGateway(),
    private readonly registry = new PluginRegistry(),
  ) {}

  async call(context: PluginExecutionContext, call: HostCall): Promise<unknown> {
    const record = this.registry.get(context.pluginId);
    const apiVersion = record?.apiVersion === 2 ? 2 : 1;
    const runtime: HostRuntime = record?.runtime === "sandbox-js" ? "sandbox-js" : "node-action";
    const contract = requireHostMethod(call.method, apiVersion, runtime);
    const methodPermission = contract.permission === null
      ? null
      : this.permissions.require(context.pluginId, contract.permission);
    const [namespace, operation] = call.method.split(".");
    const args = argsObject(call.args ?? {});
    requireJsonBudget(args, contract.maxArgsBytes, "HOST_ARGS_TOO_LARGE", "INVALID_ARGUMENT", "Host API 参数");
    let result: unknown;
    switch (namespace) {
      case "notes": result = await this.notes(context, operation, args); break;
      case "notebooks": result = await this.notebooks(context, operation, args); break;
      case "tags": result = await this.tags(context, operation, args); break;
      case "tasks": result = await this.tasks(context, operation, args); break;
      case "attachments": result = this.attachments(context, operation, args); break;
      case "diary": result = await this.diary(context, operation, args); break;
      case "mindmaps": result = await this.mindmaps(context, operation, args); break;
      case "storage": result = this.storage(context, operation, args); break;
      case "external": result = await this.external(context, operation, args, methodPermission); break;
      case "runtime": result = this.runtime(context, operation); break;
      default: throw createHostMethodNotFound(call.method);
    }
    requireJsonBudget(result, contract.maxResultBytes, "HOST_RESULT_TOO_LARGE", "PLUGIN_ERROR", "Host API 结果");
    return result;
  }

  private runtime(context: PluginExecutionContext, operation: string): unknown {
    if (operation !== "capabilities") throw createHostMethodNotFound(`runtime.${operation}`);
    const record = this.registry.get(context.pluginId);
    const apiVersion = record?.apiVersion === 2 ? 2 : 1;
    const runtime: HostRuntime = record?.runtime === "sandbox-js" ? "sandbox-js" : "node-action";
    const supportedMethods = Object.freeze(HOST_API_CONTRACT.filter(
      (entry) => apiVersion >= entry.sinceApiVersion && entry.runtimes.includes(runtime),
    ));
    return {
      apiVersion, runtime,
      platform: process.env.ELECTRON_USER_DATA ? "desktop-full" : "server",
      contractVersion: HOST_API_CONTRACT_VERSION,
      budgets: HOST_API_BUDGETS,
      methods: supportedMethods,
      hostApis: [...new Set(supportedMethods.map((entry) => entry.method.split(".")[0]))],
      notes: { read: 2, write: 2 }, notebooks: { read: 1, write: 1 }, tasks: { read: 1, write: 1 },
      automation: 1, workspace: 1, declarativeContributions: 1,
    };
  }

  private async notes(context: PluginExecutionContext, operation: string, args: JsonObject): Promise<unknown> {
    const db = getDb();
    if (operation === "get") {
      const id = requireString(args.id ?? args.noteId, "noteId");
      if (!hasPermission(resolveNotePermission(id, context.userId).permission, "read")) forbidden("无权读取该笔记");
      return db.prepare("SELECT id, notebookId, title, content, contentText, contentFormat, workspaceId, version, createdAt, updatedAt FROM notes WHERE id=? AND isTrashed=0").get(id) || null;
    }
    if (operation === "list") {
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));
      const rows = db.prepare("SELECT id, notebookId, title, contentText, contentFormat, workspaceId, version, createdAt, updatedAt FROM notes WHERE isTrashed=0 ORDER BY updatedAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => hasPermission(resolveNotePermission(row.id, context.userId).permission, "read")).slice(0, limit);
    }
    if (operation === "create") {
      const notebookId = requireString(args.notebookId, "notebookId");
      const access = resolveNotebookPermission(notebookId, context.userId);
      if (!hasPermission(access.permission, "write")) forbidden("无权在该笔记本创建笔记");
      const created = await this.commands.createNote(context.userId, {
        notebookId,
        title: String(args.title || "无标题笔记"),
        content: typeof args.content === "string" ? args.content : undefined,
        contentFormat: typeof args.contentFormat === "string" ? args.contentFormat : "markdown",
      }, context);
      return { id: created.id, version: created.version };
    }
    if (operation === "update") {
      const id = requireString(args.id ?? args.noteId, "noteId");
      if (!hasPermission(resolveNotePermission(id, context.userId).permission, "write")) forbidden("无权修改该笔记");
      const current = db.prepare("SELECT title,content,contentText,contentFormat,version FROM notes WHERE id=?").get(id) as JsonObject | undefined;
      if (!current) throw new Error("笔记不存在");
      const updated = await this.commands.updateNote(context.userId, id, {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.content !== undefined ? { content: args.content } : {}),
        ...(args.contentFormat !== undefined ? { contentFormat: args.contentFormat } : {}),
        version: Number(current.version || 0),
        writeSource: "plugin-host-api",
      }, context);
      return { id, version: updated.version };
    }
    throw createHostMethodNotFound(`notes.${operation}`);
  }

  private async notebooks(context: PluginExecutionContext, operation: string, args: JsonObject): Promise<unknown> {
    const db = getDb();
    if (operation === "get") {
      const id = requireString(args.id ?? args.notebookId, "notebookId");
      if (!hasPermission(resolveNotebookPermission(id, context.userId).permission, "read")) forbidden("无权读取该笔记本");
      return db.prepare("SELECT id,parentId,name,description,icon,color,workspaceId,createdAt,updatedAt FROM notebooks WHERE id=? AND isDeleted=0").get(id) || null;
    }
    if (operation === "list") {
      const rows = db.prepare("SELECT id,parentId,name,description,icon,color,workspaceId,createdAt,updatedAt FROM notebooks WHERE isDeleted=0 ORDER BY sortOrder,name").all() as JsonObject[];
      return rows.filter((row) => hasPermission(resolveNotebookPermission(row.id, context.userId).permission, "read"));
    }
    if (operation === "create") {
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId, true)) forbidden("无权在该工作区创建笔记本");
      if (args.parentId && !hasPermission(resolveNotebookPermission(String(args.parentId), context.userId).permission, "write")) forbidden("无权使用该父笔记本");
      const created = await this.commands.createNotebook(context.userId, {
        workspaceId,
        parentId: args.parentId || null,
        name: requireString(args.name, "name"),
        icon: String(args.icon || "📒"),
        color: args.color || null,
      }, context);
      return { id: created.id };
    }
    throw createHostMethodNotFound(`notebooks.${operation}`);
  }

  private async tags(context: PluginExecutionContext, operation: string, args: JsonObject): Promise<unknown> {
    const db = getDb();
    if (operation === "list") {
      const rows = db.prepare("SELECT id,name,color,workspaceId,createdAt FROM tags WHERE userId=? OR workspaceId IS NOT NULL ORDER BY name").all(context.userId) as JsonObject[];
      return rows.filter((row) => !row.workspaceId || allowedWorkspace(row.workspaceId, context.userId));
    }
    if (operation === "create") {
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId, true)) forbidden("无权在该工作区创建标签");
      const created = await this.commands.createTag(context.userId, {
        workspaceId,
        name: requireString(args.name, "name"),
        color: String(args.color || "#58a6ff"),
      }, context);
      return { id: created.id };
    }
    if (operation === "addToNote" || operation === "removeFromNote") {
      const noteId = requireString(args.noteId, "noteId");
      const tagId = requireString(args.tagId, "tagId");
      if (!hasPermission(resolveNotePermission(noteId, context.userId).permission, "write")) forbidden("无权修改该笔记标签");
      await this.commands.setNoteTag(context.userId, noteId, tagId, operation === "addToNote", context);
      return { success: true };
    }
    throw createHostMethodNotFound(`tags.${operation}`);
  }

  private async tasks(context: PluginExecutionContext, operation: string, args: JsonObject): Promise<unknown> {
    const db = getDb();
    if (operation === "get") {
      const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(requireString(args.id ?? args.taskId, "taskId")) as JsonObject | undefined;
      if (!row || (row.userId !== context.userId && !allowedWorkspace(row.workspaceId, context.userId))) forbidden("无权读取该任务");
      return row;
    }
    if (operation === "list") {
      const rows = db.prepare("SELECT * FROM tasks ORDER BY updatedAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => row.userId === context.userId || allowedWorkspace(row.workspaceId, context.userId)).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 50)));
    }
    if (operation === "create") {
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId, true)) forbidden("无权在该工作区创建任务");
      const created = await this.commands.createTask(context.userId, workspaceId, {
        ...args,
        title: requireString(args.title, "title"),
      }, context);
      return { id: created.id };
    }
    if (operation === "update") {
      const id = requireString(args.id ?? args.taskId, "taskId");
      const current = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as JsonObject | undefined;
      if (!current || (current.userId !== context.userId && !allowedWorkspace(current.workspaceId, context.userId, true))) forbidden("无权修改该任务");
      const updated = await this.commands.updateTask(context.userId, id, args, context);
      return { id: updated.task?.id || id };
    }
    throw createHostMethodNotFound(`tasks.${operation}`);
  }

  private attachments(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    if (operation === "get") {
      const row = db.prepare("SELECT id,noteId,filename,mimeType,size,createdAt FROM attachments WHERE id=?").get(requireString(args.id ?? args.attachmentId, "attachmentId")) as JsonObject | undefined;
      if (!row || !hasPermission(resolveNotePermission(row.noteId, context.userId).permission, "read")) forbidden("无权读取该附件");
      return row;
    }
    if (operation === "list") {
      const rows = db.prepare("SELECT id,noteId,filename,mimeType,size,createdAt FROM attachments ORDER BY createdAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => hasPermission(resolveNotePermission(row.noteId, context.userId).permission, "read")).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 50)));
    }
    throw createHostMethodNotFound(`attachments.${operation}`);
  }

  private async diary(context: PluginExecutionContext, operation: string, args: JsonObject): Promise<unknown> {
    const db = getDb();
    if (operation === "get") {
      const row = db.prepare("SELECT id,userId,workspaceId,contentText,mood,images,media,createdAt FROM diaries WHERE id=?")
        .get(requireString(args.id ?? args.diaryId, "diaryId")) as JsonObject | undefined;
      if (!row || (row.userId !== context.userId && !allowedWorkspace(row.workspaceId, context.userId))) forbidden("无权读取该日记");
      return row;
    }
    if (operation === "list") {
      const rows = db.prepare("SELECT id,userId,workspaceId,contentText,mood,images,media,createdAt FROM diaries ORDER BY createdAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => row.userId === context.userId || allowedWorkspace(row.workspaceId, context.userId)).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 50)));
    }
    if (operation === "create") {
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId, true)) forbidden("无权在该工作区创建日记");
      const created = await this.commands.createDiary(context.userId, workspaceId, {
        contentText: String(args.contentText || ""),
        mood: String(args.mood || ""),
        media: Array.isArray(args.media) ? args.media : [],
        images: Array.isArray(args.images) ? args.images : [],
        ...(args.createdAt ? { createdAt: args.createdAt } : {}),
      }, context);
      return { id: created.id };
    }
    throw createHostMethodNotFound(`diary.${operation}`);
  }

  private async mindmaps(context: PluginExecutionContext, operation: string, args: JsonObject): Promise<unknown> {
    ensureMindmapSchema();
    const db = getDb();
    if (operation === "get") {
      const row = db.prepare("SELECT * FROM mindmaps WHERE id=?").get(requireString(args.id ?? args.mindmapId, "mindmapId")) as JsonObject | undefined;
      if (!row || (row.userId !== context.userId && !allowedWorkspace(row.workspaceId, context.userId))) forbidden("无权读取该思维导图");
      return row;
    }
    if (operation === "list") {
      const rows = db.prepare("SELECT id,userId,workspaceId,title,starred,folderId,createdAt,updatedAt FROM mindmaps ORDER BY updatedAt DESC LIMIT 500").all() as JsonObject[];
      return rows.filter((row) => row.userId === context.userId || allowedWorkspace(row.workspaceId, context.userId)).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 50)));
    }
    if (operation === "create") {
      const workspaceId = typeof args.workspaceId === "string" && args.workspaceId ? args.workspaceId : null;
      if (!allowedWorkspace(workspaceId, context.userId, true)) forbidden("无权在该工作区创建思维导图");
      const title = String(args.title || "无标题导图");
      const data = args.data ?? { root: { id: "root", text: title, children: [] } };
      const created = await this.commands.createMindmap(context.userId, workspaceId, { title, data }, context);
      return { id: created.id };
    }
    if (operation === "update") {
      const id = requireString(args.id ?? args.mindmapId, "mindmapId");
      const row = db.prepare("SELECT * FROM mindmaps WHERE id=?").get(id) as JsonObject | undefined;
      if (!row || (row.userId !== context.userId && !allowedWorkspace(row.workspaceId, context.userId, true))) forbidden("无权修改该思维导图");
      const updated = await this.commands.updateMindmap(context.userId, id, args, context);
      return { id: updated.id || id };
    }
    throw createHostMethodNotFound(`mindmaps.${operation}`);
  }

  private storage(context: PluginExecutionContext, operation: string, args: JsonObject): unknown {
    const db = getDb();
    const scopeType = args.scopeType === "workspace" ? "workspace" : "user";
    const scopeId = scopeType === "workspace" ? requireString(args.scopeId ?? context.workspaceId, "workspace scopeId") : context.userId;
    if (scopeType === "workspace" && !allowedWorkspace(scopeId, context.userId, operation !== "get")) forbidden("无权访问该工作区插件存储");
    const key = requireString(args.key, "key");
    if (Buffer.byteLength(key) > 200) throw new Error("storage key 过长");
    if (operation === "get") {
      const row = db.prepare("SELECT value FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=? AND key=?")
        .get(context.pluginId, scopeType, scopeId, key) as { value: string } | undefined;
      return row ? JSON.parse(row.value) : null;
    }
    if (operation === "set") {
      const value = JSON.stringify(args.value);
      if (Buffer.byteLength(value) > 256 * 1024) throw new Error("plugin storage value 超过 256KB");
      db.prepare(`INSERT INTO plugin_storage(pluginId,scopeType,scopeId,key,value,updatedAt) VALUES (?,?,?,?,?,?)
        ON CONFLICT(pluginId,scopeType,scopeId,key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`)
        .run(context.pluginId, scopeType, scopeId, key, value, new Date().toISOString());
      return { success: true };
    }
    if (operation === "delete") {
      db.prepare("DELETE FROM plugin_storage WHERE pluginId=? AND scopeType=? AND scopeId=? AND key=?")
        .run(context.pluginId, scopeType, scopeId, key);
      return { success: true };
    }
    throw createHostMethodNotFound(`storage.${operation}`);
  }

  private async external(
    context: PluginExecutionContext,
    operation: string,
    args: JsonObject,
    methodPermission: PermissionRow | null,
  ): Promise<unknown> {
    if (operation !== "fetch") throw createHostMethodNotFound(`external.${operation}`);
    if (!methodPermission) {
      throw Object.assign(new Error("external.fetch 合同缺少方法权限"), { code: "HOST_METHOD_UNSUPPORTED" });
    }
    const url = new URL(requireString(args.url, "url"));
    if (url.protocol !== "https:") forbidden("external.fetch 只允许 HTTPS", "EXTERNAL_FETCH_DENIED");
    const config = JSON.parse(methodPermission.configJson || "{}") as { hosts?: string[] };
    if (!config.hosts?.includes(url.hostname)) forbidden(`Host 未在插件白名单: ${url.hostname}`, "EXTERNAL_FETCH_DENIED");
    await assertPublicHost(url.hostname);
    const headers = new Headers();
    for (const [name, value] of Object.entries(args.headers || {})) {
      if (/^(authorization|cookie|proxy-authorization)$/i.test(name)) continue;
      headers.set(name, String(value));
    }
    if (args.connection) {
      this.permissions.require(context.pluginId, requireV2CombinationPermission("secrets:use"));
      const connectionId = String(args.connection);
      const record = this.registry.get(context.pluginId);
      const manifest = record ? JSON.parse(record.manifestJson) as PluginManifest : undefined;
      const connection = manifest?.connections?.find((item) => item.id === connectionId);
      if (!connection) forbidden(`Manifest 未声明 Connection: ${connectionId}`, "INVALID_ARGUMENT");
      const secret = this.secrets.get(context.pluginId, context.userId, connectionId);
      if (connection.type === "bearer") headers.set("Authorization", `Bearer ${secret}`);
      else if (connection.type === "api-key-header") headers.set(connection.headerName || "X-API-Key", secret);
      else headers.set("Authorization", `Basic ${Buffer.from(secret, "utf8").toString("base64")}`);
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
