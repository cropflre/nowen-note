/**
 * Nowen Note API 客户端
 * 封装对 Nowen Note 后端 REST API 的调用
 */

import { lstat, readFile } from "node:fs/promises";
import { openAsBlob, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export interface NowenApiConfig {
  baseUrl: string;   // 例如 http://localhost:3001
  username: string;
  password: string;
}

export interface AttachmentUploadResult {
  id: string;
  url: string;
  mimeType: string;
  size: number;
  filename: string;
  category: "image" | "file";
  createdAt?: string;
  deduplicated?: boolean;
}

export interface AttachmentListResult {
  items: any[];
  total: number;
  page: number;
  pageSize: number;
}

export class NowenApiClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private token: string | null = null;

  constructor(config: NowenApiConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.token = process.env.NOWEN_API_TOKEN?.trim() || null;
  }

  /** 登录获取 JWT Token */
  private async login(): Promise<void> {
    if (!this.username || !this.password) {
      throw new Error("请设置 NOWEN_API_TOKEN，或显式配置 NOWEN_USERNAME 和 NOWEN_PASSWORD；MCP 不再尝试默认管理员凭据");
    }
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`登录失败 (${res.status}): ${err}`);
    }
    const data = await res.json() as { token: string };
    this.token = data.token;
  }

  /** 确保已认证 */
  private async ensureAuth(): Promise<void> {
    if (!this.token) {
      await this.login();
    }
  }

  /** 发送带认证的 API 请求 */
  private async request<T = any>(
    path: string,
    options: {
      method?: string;
      body?: any;
      query?: Record<string, string | number | boolean | undefined | null>;
    } = {}
  ): Promise<T> {
    await this.ensureAuth();

    const url = this.buildUrl(path, options.query);

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
    };
    if (options.body) {
      headers["Content-Type"] = "application/json";
    }

    const res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    // Token 过期，重新登录后重试
    if (res.status === 401) {
      if (process.env.NOWEN_API_TOKEN?.trim()) {
        throw new Error("NOWEN_API_TOKEN 无效、已过期或权限不足；不会自动回退到账号密码");
      }
      this.token = null;
      await this.login();
      headers["Authorization"] = `Bearer ${this.token}`;
      const retryRes = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      if (!retryRes.ok) {
        const err = await retryRes.text();
        throw new Error(`API 请求失败 (${retryRes.status}): ${err}`);
      }
      return retryRes.json() as Promise<T>;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API 请求失败 (${res.status}): ${err}`);
    }

    return res.json() as Promise<T>;
  }

  private buildUrl(pathname: string, query?: Record<string, string | number | boolean | undefined | null>): string {
    let url = `${this.baseUrl}${pathname}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }

  private async multipartRequest<T = any>(
    pathname: string,
    form: FormData,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    await this.ensureAuth();
    const url = this.buildUrl(pathname, query);
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: form,
    });

    if (res.status === 401) {
      this.token = null;
      await this.login();
      const retryRes = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${this.token}` },
        body: form,
      });
      if (!retryRes.ok) {
        const err = await retryRes.text();
        throw new Error(`API 上传失败 (${retryRes.status}): ${err}`);
      }
      return retryRes.json() as Promise<T>;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API 上传失败 (${res.status}): ${err}`);
    }
    return res.json() as Promise<T>;
  }

  private inferMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
      case ".png": return "image/png";
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".gif": return "image/gif";
      case ".webp": return "image/webp";
      case ".svg": return "image/svg+xml";
      case ".pdf": return "application/pdf";
      case ".txt":
      case ".md": return "text/plain";
      case ".json": return "application/json";
      case ".csv": return "text/csv";
      case ".html":
      case ".htm": return "text/html";
      case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      case ".zip": return "application/zip";
      default: return "application/octet-stream";
    }
  }

  private buildAttachmentMarkdown(file: any, alt?: string): string {
    const id = file.id;
    const filename = file.filename || id;
    const mimeType = String(file.mimeType || "").toLowerCase();
    const isImage = file.category === "image" || mimeType.startsWith("image/");
    const label = alt || filename || id;
    if (isImage) {
      return `![${label}](/api/attachments/${id})`;
    }
    return `[${label}](/api/attachments/${id}?download=1)`;
  }

  // ==================== 迁移中心 ====================

  migrationCapabilities(): Promise<any> {
    return this.request("/api/migrations/capabilities");
  }

  createMigration(params: { operationId: string; source: { platform: string; exportId: string }; name?: string; workspaceId?: string | null; targetNotebookId?: string | null }): Promise<any> {
    return this.request("/api/migrations", { method: "POST", body: params });
  }

  stageMigrationItems(id: string, items: unknown[]): Promise<any> {
    return this.request(`/api/migrations/${encodeURIComponent(id)}/items`, { method: "POST", body: { items } });
  }

  migrationAction(id: string, action: "status" | "preview" | "retry" | "cancel" | "pause" | "resume"): Promise<any> {
    const base = `/api/migrations/${encodeURIComponent(id)}`;
    return action === "status" ? this.request(base) : this.request(`${base}/${action}`, { method: "POST", body: {} });
  }

  /** Caller must enforce stdio-only access before accepting a user-authorized local path. */
  async uploadMigrationFile(id: string, params: { filePath: string; filename?: string; assetPath?: string; sha256?: string }): Promise<any> {
    await this.ensureAuth();
    const info = await lstat(params.filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("迁移上传需要普通文件，不接受目录或符号链接");
    const capabilities = await this.migrationCapabilities();
    const maxBytes = capabilities?.limits?.uploadBytes ?? capabilities?.limits?.maxUploadBytes;
    if (typeof maxBytes === "number" && info.size > maxBytes) throw new Error("文件超过服务器迁移上传限额");
    const filename = params.filename || path.basename(params.filePath);
    const body = await openAsBlob(params.filePath);
    if (capabilities?.resumableUploads) {
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(params.filePath)) digest.update(chunk);
      const fileHash = digest.digest("hex");
      if (params.sha256 && params.sha256.toLowerCase() !== fileHash) throw new Error("迁移文件 SHA-256 与预期不一致");
      const base = `/api/migrations/${encodeURIComponent(id)}/upload-sessions`;
      const operationId = createHash("sha256").update(JSON.stringify([filename, info.size, fileHash, params.assetPath || null])).digest("hex");
      let session = await this.request<any>(base, { method: "POST", body: { operationId, filename, size: info.size, sha256: fileHash, ...(params.assetPath ? { assetPath: params.assetPath } : {}) } });
      const sessionPath = `${base}/${encodeURIComponent(session.id)}`;
      while (session.offset < info.size) {
        if (session.jobId !== id || session.sha256 !== fileHash || !Number.isSafeInteger(session.offset) || session.offset < 0
          || !Number.isSafeInteger(session.chunkBytes) || session.chunkBytes < 1 || session.chunkBytes > 4 * 1024 * 1024) throw new Error("迁移上传偏移无效");
        const offset = session.offset;
        const chunk = body.slice(offset, offset + session.chunkBytes);
        const hash = createHash("sha256").update(new Uint8Array(await chunk.arrayBuffer())).digest("hex");
        const response = await fetch(this.buildUrl(`${sessionPath}/chunks`, { offset }), { method: "PUT", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/octet-stream", "X-Chunk-SHA256": hash }, body: chunk });
        if (!response.ok) throw new Error(`迁移分块上传失败 (${response.status})`);
        session = await response.json();
        if (session.offset <= offset || session.offset > info.size) throw new Error("迁移上传偏移无效");
      }
      return this.request(`${sessionPath}/complete`, { method: "POST", body: {} });
    }
    const response = await fetch(this.buildUrl(`/api/migrations/${encodeURIComponent(id)}/uploads`, {
      filename, assetPath: params.assetPath, sha256: params.sha256,
    }), { method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/octet-stream" }, body });
    if (!response.ok) throw new Error(`迁移上传失败 (${response.status}): ${await response.text()}`);
    return response.json();
  }

  // ==================== 笔记本 ====================

  /** 获取所有笔记本 */
  async listNotebooks(): Promise<any[]> {
    return this.request("/api/notebooks");
  }

  /** 创建笔记本 */
  async createNotebook(params: {
    name: string;
    parentId?: string;
    icon?: string;
    color?: string;
  }): Promise<any> {
    return this.request("/api/notebooks", { method: "POST", body: params });
  }

  /** 更新笔记本 */
  async updateNotebook(id: string, params: {
    name?: string;
    icon?: string;
    color?: string;
    parentId?: string;
  }): Promise<any> {
    return this.request(`/api/notebooks/${id}`, { method: "PUT", body: params });
  }

  /** 删除笔记本 */
  async deleteNotebook(id: string): Promise<any> {
    return this.request(`/api/notebooks/${id}`, { method: "DELETE" });
  }

  // ==================== 笔记 ====================

  /** 获取笔记列表 */
  async listNotes(params?: {
    notebookId?: string;
    isFavorite?: string;
    isTrashed?: string;
    tagId?: string;
    search?: string;
    dateFrom?: string;
    dateTo?: string;
  }): Promise<any[]> {
    return this.request("/api/notes", { query: params });
  }

  /** 获取单个笔记（完整内容） */
  async getNote(id: string): Promise<any> {
    return this.request(`/api/notes/${id}`);
  }

  /** 创建笔记 */
  async createNote(params: {
    notebookId: string;
    title?: string;
    content?: string;
    contentText?: string;
    contentFormat?: "markdown" | "tiptap-json" | "html";
  }): Promise<any> {
    return this.request("/api/notes", { method: "POST", body: params });
  }

  /** 更新笔记 */
  async updateNote(id: string, params: {
    title?: string;
    content?: string;
    contentText?: string;
    contentFormat?: "markdown" | "tiptap-json" | "html";
    notebookId?: string;
    isPinned?: number;
    isFavorite?: number;
    isLocked?: number;
    isTrashed?: number;
    version?: number;
    syncToYjs?: boolean;
    writeSource?: "mcp";
  }): Promise<any> {
    return this.request(`/api/notes/${id}`, { method: "PUT", body: params });
  }

  /** 删除笔记（永久） */
  async deleteNote(id: string): Promise<any> {
    return this.request(`/api/notes/${id}/permanent`, { method: "DELETE" });
  }

  /** 从知识树服务读取统一目录；所有目录权限交由服务端与 scoped MCP 再校验。 */
  async getKnowledgeTree(workspaceId?: string, includeDeleted = false): Promise<any> {
    return this.request("/api/knowledge-tree/", {
      query: { workspaceId: workspaceId || "personal", includeDeleted: includeDeleted ? "1" : undefined },
    });
  }

  async createKnowledgeNode(params: {
    parentId: string | null; title: string; nodeType: "folder" | "markdown";
  }): Promise<any> {
    return this.request("/api/knowledge-tree/nodes", {
      method: "POST", query: { workspaceId: "personal" }, body: params,
    });
  }

  /** 版本预条件由后端 PAT 中间件在业务写入前验证。 */
  async renameKnowledgeNode(nodeId: string, payload: Record<string, unknown>): Promise<any> {
    return this.request(`/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}`, {
      method: "PATCH", query: { workspaceId: "personal" }, body: payload,
    });
  }

  async moveKnowledgeNode(nodeId: string, payload: Record<string, unknown>): Promise<any> {
    return this.request(`/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/move`, {
      method: "PUT", query: { workspaceId: "personal" }, body: payload,
    });
  }

  async trashKnowledgeNode(nodeId: string, payload: Record<string, unknown>): Promise<any> {
    return this.request(`/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}`, {
      method: "DELETE", query: { workspaceId: "personal", mode: "subtree" }, body: payload,
    });
  }

  async restoreKnowledgeNode(nodeId: string, payload: Record<string, unknown>): Promise<any> {
    return this.request(`/api/knowledge-tree/nodes/${encodeURIComponent(nodeId)}/restore`, {
      method: "POST", query: { workspaceId: "personal" }, body: payload,
    });
  }

  // ==================== 通用块 / 双链 ====================

  async listNoteBlocks(noteId: string, limit = 500): Promise<any[]> {
    const result = await this.request<{ blocks: any[] }>(`/api/blocks/note/${noteId}`, { query: { limit } });
    return result.blocks || [];
  }

  async getBlock(noteId: string, blockId: string): Promise<any> {
    return this.request(`/api/blocks/${noteId}/${blockId}`);
  }

  async searchBlocks(query: string, params: { notebookId?: string; limit?: number } = {}): Promise<any[]> {
    return this.request("/api/blocks/search", { query: { q: query, notebookId: params.notebookId, limit: params.limit } });
  }

  async resolveInternalLink(link: string): Promise<any> {
    return this.request("/api/blocks/resolve", { query: { link } });
  }

  async getBacklinks(noteId: string, limit = 100): Promise<any[]> {
    const result = await this.request<{ backlinks: any[] }>(`/api/notes/${noteId}/backlinks`, { query: { limit } });
    return result.backlinks || [];
  }

  async getBlockBacklinks(noteId: string, blockId: string): Promise<any[]> {
    const result = await this.request<{ backlinks: any[] }>(`/api/blocks/${noteId}/${blockId}/backlinks`);
    return result.backlinks || [];
  }

  async createBlock(noteId: string, params: {
    blockType?: "heading" | "paragraph" | "listItem" | "taskItem" | "blockquote" | "codeBlock";
    text?: string;
    afterBlockId?: string;
    expectedNoteVersion: number;
    operationId: string;
  }): Promise<any> {
    return this.request(`/api/blocks/${noteId}`, { method: "POST", body: params });
  }

  async updateBlock(noteId: string, blockId: string, params: {
    text: string;
    expectedNoteVersion: number;
    operationId: string;
  }): Promise<any> {
    return this.request(`/api/blocks/${noteId}/${blockId}`, { method: "PUT", body: params });
  }

  async deleteBlock(noteId: string, blockId: string, params: {
    expectedNoteVersion: number;
    operationId: string;
  }): Promise<any> {
    return this.request(`/api/blocks/${noteId}/${blockId}`, { method: "DELETE", body: params });
  }

  async moveBlock(noteId: string, blockId: string, params: {
    targetBlockId: string;
    position?: "before" | "after";
    expectedNoteVersion: number;
    operationId: string;
  }): Promise<any> {
    return this.request(`/api/blocks/${noteId}/${blockId}/move`, { method: "POST", body: params });
  }

  // ==================== 标签 ====================

  /** 获取所有标签 */
  async listTags(): Promise<any[]> {
    return this.request("/api/tags");
  }

  /** 创建标签 */
  async createTag(params: { name: string; color?: string }): Promise<any> {
    return this.request("/api/tags", { method: "POST", body: params });
  }

  /** 给笔记添加标签 */
  async addTagToNote(noteId: string, tagId: string): Promise<any> {
    return this.request(`/api/tags/note/${noteId}/tag/${tagId}`, { method: "POST" });
  }

  /** 移除笔记标签 */
  async removeTagFromNote(noteId: string, tagId: string): Promise<any> {
    return this.request(`/api/tags/note/${noteId}/tag/${tagId}`, { method: "DELETE" });
  }

  // ==================== 任务 / 待办 ====================
  // PAT 仅可访问本人个人任务；共享工作区需要登录态并遵守工作区 ACL。
  async listTasks(filter?: "all" | "today" | "week" | "overdue" | "completed"): Promise<any[]> {
    return this.request("/api/tasks", { query: { workspaceId: "personal", filter } });
  }

  async getTask(taskId: string): Promise<any> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async createTask(params: { title: string; priority?: number; dueDate?: string; dueAt?: string; description?: string; parentId?: string; projectId?: string }): Promise<any> {
    return this.request("/api/tasks", { method: "POST", query: { workspaceId: "personal" }, body: params });
  }

  async updateTask(taskId: string, params: Record<string, unknown>): Promise<any> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "PUT", body: params });
  }

  async taskSummary(): Promise<any> {
    return this.request("/api/tasks/stats/summary", { query: { workspaceId: "personal" } });
  }

  async listTaskReminders(taskId: string): Promise<any[]> {
    return this.request(`/api/task-reminders/${encodeURIComponent(taskId)}`);
  }

  async createTaskReminder(taskId: string, params: { offsetMinutes: number; timezoneOffsetMinutes: number }): Promise<any> {
    return this.request(`/api/task-reminders/${encodeURIComponent(taskId)}`, { method: "POST", body: params });
  }

  /** 个人任务归档或恢复；后端会校验子任务全部完成。 */
  async archiveTask(taskId: string, archived: boolean): Promise<any> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/archive`, {
      method: "PATCH",
      body: { archived },
    });
  }

  /** MCP Token 的项目操作仅支持本人个人空间。 */
  async listTaskProjects(): Promise<any[]> {
    return this.request("/api/task-projects", { query: { workspaceId: "personal" } });
  }

  async createTaskProject(params: { name: string; icon?: string; color?: string }): Promise<any> {
    return this.request("/api/task-projects", {
      method: "POST",
      query: { workspaceId: "personal" },
      body: params,
    });
  }

  async updateTaskProject(id: string, params: { name?: string; icon?: string; color?: string }): Promise<any> {
    return this.request(`/api/task-projects/${encodeURIComponent(id)}`, {
      method: "PUT",
      query: { workspaceId: "personal" },
      body: params,
    });
  }

  // ==================== P1: 个人网盘与任务转笔记 ====================

  async listFileFolders(): Promise<any> {
    return this.request("/api/attachment-folders/", { query: { workspaceId: "personal" } });
  }

  async createFileFolder(name: string, parentId: string | null): Promise<any> {
    return this.request("/api/attachment-folders/", {
      method: "POST", query: { workspaceId: "personal" }, body: { name, parentId },
    });
  }

  async updateFileFolder(folderId: string, body: {
    name?: string; parentId?: string | null; expectedName: string; expectedParentId: string | null;
  }): Promise<any> {
    return this.request(`/api/attachment-folders/${encodeURIComponent(folderId)}`, {
      method: "PATCH", query: { workspaceId: "personal" }, body,
    });
  }

  async listPersonalManagedFiles(query: { q?: string; folderId?: string; page?: number; pageSize?: number } = {}): Promise<any> {
    return this.request("/api/files", {
      query: {
        filter: "myUploads",
        q: query.q, folderId: query.folderId, page: query.page || 1,
        pageSize: Math.min(100, query.pageSize || 50),
      },
    });
  }

  async personalFileDetail(fileId: string): Promise<any> {
    return this.request(`/api/files/${encodeURIComponent(fileId)}`);
  }

  async renameManagedFile(fileId: string, filename: string, expectedFilename: string): Promise<any> {
    return this.request(`/api/files/${encodeURIComponent(fileId)}`, {
      method: "PATCH", body: { filename, expectedFilename },
    });
  }

  async moveManagedFiles(ids: string[], folderId: string | null, expectedFolderIds: Record<string, string | null>): Promise<any> {
    return this.request("/api/files/batch-move", {
      method: "POST", body: { ids, folderId, expectedFolderIds },
    });
  }

  async listPersonalFileTrash(page = 1): Promise<any> {
    return this.request("/api/files/trash/", {
      query: { workspaceId: "personal", page, pageSize: 100 },
    });
  }

  async restorePersonalFiles(ids: string[], expectedTrashedAt: Record<string, string>): Promise<any> {
    return this.request("/api/files/trash/restore", {
      method: "POST", query: { workspaceId: "personal" }, body: { ids, expectedTrashedAt },
    });
  }

  async saveTaskAsNote(taskId: string, body: {
    requestId: string; notebookId: string; title: string; description: string; expectedTaskUpdatedAt: string; expectedTaskTitle: string; expectedTaskDescription: string;
  }): Promise<any> {
    return this.request(`/api/tasks/${encodeURIComponent(taskId)}/note`, {
      method: "POST", query: { workspaceId: "personal" }, body,
    });
  }

  // ==================== 搜索 ====================

  /** 全文搜索笔记 */
  async search(q: string): Promise<any[]> {
    return this.request("/api/search", { query: { q } });
  }

  // ==================== 附件 / 文件 ====================

  /** 上传附件；传 noteId 时绑定笔记，否则上传到文件管理。 */
  async uploadAttachment(params: {
    filePath: string;
    noteId?: string;
    filename?: string;
    mimeType?: string;
    workspaceId?: string;
    folderId?: string;
  }): Promise<AttachmentUploadResult> {
    const filename = params.filename || path.basename(params.filePath);
    const mimeType = params.mimeType || this.inferMimeType(filename);
    const bytes = await readFile(params.filePath);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

    if (params.noteId) {
      form.append("noteId", params.noteId);
      return this.multipartRequest<AttachmentUploadResult>("/api/attachments", form);
    }

    if (params.folderId) {
      form.append("folderId", params.folderId);
    }
    return this.multipartRequest<AttachmentUploadResult>("/api/files/upload", form, {
      workspaceId: params.workspaceId,
    });
  }

  /** 列出文件管理中的附件。 */
  async listAttachments(params?: {
    category?: "all" | "image" | "file";
    filter?: "unreferenced" | "myUploads";
    myUploadsRef?: "referenced" | "unreferenced";
    mime?: string;
    noteId?: string;
    notebookId?: string;
    folderId?: string;
    q?: string;
    page?: number;
    pageSize?: number;
    workspaceId?: string;
  }): Promise<AttachmentListResult> {
    return this.request("/api/files", { query: params });
  }

  /** 获取单个文件详情。 */
  async getAttachmentFile(id: string): Promise<any> {
    return this.request(`/api/files/${id}`);
  }

  /** 把已上传附件以 Markdown 链接插入笔记。 */
  async attachToNote(params: {
    noteId: string;
    attachmentId: string;
    alt?: string;
    mode?: "append" | "prepend" | "replace_marker";
    marker?: string;
  }): Promise<any> {
    const file = await this.getAttachmentFile(params.attachmentId);
    const note = await this.getNote(params.noteId);
    const contentFormat = note.contentFormat || "markdown";
    if (contentFormat !== "markdown") {
      throw new Error(`当前笔记内容格式为 ${contentFormat}，请先转为 markdown 后再插入附件`);
    }

    const markdown = this.buildAttachmentMarkdown(file, params.alt);
    const current = typeof note.content === "string" ? note.content : "";
    const mode = params.mode || "append";
    let nextContent: string;
    if (mode === "prepend") {
      nextContent = current ? `${markdown}\n\n${current}` : markdown;
    } else if (mode === "replace_marker") {
      const marker = params.marker || "";
      if (!marker) throw new Error("replace_marker 模式必须提供 marker");
      if (!current.includes(marker)) throw new Error(`笔记内容中找不到 marker: ${marker}`);
      nextContent = current.replace(marker, markdown);
    } else {
      nextContent = current ? `${current}\n\n${markdown}` : markdown;
    }

    return this.updateNote(params.noteId, {
      content: nextContent,
      contentText: nextContent,
      contentFormat: "markdown",
      version: note.version || 1,
    });
  }

  // ==================== AI ====================

  /** 知识库问答（非流式，收集完整响应） */
  async askKnowledge(question: string): Promise<{ answer: string; references: { id: string; title: string }[] }> {
    await this.ensureAuth();

    const res = await fetch(`${this.baseUrl}/api/ai/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`,
      },
      body: JSON.stringify({ question }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`AI 请求失败 (${res.status}): ${err}`);
    }

    // 解析 SSE 流，收集完整响应
    const text = await res.text();
    const lines = text.split("\n");
    let answer = "";
    let references: { id: string; title: string }[] = [];

    for (const line of lines) {
      if (line.startsWith("event: references")) {
        // 下一行是 data
        continue;
      }
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") break;

        // 尝试解析 references
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed[0]?.id && parsed[0]?.title) {
            references = parsed;
            continue;
          }
          if (parsed && typeof parsed === "object" && typeof parsed.t === "string") {
            answer += parsed.t;
            continue;
          }
          if (parsed && typeof parsed === "object" && typeof parsed.mode === "string") {
            continue;
          }
        } catch {
          // 不是 JSON，是普通文本内容
        }

        answer += data;
      }
    }

    return { answer, references };
  }

  /** AI 写作助手（非流式，收集完整响应） */
  async aiChat(params: {
    action: string;
    text: string;
    context?: string;
    customPrompt?: string;
  }): Promise<string> {
    await this.ensureAuth();

    const res = await fetch(`${this.baseUrl}/api/ai/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`,
      },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`AI 请求失败 (${res.status}): ${err}`);
    }

    // 解析 SSE 流
    const text = await res.text();
    const lines = text.split("\n");
    let result = "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") break;
        result += data;
      }
    }

    return result;
  }

  /** 知识库统计 */
  async knowledgeStats(): Promise<any> {
    return this.request("/api/ai/knowledge-stats");
  }

  // ==================== 插件 ====================

  /** 获取已加载的插件列表 */
  async listPlugins(): Promise<any[]> {
    return this.request("/api/plugins");
  }

  /** 获取 AI/MCP 可发现的已启用 Plugin Actions。 */
  async listPluginActions(): Promise<any[]> {
    return this.request("/api/plugins/actions");
  }

  /** 按稳定的 pluginId + actionId 协议执行。 */
  async executePluginAction(pluginId: string, actionId: string, input: Record<string, any>): Promise<any> {
    return this.request(`/api/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(actionId)}/execute`, {
      method: "POST",
      body: { input },
    });
  }

  async getPluginExecution(executionId: string): Promise<any> {
    return this.request(`/api/plugin-executions/${encodeURIComponent(executionId)}`);
  }

  /** 执行插件 */
  async executePlugin(name: string, params: Record<string, any>): Promise<any> {
    return this.request("/api/plugins/" + name + "/execute", {
      method: "POST",
      body: params,
    });
  }

  // ==================== 自动化 ====================

  async getWorkflow(workflowId: string): Promise<any> {
    return this.request(`/api/automations/${encodeURIComponent(workflowId)}`);
  }

  async createWorkflow(body: Record<string, unknown>): Promise<any> {
    return this.request("/api/automations", { method: "POST", body });
  }

  async updateWorkflow(workflowId: string, body: Record<string, unknown>): Promise<any> {
    return this.request(`/api/automations/${encodeURIComponent(workflowId)}`, { method: "PUT", body });
  }

  async setWorkflowEnabled(workflowId: string, enabled: boolean, expectedRevision: string): Promise<any> {
    return this.request(`/api/automations/${encodeURIComponent(workflowId)}/${enabled ? "enable" : "disable"}`,
      { method: "POST", body: { expectedRevision } });
  }

  async deleteWorkflow(workflowId: string, expectedRevision: string): Promise<any> {
    return this.request(`/api/automations/${encodeURIComponent(workflowId)}`,
      { method: "DELETE", body: { expectedRevision, confirmation: "DELETE_WORKFLOW" } });
  }

  async listWorkflowRuns(workflowId: string): Promise<any> {
    return this.request(`/api/automations/${encodeURIComponent(workflowId)}/runs`);
  }

  async listWorkflows(): Promise<any[]> {
    return this.request("/api/automations");
  }

  async runWorkflow(workflowId: string): Promise<any> {
    return this.request(`/api/automations/${encodeURIComponent(workflowId)}/run`, { method: "POST" });
  }

  async getWorkflowRun(runId: string): Promise<any> {
    return this.request(`/api/automations/runs/${encodeURIComponent(runId)}`);
  }

  // ==================== Webhook ====================

  /** 获取 Webhook 列表 */
  async listWebhooks(): Promise<any[]> {
    return this.request("/api/webhooks");
  }

  /** 创建 Webhook */
  async createWebhook(params: { url: string; events?: string[]; description?: string }): Promise<any> {
    return this.request("/api/webhooks", { method: "POST", body: params });
  }

  // ==================== 审计日志 ====================

  /** 查询审计日志 */
  async queryAuditLogs(params?: Record<string, string>): Promise<any> {
    return this.request("/api/audit", { query: params });
  }

  /** 审计统计 */
  async getAuditStats(): Promise<any> {
    return this.request("/api/audit/stats");
  }

  // ==================== 备份 ====================

  /** 获取备份列表 */
  async listBackups(): Promise<any[]> {
    return this.request("/api/backups");
  }

  /** 创建备份 */
  async createBackup(type: string = "db-only"): Promise<any> {
    return this.request("/api/backups", { method: "POST", body: { type } });
  }
}
