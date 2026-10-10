import { normalizeBaseUrl, setConfig, type NowenClipperConfig } from "./storage";

export interface ImportNotePayload {
  title: string;
  content: string;
  contentText: string;
  contentFormat?: "markdown" | "tiptap-json";
  notebookPath?: string[];
  notebookName?: string;
  notebookId?: string;
  workspaceId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ImportResponse {
  success: boolean;
  count: number;
  notebookId: string;
  notebookIds: string[];
  notes: { id: string; title: string; notebookId: string }[];
  workspaceId?: string | null;
}

export interface LoginResponse {
  token: string;
  refreshToken?: string;
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
  requires2FA?: boolean;
  ticket?: string;
  username?: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  icon?: string;
  role: "owner" | "admin" | "editor" | "viewer";
  memberCount?: number;
  notebookCount?: number;
}

export interface NotebookSummary {
  id: string;
  name: string;
  parentId: string | null;
  workspaceId?: string | null;
  userId?: string;
  isDeleted?: number;
}

export interface TagSummary {
  id: string;
  name: string;
  color?: string;
  workspaceId?: string | null;
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

async function requestJson<T>(
  cfg: NowenClipperConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const base = normalizeBaseUrl(cfg.serverUrl);
  const send = () => fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      ...authHeaders(cfg),
      ...(init.headers || {}),
    },
  });

  let res = await send();
  if (res.status === 401 && cfg.refreshToken) {
    await refreshAccessToken(cfg);
    res = await send();
  }
  if (!res.ok) throw await parseErr(res);
  return (await res.json()) as T;
}

const refreshInFlight = new Map<string, Promise<string>>();

async function refreshAccessToken(cfg: NowenClipperConfig): Promise<string> {
  const base = normalizeBaseUrl(cfg.serverUrl);
  const key = `${base}\n${cfg.refreshToken}`;
  let pending = refreshInFlight.get(key);

  if (!pending) {
    pending = (async () => {
      const res = await fetch(`${base}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: cfg.refreshToken }),
      });
      if (!res.ok) {
        const error = await parseErr(res);
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          (error as NowenApiError & { terminal?: boolean }).terminal = true;
          await setConfig({ token: "", refreshToken: "" });
        }
        throw error;
      }

      const payload = (await res.json()) as { token?: string };
      if (!payload.token) throw new Error("登录续期响应缺少访问令牌");
      cfg.token = payload.token;
      await setConfig({ token: payload.token });
      return payload.token;
    })().finally(() => refreshInFlight.delete(key));
    refreshInFlight.set(key, pending);
  }

  try {
    const token = await pending;
    cfg.token = token;
    return token;
  } catch (error) {
    if ((error as { terminal?: boolean })?.terminal) {
      cfg.token = "";
      cfg.refreshToken = "";
    }
    throw error;
  }
}

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

export async function ping(
  cfg: NowenClipperConfig,
): Promise<{ id?: string; username: string; role: string; displayName?: string | null }> {
  return requestJson(cfg, "/me");
}

export async function listWorkspaces(cfg: NowenClipperConfig): Promise<WorkspaceSummary[]> {
  return requestJson(cfg, "/workspaces");
}

export async function listNotebooks(
  cfg: NowenClipperConfig,
  workspaceId: string | null = null,
): Promise<NotebookSummary[]> {
  // 与 importNote 一致的分流：无服务器配置时读本机笔记本，
  // 否则弹窗里的笔记本下拉会是空的，用户无法选择保存位置。
  if ((!cfg.serverUrl || !cfg.token) && !workspaceId) {
    const { ensureDesktopReady, listLocalNotebooks } = await import("./localChannel");
    const ready = await ensureDesktopReady();
    // Desktop 不可用时返回空列表而不是抛错：用户仍应能剪藏
    // （saveClipLocalFirst 会走 Pending Queue 暂存）。
    if (!ready.ok) return [];
    // 本地接口返回 { items: [...] }，与远端的裸数组形状不同，
    // 这里做一次归一，让调用方无需区分通道。
    const local = await listLocalNotebooks(ready.runtime);
    return (local?.items ?? []) as NotebookSummary[];
  }
  const scope = workspaceId ? encodeURIComponent(workspaceId) : "personal";
  return requestJson(cfg, `/notebooks?workspaceId=${scope}`);
}

export async function importNote(
  cfg: NowenClipperConfig,
  payload: ImportNotePayload,
): Promise<ImportResponse> {
  // Local-first 分流（Phase 8 接线）。
  //
  // 未配置服务器（或未登录）时走 Desktop 本地通道：
  //   Extension → Native Messaging 发现 Desktop → localhost HTTP → 本地 SQLite
  //
  // 这样"没有 NAS、没有服务器"的桌面用户也能剪藏。
  // Clipper 不关心用户是否开启了同步 —— 开启后由 Desktop 的 Outbox 负责上传。
  //
  // 已配置服务器时保持原行为完全不变：直连远端，不引入额外延迟。
  // 工作区剪藏也一律走远端 —— Sync V2 第一版不支持工作区离线数据，
  // 走本地通道会把团队内容错误地存成个人笔记。
  const useLocalChannel = !cfg.serverUrl || !cfg.token;
  if (useLocalChannel && !payload.workspaceId) {
    // 动态 import：已配置服务器的用户不该为本地通道付出包体与初始化成本。
    const { saveClipLocalFirst } = await import("./localChannel");
    const result = await saveClipLocalFirst({
      title: payload.title,
      content: payload.content,
      contentText: payload.contentText,
      contentFormat: payload.contentFormat,
      notebookId: payload.notebookId,
      notebookName: payload.notebookName,
    });

    if (!result.ok) {
      // 已暂存到扩展 IndexedDB，Desktop 可用时自动 flush。
      // 抛出而非静默返回：调用方需要把"已暂存，稍后自动保存"告诉用户，
      // 否则用户会以为剪藏丢了。
      throw new NowenApiError(0, "CLIP_QUEUED_LOCALLY", result.message);
    }

    // 拼成与远端一致的形状，让 5 处调用方无需区分通道。
    return {
      success: true,
      count: 1,
      notebookId: payload.notebookId || "",
      notebookIds: payload.notebookId ? [payload.notebookId] : [],
      notes: [{
        id: result.noteId,
        title: payload.title,
        notebookId: payload.notebookId || "",
      }],
      workspaceId: null,
    };
  }

  const body: Record<string, unknown> = {
    notes: [
      {
        title: payload.title,
        content: payload.content,
        contentText: payload.contentText,
        contentFormat: payload.contentFormat,
        notebookName: payload.notebookName,
        notebookPath: payload.notebookPath,
        createdAt: payload.createdAt,
        updatedAt: payload.updatedAt,
      },
    ],
  };
  if (payload.notebookId) body.notebookId = payload.notebookId;
  else if (payload.notebookName && !payload.notebookPath) body.notebookName = payload.notebookName;

  const scope = payload.workspaceId ? encodeURIComponent(payload.workspaceId) : "personal";
  return requestJson(cfg, `/export/import?workspaceId=${scope}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function setNotePinned(
  cfg: NowenClipperConfig,
  noteId: string,
  pinned: boolean,
): Promise<void> {
  await requestJson(cfg, `/notes/${encodeURIComponent(noteId)}`, {
    method: "PUT",
    body: JSON.stringify({ isPinned: pinned ? 1 : 0 }),
  });
}

export async function listTags(
  cfg: NowenClipperConfig,
  workspaceId: string | null,
): Promise<TagSummary[]> {
  const scope = workspaceId ? encodeURIComponent(workspaceId) : "personal";
  return requestJson(cfg, `/tags?workspaceId=${scope}&includeEmpty=true`);
}

export async function createTag(
  cfg: NowenClipperConfig,
  name: string,
  workspaceId: string | null,
): Promise<TagSummary> {
  return requestJson(cfg, "/tags", {
    method: "POST",
    body: JSON.stringify({ name, workspaceId }),
  });
}

export async function attachTag(
  cfg: NowenClipperConfig,
  noteId: string,
  tagId: string,
): Promise<void> {
  await requestJson(cfg, `/tags/note/${encodeURIComponent(noteId)}/tag/${encodeURIComponent(tagId)}`, {
    method: "POST",
    body: "{}",
  });
}

/**
 * 将标签名称落成真实 tags + note_tags。单个标签失败由调用方记录，不回滚已保存笔记。
 */
export async function ensureNoteTags(
  cfg: NowenClipperConfig,
  noteId: string,
  names: string[],
  workspaceId: string | null,
): Promise<string[]> {
  const unique = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 20);
  if (unique.length === 0) return [];

  const failures: string[] = [];
  let existing = await listTags(cfg, workspaceId).catch(() => [] as TagSummary[]);
  for (const name of unique) {
    let tag = existing.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!tag) {
      try {
        tag = await createTag(cfg, name, workspaceId);
        existing = [...existing, tag];
      } catch (error: any) {
        failures.push(`${name}：${String(error?.message || error)}`);
        continue;
      }
    }
    try {
      await attachTag(cfg, noteId, tag.id);
    } catch (error: any) {
      failures.push(`${name}：${String(error?.message || error)}`);
    }
  }
  return failures;
}

export function buildNoteUrl(cfg: NowenClipperConfig, noteId: string): string {
  return `${normalizeBaseUrl(cfg.serverUrl)}/?noteId=${encodeURIComponent(noteId)}`;
}

export interface AIEnhanceRequest {
  title?: string;
  url?: string;
  siteName?: string;
  contentText: string;
  tasks: {
    summary?: boolean;
    outline?: boolean;
    tags?: boolean;
    title?: boolean;
    highlight?: boolean;
    translation?: boolean;
  };
  language?: "zh-CN" | "en";
  customInstruction?: string;
  maxInputChars?: number;
}

export interface AIEnhanceResult {
  ok: boolean;
  error?: string;
  enhanced?: {
    title?: string;
    summary?: string;
    outline?: string;
    tags?: string[];
    highlights?: string[];
    translation?: string;
  };
  model?: string;
  truncated?: boolean;
}

export async function enhanceClip(
  cfg: NowenClipperConfig,
  payload: AIEnhanceRequest,
): Promise<AIEnhanceResult> {
  return requestJson(cfg, "/ai/clip-enhance", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
