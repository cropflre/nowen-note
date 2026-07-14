import { toast } from "@/lib/toast";

const INSTALL_KEY = "__NOWEN_NOTE_ATTACHMENT_ACCESS_BRIDGE_V1__";
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_QUERY_KEYS = new Set(["exp", "sig", "scope"]);
const accessUrls = new Map<string, string>();
let attachmentApiOrigin = "";
let scanQueued = false;
let lastDeniedToastAt = 0;

interface AccessUrlPayload {
  noteId?: string;
  urls?: Record<string, string>;
}

function asAbsoluteUrl(value: string, base?: string): URL | null {
  try {
    const fallback = typeof window !== "undefined" ? window.location.href : "http://localhost/";
    return new URL(value, base || fallback);
  } catch {
    return null;
  }
}

function isHttpUrl(url: URL | null): url is URL {
  return !!url && (url.protocol === "http:" || url.protocol === "https:");
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost"
    || value === "0.0.0.0"
    || value === "::1"
    || value === "[::1]"
    || value.startsWith("127.");
}

function isKnownNowenApiUrl(url: URL): boolean {
  return /\/api\/(?:notes|attachments|files|shared)(?:\/|$)/.test(url.pathname);
}

function currentWindowHttpOrigin(): string {
  if (typeof window === "undefined") return "";
  try {
    const parsed = new URL(window.location.href);
    return isHttpUrl(parsed) ? parsed.origin : "";
  } catch {
    return "";
  }
}

/**
 * 记住本次页面真实访问的 API origin。
 *
 * 不能使用签名响应里的绝对地址作为真相：NAS / Docker 反代经常把上游 Host 设为
 * 127.0.0.1:3001，后端若据此生成绝对 URL，外部浏览器会错误访问自己的回环地址。
 * 真实请求 URL 才是客户端实际可达的来源。
 */
export function rememberAttachmentApiOrigin(value: string | URL): string {
  const parsed = value instanceof URL ? value : asAbsoluteUrl(value);
  if (!isHttpUrl(parsed) || !isKnownNowenApiUrl(parsed)) return attachmentApiOrigin;

  if (isLoopbackHostname(parsed.hostname)) {
    const remembered = asAbsoluteUrl(attachmentApiOrigin);
    if (remembered && isHttpUrl(remembered) && !isLoopbackHostname(remembered.hostname)) {
      return attachmentApiOrigin;
    }

    // Web 页面本身运行在公网 / NAS origin 时，127.0.0.1 只可能是正文或反代泄漏的旧地址。
    // Electron file:// 与 Capacitor 自定义协议没有 HTTP window origin，此时仍允许真实本地后端。
    const windowOrigin = currentWindowHttpOrigin();
    const windowUrl = asAbsoluteUrl(windowOrigin);
    if (windowUrl && isHttpUrl(windowUrl) && !isLoopbackHostname(windowUrl.hostname)) {
      attachmentApiOrigin = windowOrigin;
      return attachmentApiOrigin;
    }
  }

  attachmentApiOrigin = parsed.origin;
  return attachmentApiOrigin;
}

function trustedOriginFor(rawUrl?: URL | null): string {
  if (attachmentApiOrigin) return attachmentApiOrigin;
  if (rawUrl && isHttpUrl(rawUrl) && !isLoopbackHostname(rawUrl.hostname)) return rawUrl.origin;
  return currentWindowHttpOrigin() || (rawUrl && isHttpUrl(rawUrl) ? rawUrl.origin : "");
}

function moveUrlToOrigin(url: URL, origin: string): URL {
  if (!origin) return url;
  try {
    return new URL(`${url.pathname}${url.search}${url.hash}`, `${origin.replace(/\/+$/, "")}/`);
  } catch {
    return url;
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

function normalizeRegisteredAccessUrl(
  id: string,
  value: string,
  sourceUrl?: string | URL,
): string | null {
  let trustedOrigin = attachmentApiOrigin;
  if (sourceUrl) {
    trustedOrigin = rememberAttachmentApiOrigin(sourceUrl);
  }

  const sourceBase = trustedOrigin ? `${trustedOrigin}/` : undefined;
  let parsed = asAbsoluteUrl(value, sourceBase);
  if (!parsed || extractAttachmentId(parsed.toString()) !== id) return null;

  // 签名绑定的是 attachmentId + exp + scope，不绑定 host。即使服务端错误返回
  // http://127.0.0.1:3001，也必须把 path/query 搬到发起该接口请求的真实 origin。
  if (trustedOrigin) parsed = moveUrlToOrigin(parsed, trustedOrigin);
  return parsed.toString();
}

/**
 * 将原 URL 上的功能参数（download/inline/w 等）合并到服务端签发的访问 URL。
 * exp/sig/scope 始终以服务端最新版本为准，因此权限上下文切换或续签后旧 URL 会被替换。
 */
export function mergeSignedAttachmentUrl(raw: string, signed: string): string {
  if (!raw || !signed) return raw;
  const rawUrl = asAbsoluteUrl(raw);
  if (!rawUrl) return signed;

  const trustedOrigin = trustedOriginFor(rawUrl);
  let signedUrl = asAbsoluteUrl(signed, trustedOrigin ? `${trustedOrigin}/` : rawUrl.origin);
  if (!signedUrl) return signed;
  if (trustedOrigin && extractAttachmentId(signedUrl.toString())) {
    signedUrl = moveUrlToOrigin(signedUrl, trustedOrigin);
  }

  rawUrl.searchParams.forEach((value, key) => {
    if (!ACCESS_QUERY_KEYS.has(key) && !signedUrl.searchParams.has(key)) {
      signedUrl.searchParams.append(key, value);
    }
  });
  if (rawUrl.hash && !signedUrl.hash) signedUrl.hash = rawUrl.hash;
  return signedUrl.toString();
}

/**
 * 注册附件签名映射。
 * sourceUrl 应传产生该响应的真实 API 请求 URL；相对签名和错误的容器内网绝对地址
 * 都会被规范到这个 origin。旧调用方不传时，使用最近一次已观察到的 API origin。
 */
export function registerAttachmentAccessUrls(
  urls: Record<string, string> | null | undefined,
  sourceUrl?: string | URL,
): number {
  if (!urls) return 0;
  if (sourceUrl) rememberAttachmentApiOrigin(sourceUrl);

  let count = 0;
  for (const [id, url] of Object.entries(urls)) {
    if (!ATTACHMENT_ID_RE.test(id) || typeof url !== "string" || !url.includes("sig=")) continue;
    const normalized = normalizeRegisteredAccessUrl(id, url, sourceUrl);
    if (!normalized) continue;
    accessUrls.set(id, normalized);
    count += 1;
  }
  if (count > 0) queueDomScan();
  return count;
}

export function resolveAttachmentAccessUrl(raw: string): string {
  const id = extractAttachmentId(raw);
  if (!id) return raw;
  const signed = accessUrls.get(id);
  if (signed) return mergeSignedAttachmentUrl(raw, signed);

  // 旧正文可能已被污染为 http://127.0.0.1:3001/api/attachments/...
  // 即使签名映射尚未返回，只要本会话已经观察到真实 API origin，就先修正 host。
  const parsed = asAbsoluteUrl(raw);
  if (
    parsed
    && attachmentApiOrigin
    && isLoopbackHostname(parsed.hostname)
    && parsed.origin !== attachmentApiOrigin
  ) {
    return moveUrlToOrigin(parsed, attachmentApiOrigin).toString();
  }
  return raw;
}

/** 测试隔离；生产代码无需调用。 */
export function resetAttachmentAccessStateForTests(): void {
  accessUrls.clear();
  attachmentApiOrigin = "";
  scanQueued = false;
  lastDeniedToastAt = 0;
}

function isEditableDocumentElement(element: Element): boolean {
  return Boolean(element.closest('[contenteditable="true"], .ProseMirror'));
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
  // 编辑器正文必须继续持有稳定 `/api/attachments/<id>`，不能把会过期的签名 URL
  // 写入 ProseMirror DOM。各 NodeView 在渲染时自行调用 resolveAttachmentUrl。
  if (isEditableDocumentElement(element)) return;
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
    rememberAttachmentApiOrigin(url);
    const response = await originalFetch(url.toString(), {
      method: "GET",
      headers,
      credentials,
      cache: "no-store",
    });
    if (!response.ok) return;
    const payload = await response.json() as AccessUrlPayload;
    registerAttachmentAccessUrls(payload.urls, url);
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
 * 3. 不改写笔记 JSON/Markdown，只在非编辑态 DOM 属性和真实 fetch 请求发出前替换 URL，
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
    if (isKnownNowenApiUrl(url)) rememberAttachmentApiOrigin(url);

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
