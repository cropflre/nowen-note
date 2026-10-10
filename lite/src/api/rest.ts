/**
 * 极小的 REST 助手 —— 用于 SDK 没覆盖、或**覆盖错了**的端点。
 *
 * 为什么需要它：SDK 的 `listDiaries()` 打的是 `GET /api/diary?month=`，
 * 而服务端真实的列表端点是 `GET /api/diary/timeline` → 调用必 404。
 * 这类地方不值得 fork 整个 SDK，直接用本助手打真实端点更省事，
 * 也更容易在 SDK 修好后替换回来。
 */
import { getServerUrl } from "../auth/auth";
import { ensureScheme } from "../lib/serverAddress";
import { authedFetch } from "../auth/authedFetch";

export class ApiError extends Error {
  status: number;
  code?: string;
  /** 原始响应体 —— 例如 409 冲突里的 currentVersion 就在这里 */
  body?: unknown;
  constructor(message: string, status: number, code?: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  let url = `${ensureScheme(getServerUrl())}${path}`;

  if (init.query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";

  // authedFetch 负责带 token，并在过期时自动续期 + 重放
  const res = await authedFetch(url, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    let code: string | undefined;
    let body: unknown;
    try {
      body = (await res.json()) as unknown;
      const data = body as { error?: string; message?: string; code?: string };
      message = data.error || data.message || message;
      code = data.code;
    } catch {
      /* 非 JSON 错误体，用默认文案 */
    }
    throw new ApiError(message, res.status, code, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * 上传一个说说附件（图片/视频）。
 *
 * ⚠️ 不能走 apiFetch：那个函数一律 `JSON.stringify(body)` 并设 `Content-Type: application/json`，
 *    而 multipart 必须让浏览器自己带 boundary → 这里直接用 FormData + authedFetch。
 *
 * ⚠️ 用 authedFetch 而不是裸 fetch：上传动辄几 MB，**上传途中 token 过期**很常见，
 *    没有自动续期就会白传一次。
 *
 * 上传成功后服务端留下一条 diaryId 为 NULL 的「悬空」附件 ——
 * 用户取消发布时要记得删掉（见 deleteDiaryAttachment），否则会攒垃圾。
 */
/**
 * 把服务端给的**相对路径**补成完整地址。
 *
 * ⚠️ 为什么必须补：装进 APK 后 WebView 的 origin 是 `https://localhost`（Capacitor 默认），
 *    页面里的 `/api/diary/attachments/xxx`、`/api/attachments/xxx?exp=…&sig=…`
 *    全都会打到手机本机 → 图片一律裂开。
 *    服务端返回的签名 URL 本来就是相对的（见 attachment-signed-url.js），
 *    所以在**渲染出口**统一补一次，而不是指望每个调用点自己记得。
 *
 * 已经是绝对地址 / data: / blob: 的原样返回。
 */
export function serverUrl(path: string): string {
  if (!path) return path;
  if (/^(https?:|data:|blob:|capacitor:|file:)/i.test(path)) return path;
  // 兜一层补协议：localStorage 里可能残留用户早先手打的无协议地址
  const base = ensureScheme(getServerUrl());
  if (!base) return path;
  return `${base}${path.startsWith("/") ? "" : "/"}${path}`;
}

export interface DiaryAttachment {
  id: string;
  url: string;
  mimeType: string;
  size: number;
  filename: string;
  type: "image" | "video";
}

export async function uploadDiaryAttachment(file: File): Promise<DiaryAttachment> {
  const form = new FormData();
  form.append("file", file, file.name);

  // 大文件给足时间：手机上一张 10MB 的图走内网也可能要十几秒
  const res = await authedFetch(`${getServerUrl()}/api/diary/attachments`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    let message = `上传失败（HTTP ${res.status}）`;
    try {
      const body = (await res.json()) as { error?: string };
      message = body.error || message;
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(message, res.status);
  }
  const data = (await res.json()) as DiaryAttachment;
  // 立刻补成绝对地址：这个 url 会被直接塞进 <img src>
  return { ...data, url: serverUrl(data.url) };
}

/** 删除一张还没绑定到说说上的悬空附件（用户点了 × 时调用） */
export async function deleteDiaryAttachment(id: string): Promise<void> {
  await apiFetch(`/api/diary/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
}
