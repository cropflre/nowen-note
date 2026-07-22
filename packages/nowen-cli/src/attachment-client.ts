import { readFile } from "node:fs/promises";
import path from "node:path";

export interface AttachmentClientConfig {
  baseUrl: string;
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

export interface AttachmentListResponse {
  items: any[];
  total: number;
  page: number;
  pageSize: number;
}

type QueryValue = string | number | boolean | undefined | null;

export class AttachmentClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private token: string | null = null;

  constructor(config: AttachmentClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
  }

  private async login(): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (!response.ok) throw new Error(`登录失败 (${response.status}): ${await response.text()}`);
    const payload = await response.json() as { token?: string };
    if (!payload.token) throw new Error("登录响应缺少 token");
    this.token = payload.token;
  }

  private async ensureAuth(): Promise<void> {
    if (!this.token) await this.login();
  }

  private buildUrl(pathname: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async request<T>(
    pathname: string,
    options: { method?: string; body?: unknown; query?: Record<string, QueryValue> } = {},
  ): Promise<T> {
    await this.ensureAuth();
    const url = this.buildUrl(pathname, options.query);
    const send = () => fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    let response = await send();
    if (response.status === 401) {
      this.token = null;
      await this.login();
      response = await send();
    }
    if (!response.ok) {
      throw new Error(`附件 API 错误 (${response.status}): ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  private async uploadForm<T>(
    pathname: string,
    createForm: () => FormData,
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    await this.ensureAuth();
    const url = this.buildUrl(pathname, query);
    const send = () => fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: createForm(),
    });

    let response = await send();
    if (response.status === 401) {
      this.token = null;
      await this.login();
      response = await send();
    }
    if (!response.ok) {
      throw new Error(`附件上传失败 (${response.status}): ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  private inferMimeType(filename: string): string {
    switch (path.extname(filename).toLowerCase()) {
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

  private buildMarkdown(file: any, alt?: string): string {
    const label = String(alt || file.filename || file.id)
      .replace(/[\r\n]+/g, " ")
      .replace(/([\\\[\]])/g, "\\$1")
      .trim();
    const url = file.url || `/api/attachments/${file.id}`;
    const image = file.category === "image" || String(file.mimeType || "").toLowerCase().startsWith("image/");
    return image
      ? `![${label}](${url})`
      : `[${label}](${url}${url.includes("?") ? "&" : "?"}download=1)`;
  }

  async upload(params: {
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
    const createForm = () => {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
      if (params.noteId) form.append("noteId", params.noteId);
      if (!params.noteId && params.folderId) form.append("folderId", params.folderId);
      return form;
    };

    if (params.noteId) return this.uploadForm("/api/attachments", createForm);
    return this.uploadForm("/api/files/upload", createForm, { workspaceId: params.workspaceId });
  }

  async list(params: {
    category?: "all" | "image" | "file";
    filter?: "unreferenced" | "myUploads";
    myUploadsRef?: "referenced" | "unreferenced";
    mime?: string;
    noteId?: string;
    notebookId?: string;
    folderId?: string;
    q?: string;
    sort?: string;
    page?: number;
    pageSize?: number;
    workspaceId?: string;
  } = {}): Promise<AttachmentListResponse> {
    return this.request("/api/files", { query: params as Record<string, QueryValue> });
  }

  async get(id: string): Promise<any> {
    return this.request(`/api/files/${encodeURIComponent(id)}`);
  }

  async attach(params: {
    noteId: string;
    attachmentId: string;
    alt?: string;
    mode?: "append" | "prepend" | "replace_marker";
    marker?: string;
  }): Promise<any> {
    const [file, note] = await Promise.all([
      this.get(params.attachmentId),
      this.request<any>(`/api/notes/${encodeURIComponent(params.noteId)}`),
    ]);
    const format = note.contentFormat || "markdown";
    if (format !== "markdown") {
      throw new Error(`当前笔记内容格式为 ${format}，附件自动插入目前仅支持 Markdown 笔记`);
    }

    const markdown = this.buildMarkdown(file, params.alt);
    const current = typeof note.content === "string" ? note.content : "";
    const mode = params.mode || "append";
    let content: string;
    if (mode === "prepend") {
      content = current ? `${markdown}\n\n${current}` : markdown;
    } else if (mode === "replace_marker") {
      const marker = params.marker || "";
      if (!marker) throw new Error("replace_marker 模式必须提供 marker");
      if (!current.includes(marker)) throw new Error(`笔记内容中找不到 marker: ${marker}`);
      content = current.replace(marker, markdown);
    } else {
      content = current ? `${current}\n\n${markdown}` : markdown;
    }

    return this.request(`/api/notes/${encodeURIComponent(params.noteId)}`, {
      method: "PUT",
      body: {
        content,
        contentText: content,
        contentFormat: "markdown",
        version: Number(note.version) || 1,
      },
    });
  }
}
