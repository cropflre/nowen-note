/**
 * Nowen Note API 客户端
 * 封装对 Nowen Note 后端 REST API 的调用
 */

export interface NowenApiConfig {
  baseUrl: string;   // 例如 http://localhost:3001
  username: string;
  password: string;
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
      query?: Record<string, string>;
    } = {}
  ): Promise<T> {
    await this.ensureAuth();

    let url = `${this.baseUrl}${path}`;
    if (options.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null && v !== "") {
          params.set(k, v);
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

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
    return this.request("/api/notes", { query: params as Record<string, string> });
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
  }): Promise<any> {
    return this.request("/api/notes", { method: "POST", body: params });
  }

  /** 更新笔记 */
  async updateNote(id: string, params: {
    title?: string;
    content?: string;
    contentText?: string;
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
