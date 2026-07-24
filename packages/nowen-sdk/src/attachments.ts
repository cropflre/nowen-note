import type { NowenConfig } from "./types.js";

export type AttachmentCategory = "image" | "file";
export type AttachmentInsertMode = "append" | "prepend" | "replace_marker";

export interface AttachmentUploadResult {
  id: string;
  url: string;
  mimeType: string;
  size: number;
  filename: string;
  category: AttachmentCategory;
  createdAt?: string;
  deduplicated?: boolean;
  accessUrls?: Record<string, string>;
}

export interface AttachmentPrimaryNote {
  id: string;
  title: string;
  notebookId: string | null;
  notebookName: string | null;
  notebookIcon: string | null;
  isTrashed: number;
}

export interface AttachmentReference extends AttachmentPrimaryNote {
  updatedAt: string;
  isPrimary: boolean;
}

export interface AttachmentFile {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
  category: AttachmentCategory;
  url: string;
  thumbnailUrl?: string;
  hash: string | null;
  folderId: string | null;
  folderName: string | null;
  primaryNote: AttachmentPrimaryNote | null;
  references?: AttachmentReference[];
  accessUrls?: Record<string, string>;
}

export interface AttachmentListResponse {
  items: AttachmentFile[];
  total: number;
  page: number;
  pageSize: number;
  accessUrls?: Record<string, string>;
}

export interface UploadAttachmentParams {
  file: Blob | ArrayBuffer | Uint8Array;
  filename: string;
  mimeType?: string;
  noteId?: string;
  workspaceId?: string;
  folderId?: string;
}

export interface ListAttachmentsParams {
  category?: "all" | AttachmentCategory;
  filter?: "unreferenced" | "myUploads";
  myUploadsRef?: "referenced" | "unreferenced";
  mime?: string;
  noteId?: string;
  notebookId?: string;
  folderId?: string;
  q?: string;
  sort?: "created_desc" | "created_asc" | "name_asc" | "name_desc" | "size_asc" | "size_desc";
  page?: number;
  pageSize?: number;
  workspaceId?: string;
}

export interface AttachToNoteParams {
  noteId: string;
  attachmentId: string;
  alt?: string;
  mode?: AttachmentInsertMode;
  marker?: string;
}

type QueryValue = string | number | boolean | undefined | null;

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/([\\\[\]])/g, "\\$1")
    .trim();
}

function toBlob(file: UploadAttachmentParams["file"], mimeType: string): Blob {
  if (file instanceof Blob) {
    if (file.type || !mimeType) return file;
    return new Blob([file], { type: mimeType });
  }
  if (file instanceof Uint8Array) {
    // Uint8Array may be backed by SharedArrayBuffer, which is not a valid DOM BlobPart.
    // Copy it into a fresh ArrayBuffer to keep the public Node/browser contract type-safe.
    const bytes = new Uint8Array(file.byteLength);
    bytes.set(file);
    return new Blob([bytes.buffer], { type: mimeType });
  }
  return new Blob([file], { type: mimeType });
}

/**
 * Attachment-focused SDK client.
 *
 * It intentionally reuses the public REST contract instead of browser-only editor helpers, so the
 * same code works in Node.js, Electron, browser workers and automation runtimes. The regular
 * `NowenClient` remains backward compatible; projects that need binary APIs can instantiate this
 * client with the same `NowenConfig`.
 */
export class NowenAttachmentClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;
  private token: string | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(config: NowenConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.timeout = config.timeout || 30_000;
    this.fetchImpl = config.fetch || globalThis.fetch;
  }

  private async login(): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal: AbortSignal.timeout(this.timeout),
    });
    if (!response.ok) {
      throw new Error(`登录失败 (${response.status}): ${await response.text()}`);
    }
    const payload = await response.json() as { token?: string };
    if (!payload.token) throw new Error("登录响应缺少 token");
    this.token = payload.token;
  }

  private async ensureAuth(): Promise<void> {
    if (this.token) return;
    if (!this.loginPromise) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private async authorizedJson<T>(
    path: string,
    initFactory: (token: string) => RequestInit,
    query?: Record<string, QueryValue>,
  ): Promise<T> {
    await this.ensureAuth();
    const url = this.buildUrl(path, query);
    let response = await this.fetchImpl(url, initFactory(this.token!));
    if (response.status === 401) {
      this.token = null;
      await this.ensureAuth();
      response = await this.fetchImpl(url, initFactory(this.token!));
    }
    if (!response.ok) {
      throw new Error(`附件 API 请求失败 (${response.status}): ${await response.text()}`);
    }
    return response.json() as Promise<T>;
  }

  async uploadAttachment(params: UploadAttachmentParams): Promise<AttachmentUploadResult> {
    if (!params.filename.trim()) throw new Error("filename 不能为空");
    const mimeType = params.mimeType || "application/octet-stream";
    const blob = toBlob(params.file, mimeType);
    const path = params.noteId ? "/api/attachments" : "/api/files/upload";

    return this.authorizedJson<AttachmentUploadResult>(
      path,
      (token) => {
        const form = new FormData();
        form.append("file", blob, params.filename);
        if (params.noteId) form.append("noteId", params.noteId);
        if (!params.noteId && params.folderId) form.append("folderId", params.folderId);
        return {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
          signal: AbortSignal.timeout(this.timeout),
        };
      },
      params.noteId ? undefined : { workspaceId: params.workspaceId },
    );
  }

  async listAttachments(params: ListAttachmentsParams = {}): Promise<AttachmentListResponse> {
    return this.authorizedJson<AttachmentListResponse>(
      "/api/files",
      (token) => ({
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeout),
      }),
      params as Record<string, QueryValue>,
    );
  }

  async getAttachment(id: string): Promise<AttachmentFile> {
    return this.authorizedJson<AttachmentFile>(
      `/api/files/${encodeURIComponent(id)}`,
      (token) => ({
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(this.timeout),
      }),
    );
  }

  async attachToNote(params: AttachToNoteParams): Promise<Record<string, unknown>> {
    const [attachment, note] = await Promise.all([
      this.getAttachment(params.attachmentId),
      this.authorizedJson<Record<string, any>>(
        `/api/notes/${encodeURIComponent(params.noteId)}`,
        (token) => ({
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(this.timeout),
        }),
      ),
    ]);

    const contentFormat = String(note.contentFormat || "markdown");
    if (contentFormat !== "markdown") {
      throw new Error(`当前笔记内容格式为 ${contentFormat}，附件自动插入目前仅支持 Markdown 笔记`);
    }

    const label = escapeMarkdownLabel(params.alt || attachment.filename || attachment.id) || attachment.id;
    const targetUrl = attachment.url || `/api/attachments/${attachment.id}`;
    const markdown = attachment.category === "image" || attachment.mimeType.toLowerCase().startsWith("image/")
      ? `![${label}](${targetUrl})`
      : `[${label}](${targetUrl}${targetUrl.includes("?") ? "&" : "?"}download=1)`;
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

    return this.authorizedJson<Record<string, unknown>>(
      `/api/notes/${encodeURIComponent(params.noteId)}`,
      (token) => ({
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content: nextContent,
          contentFormat: "markdown",
          version: Number(note.version) || 1,
        }),
        signal: AbortSignal.timeout(this.timeout),
      }),
    );
  }
}
