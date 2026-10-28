import { withImageReferer } from "./image-referer";

export interface ImageFailure {
  url: string;
  error: string;
}

export interface ImageLocalizationResult {
  html: string;
  ok: number;
  failed: number;
  skipped: number;
  bytes: number;
  failures: ImageFailure[];
}

export interface ImageLocalizationOptions {
  concurrency?: number;
  maxImages?: number;
  maxSingleBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  /** 当前页面地址；用于给启用防盗链的站点补上页面 Referer。 */
  pageUrl?: string;
}

interface DownloadResult {
  dataUrl?: string;
  bytes?: number;
  error?: string;
}

const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home"];

/**
 * 浏览器扩展不能可靠获知域名最终解析到的 IP，因此这里采用保守策略：
 * - 拒绝所有非 http/https 协议、带账号密码的 URL；
 * - 拒绝 localhost、私网/环回/链路本地 IP、常见内网域名后缀；
 * - 禁止自动跟随重定向，避免公开 URL 302 到内网地址；
 * - 每张、总量、数量和超时都设硬上限。
 */
export function validateRemoteImageUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "图片地址无效" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "仅允许 HTTP/HTTPS 图片" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "禁止携带账号密码的图片地址" };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) return { ok: false, error: "图片域名为空" };
  if (hostname === "localhost" || PRIVATE_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return { ok: false, error: "已拦截本机或内网域名" };
  }
  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return { ok: false, error: "已拦截内网 IP 图片" };
  }

  parsed.hash = "";
  return { ok: true, url: parsed.href };
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const nums = parts.map(Number);
  if (nums.some((n) => n < 0 || n > 255)) return true;
  const [a, b] = nums;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const normalized = hostname.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith("ff") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

export async function localizeRemoteImages(
  html: string,
  options: ImageLocalizationOptions = {},
): Promise<ImageLocalizationResult> {
  const concurrency = clamp(options.concurrency ?? 4, 1, 8);
  const maxImages = clamp(options.maxImages ?? 120, 1, 500);
  const maxSingleBytes = clamp(options.maxSingleBytes ?? 8 * 1024 * 1024, 64 * 1024, 50 * 1024 * 1024);
  const maxTotalBytes = clamp(options.maxTotalBytes ?? 60 * 1024 * 1024, maxSingleBytes, 250 * 1024 * 1024);
  const timeoutMs = clamp(options.timeoutMs ?? 10_000, 1_000, 30_000);

  const imgRegex = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
  const entries: Array<{ fullMatch: string; src: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = imgRegex.exec(html)) !== null) {
    entries.push({ fullMatch: match[0], src: match[1] ?? match[2] ?? match[3] ?? "" });
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  const failures: ImageFailure[] = [];
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.src || entry.src.startsWith("data:") || entry.src.startsWith("blob:")) {
      skipped++;
      continue;
    }
    const checked = validateRemoteImageUrl(entry.src);
    if (!checked.ok) {
      failures.push({ url: entry.src, error: checked.error });
      continue;
    }
    if (seen.has(checked.url)) continue;
    seen.add(checked.url);
    if (unique.length >= maxImages) {
      failures.push({ url: checked.url, error: `超过单次最多 ${maxImages} 张图片限制` });
      continue;
    }
    unique.push(checked.url);
  }

  const downloads = new Map<string, DownloadResult>();
  let totalBytes = 0;
  let cursor = 0;

  const worker = async (referer: string) => {
    while (true) {
      const index = cursor++;
      if (index >= unique.length) return;
      const url = unique[index];
      const downloaded = await downloadImage(url, {
        maxSingleBytes,
        timeoutMs,
        referer,
      });
      if (downloaded.dataUrl && downloaded.bytes) {
        if (totalBytes + downloaded.bytes > maxTotalBytes) {
          downloads.set(url, { error: `图片总量超过 ${formatBytes(maxTotalBytes)} 限制` });
          continue;
        }
        totalBytes += downloaded.bytes;
      }
      downloads.set(url, downloaded);
    }
  };

  await withImageReferer(options.pageUrl ?? "", unique, (referer) =>
    Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, () => worker(referer))),
  );

  let resultHtml = html;
  for (const entry of entries) {
    const checked = validateRemoteImageUrl(entry.src);
    if (!checked.ok) continue;
    const downloaded = downloads.get(checked.url);
    if (!downloaded?.dataUrl) continue;
    const replaced = replaceSrc(entry.fullMatch, entry.src, downloaded.dataUrl);
    resultHtml = resultHtml.split(entry.fullMatch).join(replaced);
  }

  for (const [url, result] of downloads) {
    if (result.error) failures.push({ url, error: result.error });
  }

  const ok = Array.from(downloads.values()).filter((item) => !!item.dataUrl).length;
  const failed = failures.length;
  return {
    html: resultHtml,
    ok,
    failed,
    skipped,
    bytes: totalBytes,
    failures: failures.slice(0, 50),
  };
}

async function downloadImage(
  url: string,
  options: { maxSingleBytes: number; timeoutMs: number; referer?: string },
): Promise<DownloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok) {
      const hint =
        options.referer && (response.status === 401 || response.status === 403)
          ? `（已配置页面 Referer：${options.referer}，仍被拒绝）`
          : "";
      return { error: `HTTP ${response.status}${hint}` };
    }

    const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) return { error: "响应不是图片" };

    const declared = Number(response.headers.get("content-length") || "0");
    if (Number.isFinite(declared) && declared > options.maxSingleBytes) {
      return { error: `单图超过 ${formatBytes(options.maxSingleBytes)}` };
    }

    const bytes = await readResponseWithLimit(response, options.maxSingleBytes);
    if (!bytes) return { error: `单图超过 ${formatBytes(options.maxSingleBytes)}` };
    return {
      dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
      bytes: bytes.byteLength,
    };
  } catch (error: any) {
    if (error?.name === "AbortError") return { error: `下载超时（${options.timeoutMs}ms）` };
    return { error: String(error?.message || error || "下载失败") };
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseWithLimit(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength <= limit ? buffer : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function replaceSrc(tag: string, oldSrc: string, newSrc: string): string {
  const quoted = tag.replace(`"${oldSrc}"`, `"${newSrc}"`).replace(`'${oldSrc}'`, `'${newSrc}'`);
  if (quoted !== tag) return quoted;
  return tag.replace(oldSrc, newSrc);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)}KB`;
  return `${Math.ceil(bytes / 1024 / 1024)}MB`;
}
