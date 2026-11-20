/**
 * 数据层：包一层 vendored 的 @nowen/sdk（MIT）。
 *
 * SDK 的构造要求 username/password，但我们在外面已经走完 2FA 拿到了 token，
 * 所以：传占位账号 + 立刻 setToken()，之后 ensureAuth() 不会再去尝试登录。
 * （setToken / getToken 是我们给 SDK 加的小补丁，见 sdk/client.ts）
 */
import { NowenClient } from "../../sdk/index";
import { getServerUrl, getToken } from "../auth/auth";
import { authedFetch } from "../auth/authedFetch";

let cached: NowenClient | null = null;
let cachedFor: { serverUrl: string; token: string | null } | null = null;

export function getClient(): NowenClient {
  const serverUrl = getServerUrl();
  const token = getToken();

  if (cached && cachedFor && cachedFor.serverUrl === serverUrl && cachedFor.token === token) {
    return cached;
  }

  const client = new NowenClient({
    baseUrl: serverUrl,
    // 占位：真正的凭据走 setToken()，这两个值不会被使用
    username: "__lite__",
    password: "__lite__",
    timeout: 30_000,
    // ⚠️ 必须注入：SDK 自己遇到 401 会拿占位账号去 login()（必然失败），
    //    交给 authedFetch 在它看到 401 之前就用 refreshToken 换好新 token。
    fetch: authedFetch,
  });
  client.setToken(token);

  cached = client;
  cachedFor = { serverUrl, token };
  return client;
}

/** 会话变化（登录/登出/换服务器）后必须调用，避免复用旧的 token。 */
export function resetClient(): void {
  cached = null;
  cachedFor = null;
}

/**
 * 附件签名 URL。
 *
 * 笔记正文里的图片是相对路径 `/api/attachments/<uuid>`，
 * 而 `<img>` 带不了 Authorization 头 —— 所以必须先用本接口换成带签名的短时 URL。
 * 返回 { attachmentId: signedUrl }。
 */
export async function fetchAttachmentAccessUrls(noteId: string): Promise<Record<string, string>> {
  try {
    const res = await authedFetch(
      `${getServerUrl()}/api/attachments/access/urls?noteId=${encodeURIComponent(noteId)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) return {};
    const data = (await res.json()) as { urls?: Record<string, string> };
    return data.urls ?? {};
  } catch {
    // 拿不到签名 URL 时降级：正文仍可读，图片会显示为加载失败
    return {};
  }
}
