import dns from "node:dns/promises";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import { domainToASCII } from "node:url";

export interface ExternalFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  /** 仅供 Host Broker 注入已授权的 Connection 凭证，插件输入不得写入此字段。 */
  trustedHeaders?: Record<string, string>;
}

export interface ExternalFetchResponse {
  status: number;
  ok: boolean;
  headers: { "content-type": string | null };
  body: string;
}

export interface SecureExternalFetchOptions {
  allowedHosts: string[];
  timeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
}

type ExternalFetchErrorCode =
  | "EXTERNAL_FETCH_INVALID_URL"
  | "EXTERNAL_FETCH_DENIED"
  | "EXTERNAL_FETCH_DNS_ERROR"
  | "EXTERNAL_FETCH_NETWORK_ERROR"
  | "EXTERNAL_FETCH_TIMEOUT"
  | "EXTERNAL_FETCH_INVALID_REDIRECT"
  | "EXTERNAL_FETCH_REDIRECT_LIMIT"
  | "EXTERNAL_FETCH_RESPONSE_TOO_LARGE";

interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

interface NormalizedTarget {
  url: URL;
  hostname: string;
  port: number;
}

interface PreparedRequest {
  method: string;
  headers: Record<string, string>;
  body: Buffer | undefined;
  sensitiveHeaders: Set<string>;
}

interface RawResponse {
  status: number;
  contentType: string | null;
  location: string | undefined;
  body: Buffer;
}

interface Cidr {
  bytes: Uint8Array;
  prefix: number;
}

const MAX_CNAME_DEPTH = 16;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_HEADERS = new Set(["authorization", "cookie", "proxy-authorization"]);
const PROXY_ROUTING_HEADERS = [
  "cf-connecting-ip",
  "client-ip",
  "fastly-client-ip",
  "forwarded",
  "true-client-ip",
  "via",
  "x-client-ip",
  "x-cluster-client-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-forwarded-server",
  "x-original-forwarded-for",
  "x-original-host",
  "x-original-url",
  "x-real-ip",
  "x-rewrite-url",
] as const;
const BLOCKED_REQUEST_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  ...SENSITIVE_HEADERS,
  ...PROXY_ROUTING_HEADERS,
]);
const BLOCKED_TRUSTED_HEADERS = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  ...PROXY_ROUTING_HEADERS,
]);
const METHOD_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CONFUSING_INPUT = /[\u0000-\u0020\u007f\u00a0\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function externalError(message: string, code: ExternalFetchErrorCode): Error & { code: ExternalFetchErrorCode } {
  return Object.assign(new Error(message), { code });
}

function hasExternalCode(error: unknown): error is Error & { code: ExternalFetchErrorCode } {
  return error instanceof Error && typeof (error as Error & { code?: unknown }).code === "string"
    && String((error as Error & { code: string }).code).startsWith("EXTERNAL_FETCH_");
}

function parseIPv4(address: string): Uint8Array | null {
  if (!net.isIPv4(address)) return null;
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => Number(part));
  if (bytes.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return Uint8Array.from(bytes);
}

function parseIPv6(address: string): Uint8Array | null {
  if (!net.isIPv6(address) || address.includes("%")) return null;
  let source = address.toLowerCase();
  const lastColon = source.lastIndexOf(":");
  if (source.includes(".")) {
    if (lastColon < 0) return null;
    const embedded = parseIPv4(source.slice(lastColon + 1));
    if (!embedded) return null;
    source = `${source.slice(0, lastColon)}:${((embedded[0] << 8) | embedded[1]).toString(16)}:${((embedded[2] << 8) | embedded[3]).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = new Uint8Array(16);
  for (let index = 0; index < groups.length; index += 1) {
    const value = Number.parseInt(groups[index], 16);
    bytes[index * 2] = value >>> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function cidr(address: string, prefix: number): Cidr {
  const bytes = parseIPv4(address) || parseIPv6(address);
  if (!bytes) throw new Error(`无效的内置 CIDR: ${address}/${prefix}`);
  return { bytes, prefix };
}

function matchesCidr(address: Uint8Array, range: Cidr): boolean {
  if (address.length !== range.bytes.length) return false;
  const wholeBytes = Math.floor(range.prefix / 8);
  const remainingBits = range.prefix % 8;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== range.bytes[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[wholeBytes] & mask) === (range.bytes[wholeBytes] & mask);
}

const NON_PUBLIC_IPV4 = [
  cidr("0.0.0.0", 8),
  cidr("10.0.0.0", 8),
  cidr("100.64.0.0", 10),
  cidr("127.0.0.0", 8),
  cidr("169.254.0.0", 16),
  cidr("172.16.0.0", 12),
  cidr("192.0.0.0", 24),
  cidr("192.0.2.0", 24),
  cidr("192.31.196.0", 24),
  cidr("192.52.193.0", 24),
  cidr("192.88.99.0", 24),
  cidr("192.168.0.0", 16),
  cidr("192.175.48.0", 24),
  cidr("198.18.0.0", 15),
  cidr("198.51.100.0", 24),
  cidr("203.0.113.0", 24),
  cidr("224.0.0.0", 4),
  cidr("240.0.0.0", 4),
];

// IANA IPv6 全球单播分配表（2025-10-10）：未列出的前缀一律按保留空间拒绝。
const ALLOCATED_GLOBAL_UNICAST_IPV6 = [
  cidr("2001:200::", 23),
  cidr("2001:400::", 23),
  cidr("2001:600::", 23),
  cidr("2001:800::", 22),
  cidr("2001:c00::", 23),
  cidr("2001:e00::", 23),
  cidr("2001:1200::", 23),
  cidr("2001:1400::", 22),
  cidr("2001:1800::", 23),
  cidr("2001:1a00::", 23),
  cidr("2001:1c00::", 22),
  cidr("2001:2000::", 19),
  cidr("2001:4000::", 23),
  cidr("2001:4200::", 23),
  cidr("2001:4400::", 23),
  cidr("2001:4600::", 23),
  cidr("2001:4800::", 23),
  cidr("2001:4a00::", 23),
  cidr("2001:4c00::", 23),
  cidr("2001:5000::", 20),
  cidr("2001:8000::", 19),
  cidr("2001:a000::", 20),
  cidr("2001:b000::", 20),
  cidr("2003::", 18),
  cidr("2400::", 12),
  cidr("2410::", 12),
  cidr("2600::", 12),
  cidr("2610::", 23),
  cidr("2620::", 23),
  cidr("2630::", 12),
  cidr("2800::", 12),
  cidr("2a00::", 12),
  cidr("2a10::", 12),
  cidr("2c00::", 12),
];
const NON_PUBLIC_IPV6 = [
  cidr("2001::", 23),
  cidr("2001:db8::", 32),
  cidr("2002::", 16),
  cidr("3fff::", 20),
];

function isPublicAddress(address: string): boolean {
  const ipv4 = parseIPv4(address);
  if (ipv4) return !NON_PUBLIC_IPV4.some((range) => matchesCidr(ipv4, range));
  const ipv6 = parseIPv6(address);
  if (!ipv6) return false;
  const mapped = ipv6.slice(0, 12).every((byte, index) => byte === (index >= 10 ? 0xff : 0));
  if (mapped) {
    const embedded = ipv6.slice(12);
    return !NON_PUBLIC_IPV4.some((range) => matchesCidr(embedded, range));
  }
  // 正向允许 IANA 已分配空间；NAT64、ULA、链路本地、多播及未登记空间默认拒绝。
  return ALLOCATED_GLOBAL_UNICAST_IPV6.some((range) => matchesCidr(ipv6, range))
    && !NON_PUBLIC_IPV6.some((range) => matchesCidr(ipv6, range));
}

function normalizeHostname(hostname: string): string {
  const withoutBrackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (!withoutBrackets || CONFUSING_INPUT.test(withoutBrackets) || withoutBrackets.includes("%")) {
    throw externalError("目标主机名无效", "EXTERNAL_FETCH_INVALID_URL");
  }
  if (net.isIP(withoutBrackets)) return withoutBrackets.toLowerCase();
  const ascii = domainToASCII(withoutBrackets).toLowerCase().replace(/\.$/, "");
  if (!ascii || ascii.length > 253 || ascii.includes("*") || net.isIP(ascii)) {
    throw externalError("目标主机名无效", "EXTERNAL_FETCH_INVALID_URL");
  }
  const labels = ascii.split(".");
  if (labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/.test(label)
    || label.startsWith("-") || label.endsWith("-"))) {
    throw externalError("目标主机名无效", "EXTERNAL_FETCH_INVALID_URL");
  }
  return ascii;
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 443;
  if (!/^\d{1,5}$/.test(value)) throw externalError("目标端口无效", "EXTERNAL_FETCH_INVALID_URL");
  const port = Number(value);
  if (port < 1 || port > 65_535) throw externalError("目标端口无效", "EXTERNAL_FETCH_INVALID_URL");
  return port;
}

function targetKey(hostname: string, port: number): string {
  return `${net.isIPv6(hostname) ? `[${hostname}]` : hostname}:${port}`;
}

function normalizeAllowedHost(entry: string): string {
  if (!entry || CONFUSING_INPUT.test(entry) || /[\\/@?#]/.test(entry) || entry.includes("*")) {
    throw externalError("external.fetch 白名单包含无效主机", "EXTERNAL_FETCH_DENIED");
  }
  let hostname: string;
  let portText: string | undefined;
  if (entry.startsWith("[")) {
    const closing = entry.indexOf("]");
    if (closing < 0 || entry.indexOf("]", closing + 1) >= 0) {
      throw externalError("IPv6 白名单格式无效", "EXTERNAL_FETCH_DENIED");
    }
    hostname = entry.slice(1, closing);
    const remainder = entry.slice(closing + 1);
    if (remainder && !remainder.startsWith(":")) {
      throw externalError("IPv6 白名单格式无效", "EXTERNAL_FETCH_DENIED");
    }
    portText = remainder ? remainder.slice(1) : undefined;
    if (!net.isIPv6(hostname)) throw externalError("IPv6 白名单格式无效", "EXTERNAL_FETCH_DENIED");
  } else {
    const colonCount = [...entry].filter((character) => character === ":").length;
    if (colonCount > 1) throw externalError("IPv6 白名单必须使用方括号", "EXTERNAL_FETCH_DENIED");
    const separator = entry.lastIndexOf(":");
    hostname = separator >= 0 ? entry.slice(0, separator) : entry;
    portText = separator >= 0 ? entry.slice(separator + 1) : undefined;
  }
  try {
    return targetKey(normalizeHostname(hostname), parsePort(portText));
  } catch (error) {
    if (hasExternalCode(error)) throw externalError(error.message, "EXTERNAL_FETCH_DENIED");
    throw error;
  }
}

function normalizeTarget(rawUrl: string, allowedHosts: Set<string>): NormalizedTarget {
  if (!rawUrl || CONFUSING_INPUT.test(rawUrl) || rawUrl.includes("\\") || rawUrl.includes("#")) {
    throw externalError("external.fetch URL 无效", "EXTERNAL_FETCH_INVALID_URL");
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw externalError("external.fetch URL 无效", "EXTERNAL_FETCH_INVALID_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw externalError("external.fetch 仅允许无凭证、无片段的 HTTPS URL", "EXTERNAL_FETCH_INVALID_URL");
  }
  const hostname = normalizeHostname(url.hostname);
  const port = parsePort(url.port || undefined);
  if (!allowedHosts.has(targetKey(hostname, port))) {
    throw externalError("目标主机或端口未在插件白名单", "EXTERNAL_FETCH_DENIED");
  }
  url.hostname = net.isIPv6(hostname) ? `[${hostname}]` : hostname;
  return { url, hostname, port };
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw externalError("external.fetch 请求超时", "EXTERNAL_FETCH_TIMEOUT");
  return remaining;
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const timeoutMs = remainingMs(deadline);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(externalError("external.fetch 请求超时", "EXTERNAL_FETCH_TIMEOUT")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isDnsNoData(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENODATA" || code === "ENOTFOUND";
}

async function resolveOptional(
  resolver: () => Promise<string[]>,
  deadline: number,
): Promise<string[]> {
  try {
    return await withinDeadline(resolver(), deadline);
  } catch (error) {
    if (hasExternalCode(error)) throw error;
    if (isDnsNoData(error)) return [];
    throw externalError("目标 DNS 解析失败", "EXTERNAL_FETCH_DNS_ERROR");
  }
}

async function resolvePinnedAddresses(hostname: string, deadline: number): Promise<PinnedAddress[]> {
  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (!isPublicAddress(hostname)) throw externalError("禁止访问非公网地址", "EXTERNAL_FETCH_DENIED");
    return [{ address: hostname, family: literalFamily as 4 | 6 }];
  }

  const visited = new Set<string>();
  let current = hostname;
  for (let depth = 0; depth <= MAX_CNAME_DEPTH; depth += 1) {
    if (visited.has(current)) throw externalError("目标 DNS CNAME 存在循环", "EXTERNAL_FETCH_DNS_ERROR");
    visited.add(current);
    const aliases = [...new Set(await resolveOptional(() => dns.resolveCname(current), deadline))];
    if (aliases.length === 0) break;
    if (aliases.length !== 1 || depth === MAX_CNAME_DEPTH) {
      throw externalError("目标 DNS CNAME 链无效或过深", "EXTERNAL_FETCH_DNS_ERROR");
    }
    try {
      current = normalizeHostname(aliases[0]);
    } catch {
      throw externalError("目标 DNS CNAME 无效", "EXTERNAL_FETCH_DNS_ERROR");
    }
  }

  const [ipv4, ipv6] = await Promise.all([
    resolveOptional(() => dns.resolve4(current), deadline),
    resolveOptional(() => dns.resolve6(current), deadline),
  ]);
  const addresses = [
    ...ipv4.map((address): PinnedAddress => ({ address, family: 4 })),
    ...ipv6.map((address): PinnedAddress => ({ address, family: 6 })),
  ];
  const unique = [...new Map(addresses.map((item) => [`${item.family}:${item.address}`, item])).values()];
  if (unique.length === 0) throw externalError("目标 DNS 未返回地址", "EXTERNAL_FETCH_DNS_ERROR");
  if (unique.some((item) => !isPublicAddress(item.address))) {
    throw externalError("目标 DNS 返回了非公网地址", "EXTERNAL_FETCH_DENIED");
  }
  return unique;
}

function normalizeHeaderValue(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw externalError("external.fetch Header 值无效", "EXTERNAL_FETCH_DENIED");
  }
  const normalized = String(value);
  if (/[^\t\x20-\x7e\x80-\xff]/u.test(normalized)) {
    throw externalError("external.fetch Header 值无效", "EXTERNAL_FETCH_DENIED");
  }
  return normalized;
}

function normalizeHeaderName(name: string): string {
  const normalized = name.toLowerCase();
  if (!HEADER_NAME_TOKEN.test(normalized)) {
    throw externalError("external.fetch Header 名称无效", "EXTERNAL_FETCH_DENIED");
  }
  return normalized;
}

function prepareRequest(request: ExternalFetchRequest): PreparedRequest {
  const method = String(request.method || "GET").toUpperCase();
  if (!METHOD_TOKEN.test(method) || method.length > 32 || method === "CONNECT" || method === "TRACE") {
    throw externalError("external.fetch 请求方法不受支持", "EXTERNAL_FETCH_DENIED");
  }
  const headers: Record<string, string> = { "accept-encoding": "identity" };
  for (const [rawName, value] of Object.entries(request.headers || {})) {
    const name = normalizeHeaderName(rawName);
    if (BLOCKED_REQUEST_HEADERS.has(name)) continue;
    headers[name] = normalizeHeaderValue(value);
  }
  const sensitiveHeaders = new Set(SENSITIVE_HEADERS);
  for (const [rawName, value] of Object.entries(request.trustedHeaders || {})) {
    const name = normalizeHeaderName(rawName);
    if (BLOCKED_TRUSTED_HEADERS.has(name)) {
      throw externalError("Connection 使用了不安全的 Header 名称", "EXTERNAL_FETCH_DENIED");
    }
    headers[name] = normalizeHeaderValue(value);
    sensitiveHeaders.add(name);
  }

  let body: Buffer | undefined;
  if (request.body !== undefined) {
    if (typeof request.body === "string") body = Buffer.from(request.body, "utf8");
    else if (Buffer.isBuffer(request.body)) body = request.body;
    else if (request.body instanceof Uint8Array) body = Buffer.from(request.body);
    else {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(request.body);
      } catch {
        throw externalError("external.fetch Body 必须可 JSON 序列化", "EXTERNAL_FETCH_DENIED");
      }
      if (serialized === undefined) throw externalError("external.fetch Body 必须可 JSON 序列化", "EXTERNAL_FETCH_DENIED");
      body = Buffer.from(serialized, "utf8");
      if (!headers["content-type"]) headers["content-type"] = "application/json; charset=utf-8";
    }
  }
  if (method === "GET" || method === "HEAD") {
    body = undefined;
    for (const name of Object.keys(headers)) {
      if (name.startsWith("content-")) delete headers[name];
    }
  }
  if (body) headers["content-length"] = String(body.byteLength);
  return { method, headers, body, sensitiveHeaders };
}

function createPinnedLookup(addresses: PinnedAddress[]): LookupFunction {
  return ((_hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
    const lookupOptions = typeof options === "object" && options !== null
      ? options as { all?: boolean; family?: number }
      : { family: typeof options === "number" ? options : 0 };
    const candidates = lookupOptions.family === 4 || lookupOptions.family === 6
      ? addresses.filter((item) => item.family === lookupOptions.family)
      : addresses;
    if (candidates.length === 0) {
      const error = Object.assign(new Error("已固定的 DNS 地址不支持请求的地址族"), { code: "ENOTFOUND" });
      callback(error);
      return;
    }
    if (lookupOptions.all) {
      callback(null, candidates.map((item) => ({ address: item.address, family: item.family })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  }) as LookupFunction;
}

async function requestPinned(
  target: NormalizedTarget,
  request: PreparedRequest,
  addresses: PinnedAddress[],
  deadline: number,
  maxResponseBytes: number,
): Promise<RawResponse> {
  const timeoutMs = remainingMs(deadline);
  try {
    return await new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, response?: RawResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (error) reject(hasExternalCode(error)
        ? error
        : externalError("external.fetch 网络请求失败", "EXTERNAL_FETCH_NETWORK_ERROR"));
      else resolve(response as RawResponse);
    };
    const timeoutError = externalError("external.fetch 请求超时", "EXTERNAL_FETCH_TIMEOUT");
    const requestOptions: https.RequestOptions = {
      method: request.method,
      headers: request.headers,
      agent: false,
      lookup: createPinnedLookup(addresses),
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
    };
    const outgoing = https.request(target.url, requestOptions, (incoming) => {
      const rawLength = incoming.headers["content-length"];
      if (rawLength !== undefined) {
        const parsedLength = Number(rawLength);
        if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
          incoming.destroy();
          finish(externalError("external.fetch 响应 Content-Length 无效", "EXTERNAL_FETCH_NETWORK_ERROR"));
          return;
        }
        if (parsedLength > maxResponseBytes) {
          incoming.destroy();
          finish(externalError("external.fetch 响应正文过大", "EXTERNAL_FETCH_RESPONSE_TOO_LARGE"));
          return;
        }
      }
      const status = incoming.statusCode || 0;
      const contentType = typeof incoming.headers["content-type"] === "string"
        ? incoming.headers["content-type"]
        : null;
      const location = typeof incoming.headers.location === "string" ? incoming.headers.location : undefined;
      if (REDIRECT_STATUS.has(status)) {
        incoming.destroy();
        finish(null, { status, contentType, location, body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      incoming.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        receivedBytes += buffer.byteLength;
        if (receivedBytes > maxResponseBytes) {
          incoming.destroy(externalError("external.fetch 响应正文过大", "EXTERNAL_FETCH_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(buffer);
      });
      incoming.once("end", () => finish(null, {
        status,
        contentType,
        location,
        body: Buffer.concat(chunks, receivedBytes),
      }));
      incoming.once("error", (error) => finish(error));
    });
    const deadlineTimer = setTimeout(() => outgoing.destroy(timeoutError), timeoutMs);
    deadlineTimer.unref();
    outgoing.once("error", (error) => finish(error));
    if (request.body) outgoing.write(request.body);
    outgoing.end();
    });
  } catch (error) {
    if (hasExternalCode(error)) throw error;
    throw externalError("external.fetch 网络请求失败", "EXTERNAL_FETCH_NETWORK_ERROR");
  }
}

function redirectRequest(
  request: PreparedRequest,
  status: number,
  crossOrigin: boolean,
): PreparedRequest {
  let method = request.method;
  let body = request.body;
  const headers = { ...request.headers };
  if (status === 303 && method !== "HEAD" || (status === 301 || status === 302) && method === "POST") {
    method = "GET";
    body = undefined;
    for (const name of Object.keys(headers)) {
      if (name.startsWith("content-")) delete headers[name];
    }
  }
  if (crossOrigin) {
    for (const name of request.sensitiveHeaders) delete headers[name];
  }
  if (body) headers["content-length"] = String(body.byteLength);
  else delete headers["content-length"];
  return { method, headers, body, sensitiveHeaders: request.sensitiveHeaders };
}

export async function secureExternalFetch(
  request: ExternalFetchRequest,
  options: SecureExternalFetchOptions,
): Promise<ExternalFetchResponse> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0
    || !Number.isSafeInteger(options.maxRedirects) || options.maxRedirects < 0
    || !Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes <= 0) {
    throw externalError("external.fetch 安全预算无效", "EXTERNAL_FETCH_DENIED");
  }
  const allowedHosts = new Set(options.allowedHosts.map(normalizeAllowedHost));
  const deadline = Date.now() + options.timeoutMs;
  let target = normalizeTarget(request.url, allowedHosts);
  let prepared = prepareRequest(request);
  let redirectCount = 0;

  while (true) {
    remainingMs(deadline);
    const addresses = await resolvePinnedAddresses(target.hostname, deadline);
    const response = await requestPinned(target, prepared, addresses, deadline, options.maxResponseBytes);
    if (!REDIRECT_STATUS.has(response.status)) {
      return {
        status: response.status,
        ok: response.status >= 200 && response.status < 300,
        headers: { "content-type": response.contentType },
        body: response.body.toString("utf8"),
      };
    }
    if (redirectCount >= options.maxRedirects) {
      throw externalError("external.fetch 重定向次数超限", "EXTERNAL_FETCH_REDIRECT_LIMIT");
    }
    if (!response.location) {
      throw externalError("external.fetch 重定向缺少 Location", "EXTERNAL_FETCH_INVALID_REDIRECT");
    }
    let redirectedUrl: string;
    try {
      redirectedUrl = new URL(response.location, target.url).href;
    } catch {
      throw externalError("external.fetch 重定向 Location 无效", "EXTERNAL_FETCH_INVALID_REDIRECT");
    }
    const nextTarget = normalizeTarget(redirectedUrl, allowedHosts);
    prepared = redirectRequest(prepared, response.status, target.url.origin !== nextTarget.url.origin);
    target = nextTarget;
    redirectCount += 1;
  }
}
