/**
 * 服务器地址工具
 *
 * 核心概念：serverBaseUrl = protocol://host[:port][/path-prefix]
 *   - 不含 /api 后缀（由 getBaseUrl() 拼接）
 *   - 不含末尾斜杠
 *   - 保留反代 path 前缀
 *   - IPv6 字面量始终使用 URI 标准方括号格式
 */

export type ServerScheme = "http" | "https";

export interface ServerAddressParts {
  protocol: ServerScheme;
  host: string;
  /** 字符串形式，空串表示不指定 */
  port: string;
  /** 反代路径前缀，如 /user:3001；空串表示无 path */
  path: string;
}

function stripApiSuffix(pathname: string): string {
  const apiSuffixRe = /\/api(\/.*)?$/;
  const match = pathname.match(apiSuffixRe);
  if (!match) return pathname;
  return pathname.slice(0, match.index) || "";
}

function colonCount(value: string): number {
  return (value.match(/:/g) || []).length;
}

function removeIpv6Brackets(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;
}

function looksLikeIpv6Authority(value: string): boolean {
  const authority = value.trim();
  if (!authority) return false;
  if (authority.startsWith("[")) return authority.includes("]");
  return colonCount(authority) >= 2;
}

/** 把 IPv6 主机格式化成 URI authority 所需的 [address] 形式。 */
export function formatServerHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed;
  return looksLikeIpv6Authority(trimmed) ? `[${trimmed}]` : trimmed;
}

/** URL.hostname 在不同 WebView/Node 版本中可能返回 ::1 或 [::1]。 */
export function isLoopbackServerHostname(hostname: string): boolean {
  const normalized = removeIpv6Brackets(hostname).toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function authorityFromInput(value: string): string {
  const withoutScheme = value.replace(/^https?:\/\//i, "");
  const boundary = withoutScheme.search(/[/?#]/);
  return boundary >= 0 ? withoutScheme.slice(0, boundary) : withoutScheme;
}

/**
 * 用户常从 NAS 网络页复制 `240e:...::1/128`。/128 是网段前缀长度，
 * 不是 HTTP 路径。合法 IPv6 CIDR 会清掉；超过 128 的前缀直接判非法，
 * 避免静默请求到错误的 `/129` 路径。
 */
function stripIpv6CidrSuffix(value: string): { value: string; invalid: boolean } {
  const match = value.match(/^(.*)\/(\d{1,3})\/?$/);
  if (!match) return { value, invalid: false };

  const authority = authorityFromInput(match[1]);
  if (!looksLikeIpv6Authority(authority)) return { value, invalid: false };

  const prefix = Number(match[2]);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) {
    return { value: "", invalid: true };
  }
  return { value: match[1], invalid: false };
}

function splitAuthorityAndSuffix(value: string): { authority: string; suffix: string } {
  const boundary = value.search(/[/?#]/);
  if (boundary < 0) return { authority: value, suffix: "" };
  return { authority: value.slice(0, boundary), suffix: value.slice(boundary) };
}

function normalizeAuthority(authority: string): string {
  const trimmed = authority.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("[")) return trimmed;
  return looksLikeIpv6Authority(trimmed) ? `[${trimmed}]` : trimmed;
}

/**
 * 在交给 WHATWG URL 之前修正裸 IPv6：
 *   240e:...::1       -> http://[240e:...::1]
 *   http://240e:...::1 -> http://[240e:...::1]
 *
 * IPv6 + 端口必须采用标准 `[IPv6]:port`。未加方括号时无法可靠区分
 * 最后一个 hextet 和端口，因此不会猜测端口。
 */
function prepareUrlInput(input: string): string {
  const cidr = stripIpv6CidrSuffix(input);
  if (cidr.invalid || !cidr.value) return "";
  const cleaned = cidr.value;

  const schemeMatch = cleaned.match(/^(https?):\/\/(.*)$/i);
  if (schemeMatch) {
    const { authority, suffix } = splitAuthorityAndSuffix(schemeMatch[2]);
    const normalizedAuthority = normalizeAuthority(authority);
    return normalizedAuthority
      ? `${schemeMatch[1].toLowerCase()}://${normalizedAuthority}${suffix}`
      : "";
  }

  const { authority, suffix } = splitAuthorityAndSuffix(cleaned);
  const normalizedAuthority = normalizeAuthority(authority);
  return normalizedAuthority ? `http://${normalizedAuthority}${suffix}` : "";
}

/**
 * 将用户输入归一化为 serverBaseUrl。
 * 支持域名、IPv4、裸/方括号 IPv6、端口和反向代理路径。
 */
export function normalizeServerBaseUrl(input: string | null | undefined): string {
  if (!input) return "";
  const raw = input.trim();
  if (!raw) return "";
  if (raw === "null" || raw === "undefined" || raw === "file://" || raw.startsWith("file:")) {
    return "";
  }

  const prepared = prepareUrlInput(raw);
  if (!prepared) return "";

  let url: URL;
  try {
    url = new URL(prepared);
  } catch {
    return "";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  if (!url.hostname) return "";

  // url.host 会保留 IPv6 方括号和显式端口，不能再用 hostname 手动拼接。
  const protocol = url.protocol === "https:" ? "https" : "http";
  const pathPrefix = stripApiSuffix(url.pathname).replace(/\/+$/, "");
  return `${protocol}://${url.host}${pathPrefix}`;
}

/**
 * Web 端被部署在反向代理子路径时，从当前页面地址推断 serverBaseUrl。
 * 原生客户端与 Electron 使用显式服务器地址，不走这里。
 */
export function inferBrowserServerBaseUrl(
  locationLike: Pick<Location, "protocol" | "origin" | "pathname"> | null =
    typeof window !== "undefined" ? window.location : null,
): string {
  if (!locationLike || !/^https?:$/.test(locationLike.protocol)) return "";

  let pathname = locationLike.pathname.replace(/\/+$/, "");
  const routeSuffix = pathname.match(/\/(?:share|notebook-share)\/[A-Za-z0-9_-]+$/)?.[0]
    || pathname.match(/\/login$/)?.[0]
    || "";
  if (routeSuffix) pathname = pathname.slice(0, -routeSuffix.length);
  if (!pathname || pathname === "/") return "";
  return normalizeServerBaseUrl(`${locationLike.origin}${pathname}`);
}

/** 把浏览器 pathname 转换为去除反代前缀后的应用内路由。 */
export function stripServerBasePath(pathname: string, serverBaseUrl: string): string {
  if (!serverBaseUrl) return pathname || "/";
  try {
    const basePath = new URL(serverBaseUrl).pathname.replace(/\/+$/, "");
    if (!basePath || basePath === "/") return pathname || "/";
    if (pathname === basePath) return "/";
    if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length) || "/";
  } catch {
    // 无效地址交给调用方按原路径处理。
  }
  return pathname || "/";
}

export function isValidServerUrl(input: string | null | undefined): boolean {
  return normalizeServerBaseUrl(input) !== "";
}

export function parseServerUrl(input: string | null | undefined): ServerAddressParts {
  const fallback: ServerAddressParts = { protocol: "http", host: "", port: "", path: "" };
  const normalized = normalizeServerBaseUrl(input);
  if (!normalized) return fallback;

  try {
    const url = new URL(normalized);
    return {
      protocol: url.protocol === "https:" ? "https" : "http",
      // Chromium/Node 对 IPv6 hostname 会保留 []；buildServerUrl 同时兼容带/不带括号。
      host: url.hostname,
      port: url.port || "",
      path: stripApiSuffix(url.pathname).replace(/\/+$/, ""),
    };
  } catch {
    return fallback;
  }
}

function normalizeHost(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  // 调用方偶尔把完整 URL 塞进 host；优先走统一解析，避免另一套 IPv6 规则。
  if (/^https?:\/\//i.test(trimmed)) {
    const normalized = normalizeServerBaseUrl(trimmed);
    if (!normalized) return "";
    try { return new URL(normalized).hostname; } catch { return ""; }
  }

  const cidr = stripIpv6CidrSuffix(trimmed);
  if (cidr.invalid || !cidr.value) return "";
  let value = cidr.value.replace(/^\/\//, "");
  const boundary = value.search(/[/?#]/);
  if (boundary >= 0) value = value.slice(0, boundary);

  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0) return "";
    return value.slice(0, close + 1);
  }

  if (looksLikeIpv6Authority(value)) return formatServerHost(value);
  return value.replace(/:\d+$/, "");
}

function normalizePort(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return /^\d+$/.test(trimmed) ? trimmed : "";
}

export function buildServerUrl(parts: ServerAddressParts): string {
  const host = normalizeHost(parts.host);
  if (!host) return "";
  const port = normalizePort(parts.port);
  let base = `${parts.protocol}://${host}`;
  if (port) base += `:${port}`;
  const path = (parts.path || "").replace(/\/+$/, "");
  if (path) base += path.startsWith("/") ? path : `/${path}`;
  return normalizeServerBaseUrl(base);
}
