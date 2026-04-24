/**
 * 与 nowen-note 后端的 HTTP 交互。
 *
 * 认证方式：用户名 + 密码登录获取 JWT，后续通过 Authorization: Bearer <JWT> 认证。
 *
 * 接口：
 *   - POST /api/auth/login       用户名密码登录，获取 JWT
 *   - GET  /api/me               验证 token 有效性 + 获取用户信息
 *   - POST /api/export/import    批量导入笔记
 *   - GET  /api/notebooks        列出可选笔记本
 */
import { normalizeBaseUrl, type NowenClipperConfig } from "./storage";

export interface ImportNotePayload {
  title: string;
  /** HTML 字符串。若 outputFormat=markdown，服务端不解析图片 data URI——所以我们走"HTML 里嵌 data:image" 的老路 */
  content: string;
  contentText: string;
  /** 可选：按路径归属到某笔记本（从根到叶） */
  notebookPath?: string[];
  /** 单层向后兼容 */
  notebookName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ImportResponse {
  success: boolean;
  count: number;
  notebookId: string;
  notebookIds: string[];
  notes: { id: string; title: string; notebookId: string }[];
}

export interface LoginResponse {
  token: string;
  user: {
    id: string;
    username: string;
    email: string | null;
    avatarUrl: string | null;
    displayName: string | null;
    role: string;
    createdAt: string;
    mustChangePassword?: boolean;
  };
  /** 若用户开启了 2FA，返回此字段而非 token */
  requires2FA?: boolean;
  ticket?: string;
}

export class NowenApiError extends Error {
  constructor(
    public status: number,
    public code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "NowenApiError";
  }
}

function authHeaders(cfg: NowenClipperConfig): HeadersInit {
  return {
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
  };
}

async function parseErr(res: Response): Promise<NowenApiError> {
  let code: string | undefined;
  let message = res.statusText;
  try {
    const data = (await res.json()) as { error?: string; code?: string };
    code = data.code;
    if (data.error) message = data.error;
  } catch {
    try {
      message = (await res.text()) || message;
    } catch {
      /* ignore */
    }
  }
  return new NowenApiError(res.status, code, `[${res.status}] ${message}`);
}

/**
 * 登录：POST /api/auth/login
 * 返回 JWT token 和用户信息。
 * 注意：如果用户开启了 2FA，返回 requires2FA=true + ticket，需要额外处理。
 */
export async function login(
  serverUrl: string,
  username: string,
  password: string,
): Promise<LoginResponse> {
  const base = normalizeBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as LoginResponse;
}

/**
 * 2FA 验证：POST /api/auth/2fa/verify
 * 登录第二步：凭 ticket + TOTP 码换取真正的 login token。
 */
export async function verify2FA(
  serverUrl: string,
  ticket: string,
  code: string,
): Promise<LoginResponse> {
  const base = normalizeBaseUrl(serverUrl);
  const res = await fetch(`${base}/api/auth/2fa/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket, code }),
  });
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as LoginResponse;
}

/** 探活 + token 校验：GET /api/me 成功即代表 token 有效 */
export async function ping(cfg: NowenClipperConfig): Promise<{ username: string; role: string }> {
  const base = normalizeBaseUrl(cfg.serverUrl);
  const res = await fetch(`${base}/api/me`, {
    method: "GET",
    headers: authHeaders(cfg),
  });
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as { username: string; role: string };
}

/** 获取笔记本树（打平过的列表） */
export async function listNotebooks(
  cfg: NowenClipperConfig,
): Promise<Array<{ id: string; name: string; parentId: string | null }>> {
  const base = normalizeBaseUrl(cfg.serverUrl);
  const res = await fetch(`${base}/api/notebooks`, { headers: authHeaders(cfg) });
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as Array<{ id: string; name: string; parentId: string | null }>;
}

/**
 * 导入一条笔记。
 *
 * 关键点：我们提交的 content 是 HTML；后端 `export/import` 路由会自动调用
 * `extractInlineBase64Images` 把 <img src="data:image/..."> 抽成 /api/attachments/<id>，
 * 因此"图片随正文一起提交"对调用方是零感知的。
 */
export async function importNote(
  cfg: NowenClipperConfig,
  payload: ImportNotePayload,
): Promise<ImportResponse> {
  const base = normalizeBaseUrl(cfg.serverUrl);
  const body: Record<string, unknown> = {
    notes: [
      {
        title: payload.title,
        content: payload.content,
        contentText: payload.contentText,
        notebookName: payload.notebookName,
        notebookPath: payload.notebookPath,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      },
    ],
  };
  // 如果 payload 给了 notebookName 作为全局归属（优先级更高）
  if (payload.notebookName && !payload.notebookPath) {
    body.notebookName = payload.notebookName;
  }

  const res = await fetch(`${base}/api/export/import`, {
    method: "POST",
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as ImportResponse;
}
