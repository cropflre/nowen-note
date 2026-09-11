import { getBaseUrl } from "@/lib/api.impl";
import { fetchWithAuthRefresh, getAccessToken } from "@/lib/authSession";

const SIGNED_ATTACHMENT_URL_RE = /(?:https?:\/\/[^\s"'<>]+)?\/(?:api|publicapi)\/attachments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\?[^\s"'<>()]+/gi;
const ATTACHMENT_PATH_RE = /\/(?:api|publicapi)\/attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

interface SignedAttachmentCandidate {
  attachmentId: string;
  htmlEscaped: boolean;
}

interface StableFileShareResponse {
  attachmentId: string;
  url: string;
}

function decodeBase64UrlUtf8(value: string): string | null {
  if (typeof atob !== "function") return null;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (typeof TextDecoder !== "undefined") {
      return new TextDecoder().decode(bytes);
    }
    return binary;
  } catch {
    return null;
  }
}

function parseScopeKind(scope: string): string | null {
  if (!scope.startsWith("v2.")) return null;
  const decoded = decodeBase64UrlUtf8(scope.slice(3));
  if (!decoded) return null;
  try {
    const payload = JSON.parse(decoded) as { kind?: unknown };
    return typeof payload.kind === "string" ? payload.kind : null;
  } catch {
    return null;
  }
}

function inspectSignedAttachmentUrl(raw: string): SignedAttachmentCandidate | null {
  const htmlEscaped = raw.includes("&amp;");
  const normalized = htmlEscaped ? raw.replace(/&amp;/g, "&") : raw;
  let url: URL;
  try {
    url = new URL(normalized, "http://nowen.local/");
  } catch {
    return null;
  }

  const attachmentId = ATTACHMENT_PATH_RE.exec(url.pathname)?.[1];
  if (!attachmentId) return null;
  const exp = url.searchParams.get("exp");
  const sig = url.searchParams.get("sig");
  const scope = url.searchParams.get("scope");
  if (!exp || !sig || !scope) return null;

  // 只有登录态 user scope 才是“文件管理里被误复制出去的运行时 URL”。
  // share/publication scope 属于公开页面自己的运行时授权，不能静默转换成另一个分享实体。
  if (parseScopeKind(scope) !== "user") return null;
  return { attachmentId, htmlEscaped };
}

function absoluteStableShareUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  try {
    const base = typeof window !== "undefined" ? window.location.href : "http://nowen.local/";
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

async function createStableFileShareUrl(attachmentId: string): Promise<string> {
  const apiBase = getBaseUrl();
  const token = getAccessToken();
  const response = await fetchWithAuthRefresh(`${apiBase}/attachments/file-share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ attachmentId }),
  }, apiBase);

  const payload = await response.json().catch(() => ({})) as Partial<StableFileShareResponse> & {
    error?: string;
  };
  if (!response.ok || !payload.url) {
    throw new Error(payload.error || "无法创建稳定文件分享链接");
  }
  return absoluteStableShareUrl(payload.url);
}

/**
 * 剪贴板是“运行时 URL 泄漏到产品分享 URL”的统一边界。
 *
 * 任何通过统一 copyText() 复制出去的 user-scope 附件签名 URL，都会先换成稳定
 * file-share capability。普通文本、普通 URL、公开分享页自己的 share scope 均保持原样。
 * 如果稳定链接创建失败，调用方应停止复制，而不是回退泄漏会过期的 exp/sig/scope URL。
 */
export async function stabilizeClipboardAttachmentLinks(
  text: string,
  createShareUrl: (attachmentId: string) => Promise<string> = createStableFileShareUrl,
): Promise<string> {
  if (!text || !/\/(?:api|publicapi)\/attachments\//i.test(text) || !/[?&](?:exp|sig|scope)=/i.test(text)) {
    return text;
  }

  const matches = [...text.matchAll(SIGNED_ATTACHMENT_URL_RE)];
  if (matches.length === 0) return text;

  const sharePromises = new Map<string, Promise<string>>();
  const replacements: Array<{ start: number; end: number; value: string }> = [];

  for (const match of matches) {
    const raw = match[0];
    const start = match.index;
    if (start === undefined) continue;
    const candidate = inspectSignedAttachmentUrl(raw);
    if (!candidate) continue;

    let sharePromise = sharePromises.get(candidate.attachmentId);
    if (!sharePromise) {
      sharePromise = createShareUrl(candidate.attachmentId);
      sharePromises.set(candidate.attachmentId, sharePromise);
    }
    const stableUrl = await sharePromise;
    replacements.push({
      start,
      end: start + raw.length,
      value: candidate.htmlEscaped ? stableUrl.replace(/&/g, "&amp;") : stableUrl,
    });
  }

  if (replacements.length === 0) return text;

  let result = "";
  let cursor = 0;
  for (const replacement of replacements) {
    result += text.slice(cursor, replacement.start);
    result += replacement.value;
    cursor = replacement.end;
  }
  result += text.slice(cursor);
  return result;
}
