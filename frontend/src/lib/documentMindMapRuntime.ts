import type { MindMap } from "@/types";
import { getMeta, setMeta } from "@/lib/localStore";

const CACHE_PREFIX = "mindmap-document-embed:";
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type DocumentMindMap = Pick<MindMap, "id" | "title" | "data" | "updatedAt">;

export interface MindMapEmbedCacheRecord {
  map: DocumentMindMap;
  cachedAt: number;
}

export interface MindMapEmbedLoadResult {
  map: DocumentMindMap;
  source: "network" | "cache";
  cachedAt?: number;
}

export interface MindMapEmbedCacheAdapter {
  get(id: string): Promise<MindMapEmbedCacheRecord | null>;
  put(record: MindMapEmbedCacheRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

function cacheKey(id: string): string {
  return `${CACHE_PREFIX}${id.toLowerCase()}`;
}

function normalizeMap(map: DocumentMindMap): DocumentMindMap {
  return {
    id: String(map.id || "").toLowerCase(),
    title: String(map.title || "思维导图"),
    data: typeof map.data === "string" ? map.data : JSON.stringify(map.data),
    updatedAt: String(map.updatedAt || ""),
  };
}

export const defaultMindMapEmbedCache: MindMapEmbedCacheAdapter = {
  async get(id) {
    const value = await getMeta<MindMapEmbedCacheRecord | null>(cacheKey(id));
    if (!value || !value.map || !value.cachedAt) return null;
    if (Date.now() - value.cachedAt > MAX_CACHE_AGE_MS) {
      await setMeta(cacheKey(id), null);
      return null;
    }
    return value;
  },
  async put(record) {
    await setMeta(cacheKey(record.map.id), record);
  },
  async remove(id) {
    await setMeta(cacheKey(id), null);
  },
};

function responseStatus(error: unknown): number | null {
  const value = Number((error as { status?: unknown } | null)?.status);
  return Number.isFinite(value) ? value : null;
}

export function isPermanentMindMapEmbedFailure(error: unknown): boolean {
  const status = responseStatus(error);
  return status === 401 || status === 403 || status === 404;
}

export function isTransientMindMapEmbedFailure(error: unknown): boolean {
  const status = responseStatus(error);
  if (status === null) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * 文档内嵌脑图读取策略：
 * - 在线成功：写入按 server + user 隔离的 IndexedDB cache；
 * - 明确 401/403/404：fail closed，并清除旧快照，避免权限撤销后展示陈旧私有内容；
 * - 离线/网络失败/5xx：允许显示最近一次授权成功的只读快照。
 *
 * cache 只用于正文只读预览，不参与编辑、导出授权或公开分享。
 */
export async function loadDocumentMindMap(
  id: string,
  options: {
    fetcher: (id: string) => Promise<DocumentMindMap>;
    cache?: MindMapEmbedCacheAdapter;
    online?: boolean;
    now?: () => number;
  },
): Promise<MindMapEmbedLoadResult> {
  const normalizedId = id.toLowerCase();
  const cache = options.cache ?? defaultMindMapEmbedCache;
  const now = options.now ?? Date.now;
  const online = options.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false);

  if (!online) {
    const cached = await cache.get(normalizedId);
    if (cached) return { map: cached.map, source: "cache", cachedAt: cached.cachedAt };
    throw new TypeError("offline and no cached mind map snapshot");
  }

  try {
    const fresh = normalizeMap(await options.fetcher(normalizedId));
    if (!fresh.id || fresh.id !== normalizedId) {
      throw new Error("mind map response id mismatch");
    }
    await cache.put({ map: fresh, cachedAt: now() });
    return { map: fresh, source: "network" };
  } catch (error) {
    if (isPermanentMindMapEmbedFailure(error)) {
      await cache.remove(normalizedId);
      throw error;
    }
    if (isTransientMindMapEmbedFailure(error)) {
      const cached = await cache.get(normalizedId);
      if (cached) return { map: cached.map, source: "cache", cachedAt: cached.cachedAt };
    }
    throw error;
  }
}

export async function invalidateDocumentMindMapCache(id: string): Promise<void> {
  await defaultMindMapEmbedCache.remove(id);
}

export const DOCUMENT_MINDMAP_CHANGED_EVENT = "nowen:mindmap-changed";

export interface DocumentMindMapChangedDetail {
  id: string;
  kind: "updated" | "deleted";
}

export function dispatchDocumentMindMapChanged(detail: DocumentMindMapChangedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<DocumentMindMapChangedDetail>(
    DOCUMENT_MINDMAP_CHANGED_EVENT,
    { detail },
  ));
}
