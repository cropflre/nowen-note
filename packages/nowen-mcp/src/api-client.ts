/**
 * Nowen Note API 客户端
 * 封装对 Nowen Note 后端 REST API 的调用
 */

import { readFile } from "node:fs/promises";
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
  }

  /** 登录获取 JWT Token */
  private async login(): Promise<void> {
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
  }): Promise<any> {
    return this.request(`/api/notes/${id}`, { method: "PUT", body: params });
  }

  /** 删除笔记（永久） */
  async deleteNote(id: string): Promise<any> {
    return this.request(`/api/notes/${id}`, { method: "DELETE" });
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

  /** 执行插件 */
  async executePlugin(name: string, params: Record<string, any>): Promise<any> {
    return this.request("/api/plugins/" + name + "/execute", {
      method: "POST",
      body: params,
    });
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
