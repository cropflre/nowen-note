import dns from "dns";
import net from "net";

const DEFAULT_DNS_TIMEOUT_MS = 3_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 5;

export interface DnsSafetyResult {
  safe: boolean;
  error?: string;
  addresses?: string[];
}

export interface SafeRemoteFetchOptions {
  fetchTimeout?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

type LookupAddress = { address: string; family: number };
type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

function normalizeIp(ip: string): string {
  const zoneIndex = ip.indexOf("%");
  const withoutZone = zoneIndex >= 0 ? ip.slice(0, zoneIndex) : ip;
  const mapped = withoutZone.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return mapped?.[1] || withoutZone;
}

export function isPrivateOrReservedIp(input: string): boolean {
  const ip = normalizeIp(input);
  const family = net.isIP(ip);
  if (family === 4) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    );
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === "::"
      || lower === "::1"
      || lower.startsWith("fc")
      || lower.startsWith("fd")
      || /^fe[89ab]/.test(lower)
      || lower.startsWith("ff")
      || lower.startsWith("2001:db8:")
    );
  }
  return true;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

const systemLookup: LookupAll = async (hostname) => {
  const result = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return result.map(({ address, family }) => ({ address, family }));
};

/**
 * Resolve through the operating system resolver instead of dns.resolve4/6.
 * This honours Docker/WSL resolver configuration, VPN DNS, split DNS and hosts
 * entries while still rejecting every private/reserved result.
 */
export async function checkDnsSafety(
  hostname: string,
  options: { timeoutMs?: number; lookup?: LookupAll } = {},
): Promise<DnsSafetyResult> {
  const normalizedHost = hostname.trim().replace(/^\[|\]$/g, "");
  if (!normalizedHost) return { safe: false, error: "域名为空" };

  const literalFamily = net.isIP(normalizedHost);
  let addresses: LookupAddress[];
  try {
    addresses = literalFamily
      ? [{ address: normalizedHost, family: literalFamily }]
      : await withTimeout(
        (options.lookup || systemLookup)(normalizedHost),
        options.timeoutMs || DEFAULT_DNS_TIMEOUT_MS,
        "DNS lookup",
      );
  } catch (error: any) {
    const code = error?.code ? ` (${error.code})` : "";
    return { safe: false, error: `DNS 解析失败${code}: ${error?.message || error}` };
  }

  const unique = Array.from(new Set(addresses.map(({ address }) => normalizeIp(address))));
  if (unique.length === 0) return { safe: false, error: "DNS 解析未返回地址" };
  for (const address of unique) {
    if (isPrivateOrReservedIp(address)) {
      return { safe: false, error: `域名指向私有或保留 IP: ${address}`, addresses: unique };
    }
  }
  return { safe: true, addresses: unique };
}

export async function assertSafeRemoteUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`不支持的协议: ${url.protocol}`);
  }
  if (url.username || url.password) throw new Error("URL 不允许包含用户名或密码");
  const result = await checkDnsSafety(url.hostname);
  if (!result.safe) throw new Error(result.error || "DNS 安全检查失败");
}

/** Fetch with SSRF validation before the initial request and every redirect. */
export async function safeRemoteFetch(
  input: string,
  options: SafeRemoteFetchOptions = {},
): Promise<Response> {
  const timeout = options.fetchTimeout || DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = new URL(input);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    await assertSafeRemoteUrl(current);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try {
      response = await fetch(current, {
        headers: options.headers || {},
        signal: controller.signal,
        redirect: "manual",
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirectCount >= maxRedirects) throw new Error(`重定向次数超过限制: ${maxRedirects}`);
      try { await response.body?.cancel(); } catch { /* ignore */ }
      current = new URL(location, current);
      continue;
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > maxBytes) {
      try { await response.body?.cancel(); } catch { /* ignore */ }
      throw new Error(`响应体过大: ${contentLength} bytes`);
    }
    return response;
  }

  throw new Error("重定向处理失败");
}
