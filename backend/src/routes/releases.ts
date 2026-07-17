/**
 * GitHub Releases 代理。
 *
 * 成功结果缓存 15 分钟，失败缓存 5 分钟；支持 ETag 与 stale-while-error。
 * 除了公开路由，系统在线升级预检也复用同一个缓存函数，避免对 GitHub 重复外呼。
 */
import { Hono } from "hono";

const router = new Hono();
const GITHUB_OWNER = process.env.NOWEN_RELEASE_OWNER || "cropflre";
const GITHUB_REPO = process.env.NOWEN_RELEASE_REPO || "nowen-note";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const GITHUB_TOKEN = (process.env.NOWEN_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim();
const CACHE_TTL_MS = parseTtl(process.env.NOWEN_RELEASE_CACHE_MS, 15 * 60_000);
const FAIL_CACHE_TTL_MS = parseTtl(process.env.NOWEN_RELEASE_FAIL_CACHE_MS, 5 * 60_000);
const FETCH_TIMEOUT_MS = 5_000;

function parseTtl(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1000) return fallback;
  return value;
}

export interface ReleaseAsset {
  name: string;
  size: number;
  contentType: string;
  browserDownloadUrl: string;
}

export interface LatestRelease {
  available: true;
  tag: string;
  version: string;
  name: string;
  htmlUrl: string;
  publishedAt: string;
  prerelease: boolean;
  draft: boolean;
  body?: string;
  assets: ReleaseAsset[];
}

export interface ReleaseUnavailable {
  available: false;
  reason: string;
}

export type LatestReleasePayload = LatestRelease | ReleaseUnavailable;

let lastSuccess: { payload: LatestRelease; etag: string | null } | null = null;
let current: { at: number; ttl: number; payload: LatestReleasePayload } | null = null;
let inFlight: Promise<LatestReleasePayload> | null = null;

async function fetchLatestFromGitHub(): Promise<LatestRelease | "not-modified"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      "User-Agent": `${GITHUB_OWNER}-${GITHUB_REPO}-server`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    if (lastSuccess?.etag) headers["If-None-Match"] = lastSuccess.etag;

    const response = await fetch(GITHUB_API, { signal: controller.signal, headers });
    if (response.status === 304) return "not-modified";
    if (!response.ok) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      const reset = response.headers.get("x-ratelimit-reset");
      const extra = remaining !== null ? ` (rate-limit remaining=${remaining} reset=${reset})` : "";
      throw new Error(`GitHub API ${response.status} ${response.statusText}${extra}`);
    }

    const data = (await response.json()) as {
      tag_name?: string;
      name?: string;
      html_url?: string;
      published_at?: string;
      prerelease?: boolean;
      draft?: boolean;
      body?: string;
      assets?: Array<{
        name?: string;
        size?: number;
        content_type?: string;
        browser_download_url?: string;
      }>;
    };
    const tag = data.tag_name || "";
    const payload: LatestRelease = {
      available: true,
      tag,
      version: tag.replace(/^v/, ""),
      name: data.name || tag,
      htmlUrl: data.html_url || "",
      publishedAt: data.published_at || "",
      prerelease: Boolean(data.prerelease),
      draft: Boolean(data.draft),
      body: data.body || "",
      assets: (data.assets || [])
        .filter((asset) => !!asset.browser_download_url && !!asset.name)
        .map((asset) => ({
          name: asset.name || "",
          size: typeof asset.size === "number" ? asset.size : 0,
          contentType: asset.content_type || "application/octet-stream",
          browserDownloadUrl: asset.browser_download_url || "",
        })),
    };
    lastSuccess = { payload, etag: response.headers.get("etag") };
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function refreshLatestRelease(): Promise<LatestReleasePayload> {
  const now = Date.now();
  try {
    const result = await fetchLatestFromGitHub();
    const payload = result === "not-modified" ? lastSuccess!.payload : result;
    current = { at: now, ttl: CACHE_TTL_MS, payload };
    return payload;
  } catch (error) {
    if (lastSuccess) {
      current = { at: now, ttl: FAIL_CACHE_TTL_MS, payload: lastSuccess.payload };
      return lastSuccess.payload;
    }
    const payload: ReleaseUnavailable = {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
    current = { at: now, ttl: FAIL_CACHE_TTL_MS, payload };
    return payload;
  }
}

/**
 * 返回缓存后的最新稳定 Release 原始信息。
 * 多个并发调用共享同一个 in-flight Promise，避免缓存过期瞬间形成外呼风暴。
 */
export async function getLatestReleasePayload(): Promise<LatestReleasePayload> {
  const now = Date.now();
  if (current && now - current.at < current.ttl) return current.payload;
  if (!inFlight) {
    inFlight = refreshLatestRelease().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

router.get("/latest", async (c) => c.json(await getLatestReleasePayload()));

export default router;
