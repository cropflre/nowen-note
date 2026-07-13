import { toast } from "@/lib/toast";

const INSTALL_KEY = "__NOWEN_NOTE_ATTACHMENT_ACCESS_BRIDGE_V1__";
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_QUERY_KEYS = new Set(["exp", "sig", "scope"]);
const accessUrls = new Map<string, string>();
let scanQueued = false;
let lastDeniedToastAt = 0;

interface AccessUrlPayload {
  noteId?: string;
  urls?: Record<string, string>;
}

function asAbsoluteUrl(value: string): URL | null {
  try {
    return new URL(value, typeof window !== "undefined" ? window.location.href : "http://localhost/");
  } catch {
    return null;
  }
}

export function extractAttachmentId(value: string | null | undefined): string | null {
  if (!value || !value.includes("/api/attachments/")) return null;
  const parsed = asAbsoluteUrl(value);
  if (!parsed) return null;
  const match = parsed.pathname.match(/\/api\/attachments\/([^/]+)$/i);
  const id = match?.[1] || "";
  return ATTACHMENT_ID_RE.test(id) ? id : null;
}

/**
 * 将原 URL 上的功能参数（download/inline/w 等）合并到服务端签发的访问 URL。
 * exp/sig/scope 始终以服务端最新版本为准，因此权限上下文切换或续签后旧 URL 会被替换。
 */
export function mergeSignedAttachmentUrl(raw: string, signed: string): string {
  if (!raw || !signed) return raw;
  const rawUrl = asAbsoluteUrl(raw);
  if (!rawUrl) return signed;
  let signedUrl: URL;
  try {
    // 服务端允许返回相对签名地址；客户端连接独立后端时应沿用裸链的后端 origin，
    // 不能错误地解析到前端页面（或 capacitor://localhost）所在的 origin。
    signedUrl = new URL(signed, rawUrl.origin);
  } catch {
    return signed;
  }

  rawUrl.searchParams.forEach((value, key) => {
    if (!ACCESS_QUERY_KEYS.has(key) && !signedUrl.searchParams.has(key)) {
      signedUrl.searchParams.append(key, value);
    }
  });
  if (rawUrl.hash && !signedUrl.hash) signedUrl.hash = rawUrl.hash;
  return signedUrl.toString();
}

export function registerAttachmentAccessUrls(urls: Record<string, string> | null | undefined): number {
  if (!urls) return 0;
  let count = 0;
  for (const [id, url] of Object.entries(urls)) {
    if (!ATTACHMENT_ID_RE.test(id) || typeof url !== "string" || !url.includes("sig=")) continue;
    accessUrls.set(id, url);
    count += 1;
  }
  if (count > 0) queueDomScan();
  return count;
}

export function resolveAttachmentAccessUrl(raw: string): string {
  const id = extractAttachmentId(raw);
  if (!id) return raw;
  const signed = accessUrls.get(id);
  return signed ? mergeSignedAttachmentUrl(raw, signed) : raw;
}

function rewriteElementAttribute(element: Element, attribute: string): void {
  const raw = element.getAttribute(attribute);
  if (!raw) return;
  const resolved = resolveAttachmentAccessUrl(raw);
  if (resolved !== raw) element.setAttribute(attribute, resolved);
}

function rewriteSrcset(element: Element): void {
  const raw = element.getAttribute("srcset");
  if (!raw || !raw.includes("/api/attachments/")) return;
  const next = raw
    .split(",")
    .map((entry) => {
      const trimmed = entry.trim();
      const firstSpace = trimmed.search(/\s/);
      const url = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
      const descriptor = firstSpace === -1 ? "" : trimmed.slice(firstSpace);
      return `${resolveAttachmentAccessUrl(url)}${descriptor}`;
    })
    .join(", ");
  if (next !== raw) element.setAttribute("srcset", next);
}

function rewriteElement(element: Element): void {
  rewriteElementAttribute(element, "src");
  rewriteElementAttribute(element, "href");
  rewriteElementAttribute(element, "poster");
  rewriteElementAttribute(element, "data-src");
  rewriteSrcset(element);
}

function scanRoot(root: ParentNode): void {
  if (root instanceof Element) rewriteElement(root);
  root
    .querySelectorAll?.(
      'img[src],video[src],audio[src],source[src],iframe[src],a[href],[poster],[data-src],[srcset]',
    )
    .forEach(rewriteElement);
}

function queueDomScan(): void {
  if (scanQueued || typeof document === "undefined") return;
  scanQueued = true;
  queueMicrotask(() => {
    scanQueued = false;
    scanRoot(document);
  });
}

function installDomRewriter(): void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  scanRoot(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof Element) {
        rewriteElement(record.target);
      }
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) scanRoot(node);
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src", "href", "poster", "data-src", "srcset"],
  });
}

function requestUrl(input: RequestInfo | URL): URL | null {
  const raw = input instanceof Request ? input.url : String(input);
  return asAbsoluteUrl(raw);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  return headers;
}

function authHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  const source = requestHeaders(input, init);
  const headers = new Headers();
  const authorization = source.get("Authorization");
  if (authorization) headers.set("Authorization", authorization);
  const requestedWith = source.get("X-Requested-With");
  if (requestedWith) headers.set("X-Requested-With", requestedWith);
  return headers;
}

async function fetchAccessUrls(
  originalFetch: typeof window.fetch,
  url: URL,
  headers: Headers,
  credentials: RequestCredentials,
): Promise<void> {
  try {
    const response = await originalFetch(url.toString(), {
      method: "GET",
      headers,
      credentials,
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = await response.json() as AccessUrlPayload;
    registerAttachmentAccessUrls(payload.urls);
  } catch (error) {
    console.warn("[attachment-access] failed to refresh signed URLs", error);
  }
}

function rewriteFetchInput(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  mappedUrl: string,
): [RequestInfo | URL, RequestInit | undefined] {
  if (!(input instanceof Request)) return [mappedUrl, init];

  const merged = new Request(input, init);
  return [
    new Request(mappedUrl, {
      method: merged.method,
      headers: merged.headers,
      mode: merged.mode,
      credentials: merged.credentials,
      cache: merged.cache,
      redirect: merged.redirect,
      referrer: merged.referrer,
      referrerPolicy: merged.referrerPolicy,
      integrity: merged.integrity,
      keepalive: merged.keepalive,
      signal: merged.signal,
    }),
    undefined,
  ];
}

async function showAttachmentDenied(response: Response): Promise<void> {
  if (response.status !== 401 && response.status !== 403 && response.status !== 410) return;
  const now = Date.now();
  if (now - lastDeniedToastAt < 2000) return;
  lastDeniedToastAt = now;
  try {
    const payload = await response.clone().json() as { error?: string; code?: string };
    toast.error(payload.error || "附件访问权限已失效，请刷新笔记后重试");
  } catch {
    toast.error("附件访问权限已失效，请刷新笔记后重试");
  }
}

/**
 * 安装附件访问桥：
 * 1. 打开普通/协作笔记时，使用当前 JWT 换取按用户 scope 签名的附件 URL；
 * 2. 打开公开分享时，在正文计数前先换取按 share scope 签名的 URL；
 * 3. 不改写笔记 JSON/Markdown，只在 DOM 属性和真实 fetch 请求发出前替换 URL，
 *    因此编辑保存、导出和同步仍保留原始 `/api/attachments/<id>`。
 */
export function installNoteAttachmentAccessBridge(): void {
  if (typeof window === "undefined") return;
  const state = window as unknown as Record<string, unknown>;
  if (state[INSTALL_KEY]) return;
  state[INSTALL_KEY] = true;

  installDomRewriter();
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    if (!url) return originalFetch(input, init);

    // fetch 下载、Android blob 图片、音视频预览等请求统一换成当前有效签名。
    if (method === "GET" && extractAttachmentId(url.toString())) {
      const mapped = resolveAttachmentAccessUrl(url.toString());
      if (mapped !== url.toString()) {
        const [nextInput, nextInit] = rewriteFetchInput(input, init, mapped);
        const response = await originalFetch(nextInput, nextInit);
        void showAttachmentDenied(response);
        return response;
      }
    }

    const credentials = input instanceof Request
      ? input.credentials
      : (init?.credentials || "same-origin");
    const noteMatch = url.pathname.match(/\/api\/notes\/([^/]+)$/);
    const shareMatch = url.pathname.match(/\/api\/shared\/([^/]+)\/content$/);

    let accessPromise: Promise<void> | null = null;
    if (method === "GET" && noteMatch && url.searchParams.get("slim") !== "1") {
      const accessUrl = new URL("/api/attachments/access/urls", url.origin);
      accessUrl.searchParams.set("noteId", decodeURIComponent(noteMatch[1]));
      accessPromise = fetchAccessUrls(originalFetch, accessUrl, authHeaders(input, init), credentials);
    } else if (method === "GET" && shareMatch) {
      // 必须在正文接口自增 viewCount 之前签发，否则 maxViews=1 的首次访问会立即失效。
      const accessUrl = new URL("/api/attachments/share-access", url.origin);
      accessUrl.searchParams.set("token", decodeURIComponent(shareMatch[1]));
      await fetchAccessUrls(originalFetch, accessUrl, authHeaders(input, init), credentials);
    }

    const response = await originalFetch(input, init);
    if (accessPromise) await accessPromise;
    if (response.ok && (noteMatch || shareMatch)) queueDomScan();
    if (extractAttachmentId(url.toString())) void showAttachmentDenied(response);
    return response;
  };
}
