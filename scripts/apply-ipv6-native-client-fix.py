from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8-sig")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one marker, found {count}: {old[:100]!r}")
    write(path, content.replace(old, new, 1))


server_url = r'''/**
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
'''
write("frontend/src/lib/serverUrl.ts", server_url)

replace_once(
    "frontend/src/components/ServerAddressInput.tsx",
    '''  parseServerUrl,\n  normalizeServerBaseUrl,\n  type ServerAddressParts,''',
    '''  parseServerUrl,\n  normalizeServerBaseUrl,\n  formatServerHost,\n  type ServerAddressParts,''',
)
replace_once(
    "frontend/src/components/ServerAddressInput.tsx",
    '''function partsToDisplayText(parts: ServerAddressParts): string {\n  let text = parts.host;''',
    '''function partsToDisplayText(parts: ServerAddressParts): string {\n  let text = formatServerHost(parts.host);''',
)

# WHATWG URL implementations may expose IPv6 loopback as either ::1 or [::1].
for path in (ROOT / "frontend/src").rglob("*.ts"):
    content = path.read_text(encoding="utf-8-sig")
    next_content = content.replace(
        'u.hostname === "::1"',
        '(u.hostname === "::1" || u.hostname === "[::1]")',
    ).replace(
        'url.hostname === "::1"',
        '(url.hostname === "::1" || url.hostname === "[::1]")',
    )
    if next_content != content:
        path.write_text(next_content, encoding="utf-8")
for path in (ROOT / "frontend/src").rglob("*.tsx"):
    content = path.read_text(encoding="utf-8-sig")
    next_content = content.replace(
        'u.hostname === "::1"',
        '(u.hostname === "::1" || u.hostname === "[::1]")',
    ).replace(
        'url.hostname === "::1"',
        '(url.hostname === "::1" || url.hostname === "[::1]")',
    )
    if next_content != content:
        path.write_text(next_content, encoding="utf-8")

server_tests = read("frontend/src/lib/__tests__/serverUrl.test.ts")
server_tests = server_tests.replace(
    'import { normalizeServerBaseUrl, isValidServerUrl, buildServerUrl, parseServerUrl } from "../serverUrl";',
    'import { normalizeServerBaseUrl, isValidServerUrl, buildServerUrl, parseServerUrl, isLoopbackServerHostname } from "../serverUrl";',
)
ipv6_tests = r'''

describe("IPv6 server URL support", () => {
  const ipv6 = "240e:35c:41f:4c00::1d0";

  it("normalizes a bare IPv6 literal with brackets", () => {
    expect(normalizeServerBaseUrl(ipv6)).toBe(`http://[${ipv6}]`);
  });

  it("preserves bracketed IPv6 and an explicit port", () => {
    expect(normalizeServerBaseUrl(`[${ipv6}]:3001`)).toBe(`http://[${ipv6}]:3001`);
    expect(normalizeServerBaseUrl(`https://[${ipv6}]:3443`)).toBe(`https://[${ipv6}]:3443`);
  });

  it("repairs a full URL containing an unbracketed IPv6 literal", () => {
    expect(normalizeServerBaseUrl(`http://${ipv6}`)).toBe(`http://[${ipv6}]`);
  });

  it("removes a copied /128 CIDR suffix instead of treating it as a path", () => {
    expect(normalizeServerBaseUrl(`${ipv6}/128`)).toBe(`http://[${ipv6}]`);
    expect(normalizeServerBaseUrl(`http://[${ipv6}]/128`)).toBe(`http://[${ipv6}]`);
  });

  it("rejects invalid IPv6 CIDR prefix lengths", () => {
    expect(normalizeServerBaseUrl(`${ipv6}/129`)).toBe("");
  });

  it("round-trips IPv6 through parse and build", () => {
    const parsed = parseServerUrl(`http://[${ipv6}]:3001/api/health`);
    expect(parsed).toEqual({
      protocol: "http",
      host: `[${ipv6}]`,
      port: "3001",
      path: "",
    });
    expect(buildServerUrl(parsed)).toBe(`http://[${ipv6}]:3001`);
  });

  it("builds a standards-compliant URL from an unbracketed IPv6 host field", () => {
    expect(buildServerUrl({ protocol: "http", host: ipv6, port: "3001", path: "" }))
      .toBe(`http://[${ipv6}]:3001`);
  });

  it("builds API and WebSocket endpoints without losing IPv6 brackets", () => {
    const base = normalizeServerBaseUrl(`http://[${ipv6}]:3001`);
    expect(`${base}/api/health`).toBe(`http://[${ipv6}]:3001/api/health`);
    expect(`${base.replace(/^http/, "ws")}/ws?token=abc`)
      .toBe(`ws://[${ipv6}]:3001/ws?token=abc`);
  });

  it("recognizes both browser variants of IPv6 loopback hostname", () => {
    expect(isLoopbackServerHostname("::1")).toBe(true);
    expect(isLoopbackServerHostname("[::1]")).toBe(true);
    expect(isLoopbackServerHostname(ipv6)).toBe(false);
  });
});
'''
if 'describe("IPv6 server URL support"' not in server_tests:
    server_tests += ipv6_tests
write("frontend/src/lib/__tests__/serverUrl.test.ts", server_tests)

native_tests = read("frontend/src/lib/__tests__/apiNativeHttpFallback.test.ts")
ipv6_native_test = r'''

describe("api native HTTP fallback with IPv6 server", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    capacitorHttpRequestMock.mockReset();
    localStorage.clear();
    delete (window as any).Capacitor;
  });

  it("passes a bracketed IPv6 API URL to CapacitorHttp", async () => {
    localStorage.setItem("nowen-server-url", "240e:35c:41f:4c00::1d0/128");
    localStorage.setItem("nowen-token", "token-ipv6");
    (window as any).Capacitor = { isNativePlatform: () => true };
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    capacitorHttpRequestMock.mockResolvedValueOnce({
      status: 200,
      headers: { "content-type": "application/json" },
      data: { id: "u-ipv6", username: "ipv6-user" },
    });

    await expect(api.getMe()).resolves.toEqual({ id: "u-ipv6", username: "ipv6-user" });
    expect(capacitorHttpRequestMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "http://[240e:35c:41f:4c00::1d0]/api/me",
      method: "GET",
    }));
  });
});
'''
if 'describe("api native HTTP fallback with IPv6 server"' not in native_tests:
    native_tests += ipv6_native_test
write("frontend/src/lib/__tests__/apiNativeHttpFallback.test.ts", native_tests)
