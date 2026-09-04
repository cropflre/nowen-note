/**
 * 云端笔记导入（Yuque 网页端 cookie 模式）—— 前端服务层。
 * 凭证：浏览器登录 Yuque 网页版后，F12 从请求头里复制的 cookie + X-Csrf-Token
 * （该方式不需要会员；官方 Personal Access Token 需超级会员）。
 * 所有请求走后端 /api/yuque 代理（凭证不进浏览器存储之外的持久化）。
 */
import { getBaseUrl, getCurrentWorkspace } from "./api";

export interface YuqueRepo {
  id: number;
  slug: string;
  name: string;
  user: string;
  type?: string;
}

export interface YuqueDocMeta {
  id: number;
  url: string;
  title: string;
  parentUuid?: string;
}

export interface YuqueImportResult {
  success: boolean;
  count: number;
  notebookId: string;
  downloadedImages: number;
  failedImages: number;
  errors: string[];
}

const COOKIE_STORAGE_KEY = "nowen-yuque-cookie";
const CSRF_STORAGE_KEY = "nowen-yuque-csrf";

export function getYuqueCookie(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(COOKIE_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function getYuqueCsrf(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(CSRF_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function saveYuqueCreds(cookie: string, csrf: string): void {
  try {
    if (cookie) window.localStorage.setItem(COOKIE_STORAGE_KEY, cookie);
    else window.localStorage.removeItem(COOKIE_STORAGE_KEY);
    if (csrf) window.localStorage.setItem(CSRF_STORAGE_KEY, csrf);
    else window.localStorage.removeItem(CSRF_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function clearYuqueCreds(): void {
  saveYuqueCreds("", "");
}

function readAuthToken(): string | null {
  try {
    return localStorage.getItem("nowen-token");
  } catch {
    return null;
  }
}

function requestHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = readAuthToken();
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function post<T>(path: string, body: unknown, withWorkspace = false): Promise<T> {
  const workspaceId = withWorkspace ? getCurrentWorkspace() : null;
  const url = workspaceId
    ? `${getBaseUrl()}${path}?workspaceId=${encodeURIComponent(workspaceId)}`
    : `${getBaseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: requestHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("无法连接后端服务，请确认后端已启动");
  }
  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("后端服务缺少该接口（可能是旧版本），请重启后端后重试");
    }
    throw new Error(payload?.error || `请求失败: HTTP ${response.status}`);
  }
  return payload;
}

export async function verifyYuqueCreds(cookie: string, csrf: string): Promise<{
  valid: boolean;
  login?: string;
  error?: string;
}> {
  return post("/yuque/verify", { cookie, csrf });
}

export async function fetchYuqueRepos(cookie: string, csrf: string): Promise<YuqueRepo[]> {
  const payload = await post<{ repos: YuqueRepo[] }>("/yuque/repos", { cookie, csrf });
  return payload.repos || [];
}

export async function fetchYuqueDocs(
  cookie: string,
  csrf: string,
  user: string,
  bookSlug: string,
): Promise<YuqueDocMeta[]> {
  const payload = await post<{ docs: YuqueDocMeta[] }>("/yuque/docs", {
    cookie,
    csrf,
    user,
    bookSlug,
  });
  return payload.docs || [];
}

export async function importYuqueDocs(
  cookie: string,
  csrf: string,
  user: string,
  bookSlug: string,
  docs: Array<{ url: string; title: string }>,
  notebookId?: string,
): Promise<YuqueImportResult> {
  return post<YuqueImportResult>(
    "/yuque/import",
    { cookie, csrf, user, bookSlug, docs, notebookId },
    true,
  );
}

export interface YuqueRetryImagesResult {
  success: boolean;
  notebookId: string;
  downloadedImages: number;
  failedImages: number;
  notesUpdated: number;
}

/** 重试导入失败的图片：就地更新目标笔记本里仍含远程 <img> 的笔记，不重建、不重复。 */
export async function retryYuqueImages(
  cookie: string,
  csrf: string,
  notebookId: string,
): Promise<YuqueRetryImagesResult> {
  return post<YuqueRetryImagesResult>(
    "/yuque/retry-images",
    { cookie, csrf, notebookId },
    true,
  );
}

