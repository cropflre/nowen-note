import { toast } from "@/lib/toast";
import { getShareSessionId } from "@/lib/shareSession";
import { getOfflineAttachmentsByNote, markOfflineAttachmentsAccessed } from "@/lib/localStore";

const INSTALL_KEY = "__NOWEN_NOTE_ATTACHMENT_ACCESS_BRIDGE_V1__";
const ATTACHMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCESS_QUERY_KEYS = new Set(["exp", "sig", "scope"]);
const accessUrls = new Map<string, string>();
const offlineObjectUrls = new Map<string, string>();
const offlineObjectBlobMetadata = new Map<string, { size: number; type: string }>();
const objectUrlAttachmentIds = new Map<string, string>();
const offlineObjectUrlEntries = new Map<string, {
  id: string;
  url: string;
  leases: number;
  retired: boolean;
}>();
const accessStateListeners = new Set<() => void>();
let accessStateRevision = 0;

function notifyAttachmentAccessChanged(): void {
  accessStateRevision += 1;
  for (const listener of accessStateListeners) listener();
}

/**
 * Editor NodeViews keep the stable attachment id in their document node, while this bridge owns
 * the short-lived render URL. Subscribe to the bridge so a late access refresh can re-resolve the
 * same persisted node instead of leaving the first unauthorized image request in an error state.
 */
export function subscribeAttachmentAccess(listener: () => void): () => void {
  accessStateListeners.add(listener);
  return () => accessStateListeners.delete(listener);
}

export function getAttachmentAccessSnapshot(): number {
  return accessStateRevision;
}

if (typeof window !== "undefined") {
  window.addEventListener("nowen:offline-attachments-removed", (event) => {
    const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids || [];
    for (const id of ids) retireOfflineObjectUrl(id);
    if (ids.length > 0) {
      notifyAttachmentAccessChanged();
      queueDomScan();
    }
  });
  window.addEventListener("pagehide", () => {
    forceRevokeAllOfflineObjectUrls();
  });
  window.addEventListener("nowen:server-url-changed", () => {
    resetAttachmentAccessForSessionChange();
  });
  window.addEventListener("nowen:token-changed", (event) => {
    const authenticated = (event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated;
    if (authenticated === false) resetAttachmentAccessForSessionChange();
  });
}
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
  let changed = false;
  for (const [id, url] of Object.entries(urls)) {
    if (!ATTACHMENT_ID_RE.test(id) || typeof url !== "string" || !url.includes("sig=")) continue;
    const normalized = normalizeRegisteredAccessUrl(id, url, sourceUrl);
    if (!normalized) continue;
    if (accessUrls.get(id) !== normalized) changed = true;
    accessUrls.set(id, normalized);
    count += 1;
  }
  if (changed) notifyAttachmentAccessChanged();
  if (count > 0) queueDomScan();
  return count;
}


function revokeOfflineObjectUrlEntry(entry: {
  id: string;
  url: string;
  leases: number;
  retired: boolean;
}): void {
  offlineObjectUrlEntries.delete(entry.url);
  try { URL.revokeObjectURL(entry.url); } catch { /* ignore unavailable URL API */ }
}

function collectRetiredOfflineObjectUrls(): void {
  for (const entry of offlineObjectUrlEntries.values()) {
    if (entry.retired && entry.leases === 0) revokeOfflineObjectUrlEntry(entry);
  }
}

function retireOfflineObjectUrl(id: string): boolean {
  const current = offlineObjectUrls.get(id);
  if (!current) return false;
  offlineObjectUrls.delete(id);
  offlineObjectBlobMetadata.delete(id);
  const entry = offlineObjectUrlEntries.get(current);
  if (entry) entry.retired = true;
  return true;
}

function forceRevokeAllOfflineObjectUrls(): void {
  offlineObjectUrls.clear();
  offlineObjectBlobMetadata.clear();
  for (const entry of [...offlineObjectUrlEntries.values()]) revokeOfflineObjectUrlEntry(entry);
  objectUrlAttachmentIds.clear();
}

function resetAttachmentAccessForSessionChange(): void {
  const changed = accessUrls.size > 0 || offlineObjectUrls.size > 0 || !!attachmentApiOrigin;
  accessUrls.clear();
  attachmentApiOrigin = "";
  for (const id of [...offlineObjectUrls.keys()]) retireOfflineObjectUrl(id);
  // 服务器或账号边界变化后，旧会话的 blob → attachmentId 不能映射到新作用域。
  objectUrlAttachmentIds.clear();
  if (changed) notifyAttachmentAccessChanged();
  queueDomScan();
}

/**
 * 将运行时 URL 还原为正文可持久化的附件身份。反向映射在 URL revoke 后仍保留到
 * 页面会话结束，避免已污染的临时节点在保存时失去最后一个可靠 attachmentId。
 */
export function getPersistentAttachmentUrl(value: string | null | undefined): string | null {
  const directId = extractAttachmentId(value);
  const mappedId = value ? objectUrlAttachmentIds.get(value) : undefined;
  const id = directId || mappedId;
  return id ? `/api/attachments/${id}` : null;
}

/**
 * NodeView 对当前 Object URL 建立租约。旧 URL 先退出 active map 并通知消费者，
 * 只有最后一个消费者完成切换并释放租约后才真正 revoke。
 */
export function acquireAttachmentRenderUrl(value: string): () => void {
  const entry = offlineObjectUrlEntries.get(value);
  if (!entry) {
    collectRetiredOfflineObjectUrls();
    return () => undefined;
  }
  entry.leases += 1;
  collectRetiredOfflineObjectUrls();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.leases = Math.max(0, entry.leases - 1);
    collectRetiredOfflineObjectUrls();
  };
}

export function registerOfflineAttachmentBlob(id: string, blob: Blob): string | null {
  if (!ATTACHMENT_ID_RE.test(id) || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return null;
  }
  // 重复 hydrate 读出的 Blob 实例可能不同，但相同 attachmentId/size/type 仍是同一缓存实体，
  // 不应反复制造 URL。若缓存实体确实变化，则先建立新 URL，再退休旧 URL。
  const current = offlineObjectUrls.get(id);
  const metadata = { size: blob.size, type: blob.type };
  const previousMetadata = offlineObjectBlobMetadata.get(id);
  if (
    current
    && previousMetadata?.size === metadata.size
    && previousMetadata.type === metadata.type
  ) return current;
  const url = URL.createObjectURL(blob);
  if (current) retireOfflineObjectUrl(id);
  offlineObjectUrls.set(id, url);
  offlineObjectBlobMetadata.set(id, metadata);
  objectUrlAttachmentIds.set(url, id);
  offlineObjectUrlEntries.set(url, { id, url, leases: 0, retired: false });
  notifyAttachmentAccessChanged();
  queueDomScan();
  return url;
}

export function unregisterOfflineAttachmentObjectUrl(id: string): void {
  const existed = retireOfflineObjectUrl(id);
  if (existed) notifyAttachmentAccessChanged();
  queueDomScan();
}

export function clearOfflineAttachmentObjectUrls(): void {
  const hadEntries = offlineObjectUrls.size > 0;
  for (const id of [...offlineObjectUrls.keys()]) retireOfflineObjectUrl(id);
  if (hadEntries) notifyAttachmentAccessChanged();
  queueDomScan();
}

export async function hydrateOfflineAttachmentsForNote(noteId: string): Promise<number> {
  const records = await getOfflineAttachmentsByNote(noteId);
  let hydrated = 0;
  for (const record of records) {
    if (registerOfflineAttachmentBlob(record.id, record.blob)) hydrated += 1;
  }
  if (records.length > 0) {
    await markOfflineAttachmentsAccessed(records.map((record) => record.id));
  }
  return hydrated;
}

export function resolveAttachmentAccessUrl(raw: string): string {
  const persistent = getPersistentAttachmentUrl(raw);
  const id = persistent ? extractAttachmentId(persistent) : null;
  if (!id) return raw;
  const offline = offlineObjectUrls.get(id);
  if (offline) return offline;
  const signed = accessUrls.get(id);
  const stableSource = extractAttachmentId(raw) ? raw : persistent!;
  if (signed) return mergeSignedAttachmentUrl(stableSource, signed);

  // 旧正文可能已被污染为 http://127.0.0.1:3001/api/attachments/...
  // 即使签名映射尚未返回，只要本会话已经观察到真实 API origin，就先修正 host。
  const parsed = asAbsoluteUrl(stableSource);
  if (
    parsed
    && attachmentApiOrigin
    && isLoopbackHostname(parsed.hostname)
    && parsed.origin !== attachmentApiOrigin
  ) {
    return moveUrlToOrigin(parsed, attachmentApiOrigin).toString();
  }
  return stableSource;
}

export interface AttachmentRenderSource {
  attachmentId: string | null;
  persistentSrc: string;
  resolvedSrc: string;
  offlineObjectUrlHit: boolean;
  signedUrlPresent: boolean;
  accessStateRevision: number;
}

export function getAttachmentRenderSource(raw: string | null | undefined): AttachmentRenderSource {
  const original = raw || "";
  const persistent = getPersistentAttachmentUrl(original) || original;
  const attachmentId = extractAttachmentId(persistent);
  const offlineUrl = attachmentId ? offlineObjectUrls.get(attachmentId) : undefined;
  return {
    attachmentId,
    persistentSrc: persistent,
    resolvedSrc: resolveAttachmentAccessUrl(original),
    offlineObjectUrlHit: !!offlineUrl,
    signedUrlPresent: !!(attachmentId && accessUrls.has(attachmentId)),
    accessStateRevision,
  };
}

/** 仅在当前 active offline URL 加载失败时移除它，让订阅者回退到签名/网络 URL。 */
export function invalidateOfflineAttachmentRenderUrl(value: string): boolean {
  const entry = offlineObjectUrlEntries.get(value);
  if (!entry || entry.retired || offlineObjectUrls.get(entry.id) !== value) return false;
  retireOfflineObjectUrl(entry.id);
  notifyAttachmentAccessChanged();
  queueDomScan();
  return true;
}

/** 测试隔离；生产代码无需调用。 */
export function resetAttachmentAccessStateForTests(): void {
  const hadEntries = accessUrls.size > 0 || offlineObjectUrls.size > 0 || !!attachmentApiOrigin;
  accessUrls.clear();
  forceRevokeAllOfflineObjectUrls();
  attachmentApiOrigin = "";
  scanQueued = false;
  lastDeniedToastAt = 0;
  if (hadEntries) notifyAttachmentAccessChanged();
}

function isEditableDocumentElement(element: Element): boolean {
  return Boolean(element.closest('[contenteditable="true"], .ProseMirror'));
}

function rewriteElementAttribute(element: Element, attribute: string): void {
  const raw = element.getAttribute(attribute);
  if (!raw) return;
  const rememberedId = element.getAttribute("data-nowen-attachment-id");
  const rawId = extractAttachmentId(raw);
  const attachmentId = rawId || (rememberedId && ATTACHMENT_ID_RE.test(rememberedId) ? rememberedId : null);
  const source = attachmentId && raw.startsWith("blob:")
    ? `/api/attachments/${attachmentId}`
    : raw;
  const resolved = resolveAttachmentAccessUrl(source);
  if (attachmentId) element.setAttribute("data-nowen-attachment-id", attachmentId);
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

function apiBaseFromRequestUrl(url: URL): string {
  const marker = "/api/";
  const index = url.pathname.indexOf(marker);
  const prefix = index >= 0 ? url.pathname.slice(0, index) : "";
  return `${url.origin}${prefix}/api`;
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
  const shareSession = source.get("X-Share-Session");
  if (shareSession) headers.set("X-Share-Session", shareSession);
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
      const accessUrl = new URL(`${apiBaseFromRequestUrl(url)}/attachments/access/urls`);
      accessUrl.searchParams.set("noteId", decodeURIComponent(noteMatch[1]));
      accessPromise = fetchAccessUrls(originalFetch, accessUrl, authHeaders(input, init), credentials);
    } else if (method === "GET" && shareMatch) {
      // 必须在正文接口自增 viewCount 之前签发，否则 maxViews=1 的首次访问会立即失效。
      const accessUrl = new URL(`${apiBaseFromRequestUrl(url)}/attachments/share-access`);
      accessUrl.searchParams.set("token", decodeURIComponent(shareMatch[1]));
      const headers = authHeaders(input, init);
      if (!headers.has("X-Share-Session")) headers.set("X-Share-Session", getShareSessionId());
      await fetchAccessUrls(originalFetch, accessUrl, headers, credentials);
    }

    const response = await originalFetch(input, init);
    if (accessPromise) await accessPromise;
    if (response.ok && (noteMatch || shareMatch)) queueDomScan();
    if (extractAttachmentId(url.toString())) void showAttachmentDenied(response);
    return response;
  };
}
