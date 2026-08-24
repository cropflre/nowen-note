import dns from "node:dns/promises";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import { domainToASCII } from "node:url";

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

type RegistryFetchErrorCode =
  | "REGISTRY_URL_DENIED"
  | "REGISTRY_DNS_ERROR"
  | "REGISTRY_NETWORK_ERROR"
  | "REGISTRY_TIMEOUT"
  | "REGISTRY_REDIRECT_INVALID"
  | "REGISTRY_REDIRECT_LIMIT"
  | "REGISTRY_PAYLOAD_TOO_LARGE"
  | "REGISTRY_HTTP_ERROR";

const CONTROL_OR_CONFUSING = /[\u0000-\u0020\u007f\u00a0\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 20_000;

function codedError(message: string, code: RegistryFetchErrorCode): Error & { code: RegistryFetchErrorCode } {
  return Object.assign(new Error(message), { code });
}

function isCodedError(error: unknown): error is Error & { code: RegistryFetchErrorCode } {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string"
    && String((error as Error & { code: string }).code).startsWith("REGISTRY_");
}

function isPublicIPv4(address: string): boolean {
  if (!net.isIPv4(address)) return false;
  const [a, b, c] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function mappedIPv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const tail = lower.slice("::ffff:".length);
  if (net.isIPv4(tail)) return tail;
  const match = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!match) return null;
  const high = Number.parseInt(match[1], 16);
  const low = Number.parseInt(match[2], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isPublicIPv6(address: string): boolean {
  if (!net.isIPv6(address) || address.includes("%")) return false;
  const lower = address.toLowerCase();
  const mapped = mappedIPv4(lower);
  if (mapped) return isPublicIPv4(mapped);
  if (lower === "::" || lower === "::1") return false;
  const firstGroup = Number.parseInt(lower.split(":", 1)[0] || "0", 16);
  if (!Number.isFinite(firstGroup)) return false;
  // Global unicast is 2000::/3. Everything outside is denied by default.
  if (firstGroup < 0x2000 || firstGroup > 0x3fff) return false;
  if ((firstGroup & 0xfe00) === 0xfc00) return false; // ULA (defensive; outside 2000::/3 today)
  if ((firstGroup & 0xffc0) === 0xfe80 || (firstGroup & 0xffc0) === 0xfec0) return false;
  if ((firstGroup & 0xff00) === 0xff00) return false;
  if (lower.startsWith("2001:db8:") || lower === "2001:db8::") return false;
  if (lower.startsWith("2001:0:") || lower.startsWith("2001:1:")) return false;
  if (lower.startsWith("2002:")) return false;
  if (lower.startsWith("3fff:")) return false;
  return true;
}

function isPublicAddress(address: string): boolean {
  return net.isIPv4(address) ? isPublicIPv4(address) : net.isIPv6(address) ? isPublicIPv6(address) : false;
}

function normalizeHostname(value: string): string {
  const raw = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (!raw || raw.includes("%") || CONTROL_OR_CONFUSING.test(raw)) {
    throw codedError("Registry 主机名无效", "REGISTRY_URL_DENIED");
  }
  if (net.isIP(raw)) return raw.toLowerCase();
  const ascii = domainToASCII(raw).toLowerCase().replace(/\.$/, "");
  if (!ascii || ascii.length > 253 || ascii.includes("*") || net.isIP(ascii)) {
    throw codedError("Registry 主机名无效", "REGISTRY_URL_DENIED");
  }
  const labels = ascii.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith("-") || label.endsWith("-"))) {
    throw codedError("Registry 主机名无效", "REGISTRY_URL_DENIED");
  }
  return ascii;
}

function normalizeRemoteUrl(value: string): { url: URL; hostname: string } {
  if (!value || value.length > 8192 || value.includes("\\") || value.includes("#") || CONTROL_OR_CONFUSING.test(value)) {
    throw codedError("Registry URL 无效", "REGISTRY_URL_DENIED");
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw codedError("Registry URL 无效", "REGISTRY_URL_DENIED"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw codedError("Registry 只允许无凭证、无片段的 HTTPS URL", "REGISTRY_URL_DENIED");
  }
  const hostname = normalizeHostname(url.hostname);
  url.hostname = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
  return { url, hostname };
}

async function resolvePinned(hostname: string): Promise<PinnedAddress[]> {
  const literal = net.isIP(hostname);
  if (literal) {
    if (!isPublicAddress(hostname)) throw codedError("Registry 禁止访问非公网地址", "REGISTRY_URL_DENIED");
    return [{ address: hostname, family: literal as 4 | 6 }];
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw codedError("Registry DNS 解析失败", "REGISTRY_DNS_ERROR");
  }
  const pinned = addresses
    .filter((item): item is { address: string; family: 4 | 6 } => item.family === 4 || item.family === 6)
    .map((item) => ({ address: item.address, family: item.family }));
  if (!pinned.length) throw codedError("Registry DNS 未返回可用地址", "REGISTRY_DNS_ERROR");
  if (pinned.some((item) => !isPublicAddress(item.address))) {
    throw codedError("Registry DNS 返回非公网地址", "REGISTRY_URL_DENIED");
  }
  return [...new Map(pinned.map((item) => [`${item.family}:${item.address}`, item])).values()];
}

function pinnedLookup(addresses: PinnedAddress[]): LookupFunction {
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const lookupOptions = typeof options === "object" && options !== null
      ? options as { all?: boolean; family?: number }
      : { family: typeof options === "number" ? options : 0 };
    const candidates = lookupOptions.family === 4 || lookupOptions.family === 6
      ? addresses.filter((item) => item.family === lookupOptions.family)
      : addresses;
    if (!candidates.length) {
      callback(Object.assign(new Error("Pinned Registry DNS 地址族不可用"), { code: "ENOTFOUND" }));
      return;
    }
    if (lookupOptions.all) {
      callback(null, candidates.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  }) as LookupFunction;
}

async function requestPinned(url: URL, hostname: string, addresses: PinnedAddress[], maxBytes: number, timeoutMs: number): Promise<{
  status: number;
  location: string | undefined;
  body: Buffer;
}> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (error: unknown, result?: { status: number; location: string | undefined; body: Buffer }): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(isCodedError(error) ? error : codedError("Registry 网络请求失败", "REGISTRY_NETWORK_ERROR"));
      else resolve(result!);
    };
    const outgoing = https.request(url, {
      method: "GET",
      headers: { "accept-encoding": "identity" },
      agent: false,
      lookup: pinnedLookup(addresses),
      servername: net.isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: true,
    }, (incoming) => {
      const status = incoming.statusCode || 0;
      const location = typeof incoming.headers.location === "string" ? incoming.headers.location : undefined;
      const declared = incoming.headers["content-length"];
      if (declared !== undefined) {
        const size = Number(declared);
        if (!Number.isSafeInteger(size) || size < 0) {
          incoming.destroy();
          finish(codedError("Registry Content-Length 无效", "REGISTRY_NETWORK_ERROR"));
          return;
        }
        if (size > maxBytes) {
          incoming.destroy();
          finish(codedError("Registry 响应超过大小限制", "REGISTRY_PAYLOAD_TOO_LARGE"));
          return;
        }
      }
      if (status >= 300 && status < 400) {
        incoming.destroy();
        finish(null, { status, location, body: Buffer.alloc(0) });
        return;
      }
      if (status < 200 || status >= 300) {
        incoming.resume();
        finish(codedError(`Registry 请求失败: HTTP ${status}`, "REGISTRY_HTTP_ERROR"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      incoming.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > maxBytes) {
          incoming.destroy(codedError("Registry 响应超过大小限制", "REGISTRY_PAYLOAD_TOO_LARGE"));
          return;
        }
        chunks.push(buffer);
      });
      incoming.once("end", () => finish(null, { status, location, body: Buffer.concat(chunks, total) }));
      incoming.once("error", (error) => finish(error));
    });
    timer = setTimeout(() => outgoing.destroy(codedError("Registry 请求超时", "REGISTRY_TIMEOUT")), timeoutMs);
    timer.unref();
    outgoing.once("error", (error) => finish(error));
    outgoing.end();
  });
}

/**
 * Registry/Artifact 专用二进制安全传输：先解析并校验 DNS，再把 HTTPS socket 固定到同一批公网 IP。
 * 每次重定向都会重新执行 URL + DNS 校验，避免 validate-then-fetch 的 DNS rebinding/TOCTOU。
 */
export async function secureRegistryFetch(urlValue: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw codedError("Registry 响应预算无效", "REGISTRY_PAYLOAD_TOO_LARGE");
  }
  let target = normalizeRemoteUrl(urlValue);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const addresses = await resolvePinned(target.hostname);
    const response = await requestPinned(target.url, target.hostname, addresses, maxBytes, DEFAULT_TIMEOUT_MS);
    if (response.status < 300 || response.status >= 400) return response.body;
    if (!response.location) throw codedError("Registry 重定向缺少 Location", "REGISTRY_REDIRECT_INVALID");
    if (redirects === MAX_REDIRECTS) throw codedError("Registry 重定向次数过多", "REGISTRY_REDIRECT_LIMIT");
    let next: string;
    try { next = new URL(response.location, target.url).href; }
    catch { throw codedError("Registry 重定向 Location 无效", "REGISTRY_REDIRECT_INVALID"); }
    target = normalizeRemoteUrl(next);
  }
  throw codedError("Registry 重定向次数过多", "REGISTRY_REDIRECT_LIMIT");
}
