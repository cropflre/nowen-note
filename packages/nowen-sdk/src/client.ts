/**
 * Nowen Note SDK 客户端
 *
 * 完整封装 Nowen Note 后端所有 REST API，支持：
 * - 笔记本/笔记/标签/任务/思维导图/日记 CRUD
 * - AI 写作助手 + 知识库问答
 * - 全文搜索
 * - 分享管理
 * - 导出
 * - 系统设置
 */

import type { NowenConfig, Notebook, CreateNotebookParams, UpdateNotebookParams, Note, NoteSummary, ListNotesParams, CreateNoteParams, UpdateNoteParams, Tag, CreateTagParams, Task, TaskStats, ListTasksParams, CreateTaskParams, UpdateTaskParams, MindMap, CreateMindMapParams, UpdateMindMapParams, AIChatParams, AIAskResult, AISettings, KnowledgeStats, SearchResult, SystemSettings, ExportFormat, DiaryTimeline } from "./types.js";

/** 登录结果：要么直接拿到 token，要么需要两步验证 */
export type LoginResult =
  | { requires2FA: false; token: string }
  | { requires2FA: true; ticket: string; username: string };

/** 服务端返回的用户对象 */
export interface AuthUser {
  id: string;
  username: string;
  displayName?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  role?: string;
  isDemo?: boolean;
  createdAt?: string;
}

export class NowenClient {
  private baseUrl: string;
  private username: string;
  private password: string;
  private timeout: number;
  private token: string | null = null;
  private _fetch: typeof fetch;

  constructor(config: NowenConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.timeout = config.timeout || 30000;
    // ⚠️ 必须 bind：`globalThis.fetch` 直接取出来调用会丢失 this，
    //    浏览器里报 "Failed to execute 'fetch' on 'Window': Illegal invocation"。
    this._fetch = config.fetch || globalThis.fetch.bind(globalThis);
  }

  // ==================== 内部方法 ====================

  /**
   * 登录。
   *
   * 返回两种结果：
   *   · { requires2FA: false } —— 已拿到 token，后续请求直接可用
   *   · { requires2FA: true, ticket } —— 账号开了两步验证，
   *     需要再调 verifyTwoFactor(ticket, code)
   *
   * 浏览器里请用这个公开方法（原来的实现是 private，宿主 App 只能靠构造函数
   * 塞用户名密码，而那在浏览器里根本走不通）。
   */
  async login(
    username: string = this.username,
    password: string = this.password,
  ): Promise<LoginResult> {
    const res = await this._fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`登录失败 (${res.status}): ${err}`);
    }
    const data = (await res.json()) as {
      token?: string;
      requires2FA?: boolean;
      ticket?: string;
      username?: string;
    };
    if (data.requires2FA) {
      return {
        requires2FA: true,
        ticket: data.ticket || "",
        username: data.username || username,
      };
    }
    this.username = username;
    this.password = password;
    this.token = data.token ?? null;
    return { requires2FA: false, token: data.token || "" };
  }

  /**
   * 用登录返回的 ticket + 动态验证码换取 token。
   * 支持验证器 6 位动态码，也支持一次性备用码。
   */
  async verifyTwoFactor(ticket: string, code: string): Promise<{ token: string }> {
    const res = await this._fetch(`${this.baseUrl}/api/auth/2fa/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, code }),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`两步验证失败 (${res.status}): ${err}`);
    }
    const data = (await res.json()) as { token?: string };
    this.token = data.token ?? null;
    return { token: data.token || "" };
  }

  /**
   * 写入一个已有 token（宿主 App 自己管登录态时用，例如移动端把 token
   * 存在安全存储里、启动时直接恢复）。
   */
  setToken(token: string | null): void {
    this.token = token;
  }

  /** 读当前 token（不暴露内部字段） */
  getToken(): string | null {
    return this.token;
  }

  /** 确保已认证 */
  private async ensureAuth(): Promise<void> {
    if (this.token) return;
    // ⚠️ 没有 token 且没有可用凭据时，要**明确报错**，不要拿着构造函数里
    //    可能是占位值的用户名密码去"悄悄登录" —— 那会把"未登录"伪装成
    //    "网络错误 / 401"，排查方向完全被带偏。
    if (!this.username || !this.password) {
      throw new Error(
        "未登录：请先调用 login() 拿到 token 并用 setToken() 写入（两步验证账号还需 verifyTwoFactor()）",
      );
    }
    await this.login();
  }

  /** 通用 API 请求方法 */
  private async request<T = any>(
    path: string,
    options: {
      method?: string;
      body?: any;
      query?: Record<string, string | undefined>;
      raw?: boolean;
    } = {}
  ): Promise<T> {
    await this.ensureAuth();

    let url = `${this.baseUrl}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null && v !== "") params.set(k, v);
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${this.token}`,
    };
    if (options.body && !options.raw) {
      headers["Content-Type"] = "application/json";
    }

    const fetchOpts: RequestInit = {
      method: options.method || "GET",
      headers,
      signal: AbortSignal.timeout(this.timeout),
    };

    if (options.body) {
      fetchOpts.body = options.raw ? options.body : JSON.stringify(options.body);
    }

    let res = await this._fetch(url, fetchOpts);

    // Token 过期自动重试
    if (res.status === 401) {
      this.token = null;
      await this.login();
      (fetchOpts.headers as Record<string, string>)["Authorization"] = `Bearer ${this.token}`;
      res = await this._fetch(url, fetchOpts);
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API 请求失败 (${res.status}): ${err}`);
    }

    return res.json() as Promise<T>;
  }

  /** 读取 SSE 流并收集为完整文本 */
  private async readSSEStream(path: string, body: any): Promise<{ text: string; metadata?: any }> {
    await this.ensureAuth();

    const res = await this._fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API 请求失败 (${res.status}): ${err}`);
    }

    const responseText = await res.text();
    const lines = responseText.split("\n");
    let result = "";
    let metadata: any = undefined;

    for (const line of lines) {
      if (line.startsWith("event: references")) continue;
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data === "[DONE]") break;
        try {
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed) && parsed[0]?.id && parsed[0]?.title) {
            metadata = parsed;
            continue;
          }
          if (parsed && typeof parsed === "object" && typeof parsed.t === "string") {
            result += parsed.t;
            continue;
          }
          if (parsed && typeof parsed === "object" && typeof parsed.mode === "string") {
            continue;
          }
        } catch { /* 普通文本 */ }
        result += data;
      }
    }

    return { text: result, metadata };
  }

  // ==================== 笔记本 ====================

  /** 获取所有笔记本 */
  async listNotebooks(): Promise<Notebook[]> {
    return this.request("/api/notebooks");
  }

  /** 创建笔记本 */
  async createNotebook(params: CreateNotebookParams): Promise<Notebook> {
    return this.request("/api/notebooks", { method: "POST", body: params });
  }

  /** 更新笔记本 */
  async updateNotebook(id: string, params: UpdateNotebookParams): Promise<Notebook> {
    return this.request(`/api/notebooks/${id}`, { method: "PUT", body: params });
  }

  /** 删除笔记本 */
  async deleteNotebook(id: string): Promise<void> {
    return this.request(`/api/notebooks/${id}`, { method: "DELETE" });
  }

  // ==================== 笔记 ====================

  /** 获取笔记列表 */
  async listNotes(params?: ListNotesParams): Promise<NoteSummary[]> {
    const query: Record<string, string | undefined> = {};
    if (params?.notebookId) query.notebookId = params.notebookId;
    if (params?.isFavorite) query.isFavorite = "1";
    if (params?.isTrashed) query.isTrashed = "1";
    if (params?.tagId) query.tagId = params.tagId;
    if (params?.search) query.search = params.search;
    if (params?.dateFrom) query.dateFrom = params.dateFrom;
    if (params?.dateTo) query.dateTo = params.dateTo;
    return this.request("/api/notes", { query });
  }

  /** 获取单个笔记（完整内容） */
  async getNote(id: string): Promise<Note> {
    return this.request(`/api/notes/${id}`);
  }

  /** 创建笔记 */
  async createNote(params: CreateNoteParams): Promise<Note> {
    return this.request("/api/notes", { method: "POST", body: params });
  }

  /** 更新笔记 */
  async updateNote(id: string, params: UpdateNoteParams): Promise<Note> {
    return this.request(`/api/notes/${id}`, { method: "PUT", body: params });
  }

  /** 删除笔记（永久） */
  async deleteNote(id: string): Promise<void> {
    return this.request(`/api/notes/${id}`, { method: "DELETE" });
  }

  /** 移入回收站（软删除） */
  async trashNote(id: string): Promise<Note> {
    return this.updateNote(id, { isTrashed: 1 });
  }

  /** 从回收站恢复 */
  async restoreNote(id: string): Promise<Note> {
    return this.updateNote(id, { isTrashed: 0 });
  }

  /** 收藏/取消收藏 */
  async toggleFavorite(id: string, isFavorite: boolean): Promise<Note> {
    return this.updateNote(id, { isFavorite: isFavorite ? 1 : 0 });
  }

  /** 置顶/取消置顶 */
  async togglePin(id: string, isPinned: boolean): Promise<Note> {
    return this.updateNote(id, { isPinned: isPinned ? 1 : 0 });
  }

  // ==================== 标签 ====================

  /** 获取所有标签 */
  async listTags(): Promise<Tag[]> {
    return this.request("/api/tags");
  }

  /** 创建标签 */
  async createTag(params: CreateTagParams): Promise<Tag> {
    return this.request("/api/tags", { method: "POST", body: params });
  }

  /** 给笔记添加标签 */
  async addTagToNote(noteId: string, tagId: string): Promise<void> {
    return this.request(`/api/tags/note/${noteId}/tag/${tagId}`, { method: "POST" });
  }

  /** 移除笔记标签 */
  async removeTagFromNote(noteId: string, tagId: string): Promise<void> {
    return this.request(`/api/tags/note/${noteId}/tag/${tagId}`, { method: "DELETE" });
  }

  // ==================== 任务 ====================

  /** 获取任务列表 */
  async listTasks(params?: ListTasksParams): Promise<Task[]> {
    const query: Record<string, string | undefined> = {};
    if (params?.status) query.status = params.status;
    if (params?.priority) query.priority = params.priority;
    if (params?.noteId) query.noteId = params.noteId;
    return this.request("/api/tasks", { query });
  }

  /** 获取任务统计 */
  async getTaskStats(): Promise<TaskStats> {
    return this.request("/api/tasks/stats/summary");
  }

  /** 获取单个任务 */
  async getTask(id: string): Promise<Task> {
    return this.request(`/api/tasks/${id}`);
  }

  /** 创建任务 */
  async createTask(params: CreateTaskParams): Promise<Task> {
    return this.request("/api/tasks", { method: "POST", body: params });
  }

  /** 更新任务 */
  async updateTask(id: string, params: UpdateTaskParams): Promise<Task> {
    return this.request(`/api/tasks/${id}`, { method: "PUT", body: params });
  }

  /** 切换任务完成状态 */
  async toggleTask(id: string): Promise<Task> {
    return this.request(`/api/tasks/${id}/toggle`, { method: "PATCH" });
  }

  /** 删除任务 */
  async deleteTask(id: string): Promise<void> {
    return this.request(`/api/tasks/${id}`, { method: "DELETE" });
  }

  // ==================== 思维导图 ====================

  /** 获取思维导图列表 */
  async listMindMaps(): Promise<MindMap[]> {
    return this.request("/api/mindmaps");
  }

  /** 获取单个思维导图 */
  async getMindMap(id: string): Promise<MindMap> {
    return this.request(`/api/mindmaps/${id}`);
  }

  /** 创建思维导图 */
  async createMindMap(params: CreateMindMapParams): Promise<MindMap> {
    return this.request("/api/mindmaps", { method: "POST", body: params });
  }

  /** 更新思维导图 */
  async updateMindMap(id: string, params: UpdateMindMapParams): Promise<MindMap> {
    return this.request(`/api/mindmaps/${id}`, { method: "PUT", body: params });
  }

  /** 删除思维导图 */
  async deleteMindMap(id: string): Promise<void> {
    return this.request(`/api/mindmaps/${id}`, { method: "DELETE" });
  }

  // ==================== 日记 ====================

  /** 获取日记列表 */
  /**
   * 拉说说时间线。
   *
   * ⚠️ 服务端没有 `GET /api/diary` 这个列表端点（那是 POST 创建用的），
   *    真实的时间线端点是 `GET /api/diary/timeline`，返回
   *    `{ items, hasMore, nextCursor }` —— 原实现必 404。
   */
  async listDiaries(params?: {
    cursor?: string;
    limit?: number;
  }): Promise<DiaryTimeline> {
    return this.request("/api/diary/timeline", {
      // request() 的 query 只接受字符串，数字要自己转
      query: {
        cursor: params?.cursor,
        limit: params?.limit !== undefined ? String(params.limit) : undefined,
      },
    });
  }

  // ==================== 搜索 ====================

  /** 全文搜索笔记 */
  async search(query: string): Promise<SearchResult[]> {
    return this.request("/api/search", { query: { q: query } });
  }

  // ==================== AI ====================

  /** AI 写作助手（收集完整结果） */
  async aiChat(params: AIChatParams): Promise<string> {
    const { text } = await this.readSSEStream("/api/ai/chat", params);
    return text;
  }

  /** 知识库问答（收集完整结果） */
  async aiAsk(question: string): Promise<AIAskResult> {
    const { text, metadata } = await this.readSSEStream("/api/ai/ask", { question });
    return {
      answer: text,
      references: metadata || [],
    };
  }

  /** 获取 AI 设置 */
  async getAISettings(): Promise<AISettings> {
    return this.request("/api/ai/settings");
  }

  /** 更新 AI 设置 */
  async updateAISettings(settings: Partial<AISettings>): Promise<void> {
    return this.request("/api/ai/settings", { method: "PUT", body: settings });
  }

  /** 测试 AI 连接 */
  async testAIConnection(): Promise<{ success: boolean; model: string; message: string }> {
    return this.request("/api/ai/test", { method: "POST" });
  }

  /** 获取可用 AI 模型列表 */
  async listAIModels(): Promise<string[]> {
    return this.request("/api/ai/models");
  }

  /** 知识库统计 */
  async getKnowledgeStats(): Promise<KnowledgeStats> {
    return this.request("/api/ai/knowledge-stats");
  }

  // ==================== 导出 ====================

  /** 导出笔记 */
  async exportNote(noteId: string, format: ExportFormat = "markdown"): Promise<string> {
    return this.request(`/api/export/${noteId}`, { query: { format } });
  }

  // ==================== 系统设置 ====================

  /** 获取系统设置 */
  async getSettings(): Promise<SystemSettings> {
    return this.request("/api/settings");
  }

  /** 更新系统设置 */
  async updateSettings(settings: Record<string, string>): Promise<void> {
    return this.request("/api/settings", { method: "PUT", body: settings });
  }

  // ==================== 认证 ====================

  /**
   * 验证 Token 有效性。
   *
   * ⚠️ 服务端返回的是 `{ user: { id, username, displayName, ... } }`，
   *    不是 `{ valid, userId, username }` —— 原类型会让 `info.valid` 恒为
   *    undefined，宿主一律判成"会话已失效"（真实项目里踩到过）。
   */
  async verifyToken(): Promise<{ user: AuthUser }> {
    return this.request("/api/auth/verify");
  }

  /** 修改密码 */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    return this.request("/api/auth/change-password", {
      method: "POST",
      body: { oldPassword, newPassword },
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

  /** 更新 Webhook */
  async updateWebhook(id: string, params: Record<string, any>): Promise<any> {
    return this.request(`/api/webhooks/${id}`, { method: "PUT", body: params });
  }

  /** 删除 Webhook */
  async deleteWebhook(id: string): Promise<void> {
    return this.request(`/api/webhooks/${id}`, { method: "DELETE" });
  }

  /** 发送 Webhook 测试事件 */
  async testWebhook(id: string): Promise<any> {
    return this.request(`/api/webhooks/${id}/test`, { method: "POST" });
  }

  /** 查看 Webhook 投递日志 */
  async getWebhookDeliveries(id: string): Promise<any[]> {
    return this.request(`/api/webhooks/${id}/deliveries`);
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

  /** 清理过期审计日志 */
  async cleanupAuditLogs(retentionDays?: number): Promise<any> {
    return this.request("/api/audit/cleanup", { method: "POST", body: { retentionDays } });
  }

  // ==================== 备份恢复 ====================

  /** 获取备份列表 */
  async listBackups(): Promise<any[]> {
    return this.request("/api/backups");
  }

  /** 创建备份 */
  async createBackup(type: string = "db-only", description?: string): Promise<any> {
    return this.request("/api/backups", { method: "POST", body: { type, description } });
  }

  /** 从备份恢复 */
  async restoreBackup(filename: string): Promise<any> {
    return this.request(`/api/backups/${filename}/restore`, { method: "POST" });
  }

  /** 删除备份 */
  async deleteBackup(filename: string): Promise<void> {
    return this.request(`/api/backups/${filename}`, { method: "DELETE" });
  }

  /** 启动/停止自动备份 */
  async setAutoBackup(enabled: boolean, intervalHours?: number): Promise<any> {
    return this.request("/api/backups/auto", { method: "POST", body: { enabled, intervalHours } });
  }
}

// 导入 DiaryEntry 类型
import type { DiaryEntry } from "./types.js";
