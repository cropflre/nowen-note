import { describe, expect, it, vi } from "vitest";
import {
  isPermanentMindMapEmbedFailure,
  loadDocumentMindMap,
  type DocumentMindMap,
  type MindMapEmbedCacheAdapter,
  type MindMapEmbedCacheRecord,
} from "@/lib/documentMindMapRuntime";

const ID = "11111111-1111-4111-8111-111111111111";

function map(title = "产品脑图"): DocumentMindMap {
  return {
    id: ID,
    title,
    data: JSON.stringify({
      root: { id: "root", text: title, children: [] },
    }),
    updatedAt: "2026-09-24T08:00:00.000Z",
  };
}

function memoryCache(initial?: MindMapEmbedCacheRecord) {
  let record = initial || null;
  const adapter: MindMapEmbedCacheAdapter = {
    get: vi.fn(async () => record),
    put: vi.fn(async (next) => { record = next; }),
    remove: vi.fn(async () => { record = null; }),
  };
  return { adapter, get record() { return record; } };
}

function httpError(status: number) {
  const error = new Error(`HTTP ${status}`) as Error & { status?: number };
  error.status = status;
  return error;
}

describe("document mind map offline runtime", () => {
  it("writes an authorized network response to the account-scoped cache", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(async () => map());

    const result = await loadDocumentMindMap(ID, {
      fetcher,
      cache: cache.adapter,
      online: true,
      now: () => 123456,
    });

    expect(result.source).toBe("network");
    expect(result.map.title).toBe("产品脑图");
    expect(fetcher).toHaveBeenCalledWith(ID);
    expect(cache.adapter.put).toHaveBeenCalledWith({
      map: map(),
      cachedAt: 123456,
    });
  });

  it("renders the last authorized snapshot immediately while offline", async () => {
    const cachedAt = 123000;
    const cache = memoryCache({ map: map("离线版本"), cachedAt });
    const fetcher = vi.fn(async () => map("网络版本"));

    const result = await loadDocumentMindMap(ID, {
      fetcher,
      cache: cache.adapter,
      online: false,
    });

    expect(result).toEqual({
      map: map("离线版本"),
      source: "cache",
      cachedAt,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to cache on transient network and 5xx failures", async () => {
    for (const failure of [new TypeError("Failed to fetch"), httpError(503)]) {
      const cache = memoryCache({ map: map("缓存版本"), cachedAt: 456 });
      const result = await loadDocumentMindMap(ID, {
        fetcher: async () => { throw failure; },
        cache: cache.adapter,
        online: true,
      });
      expect(result.source).toBe("cache");
      expect(result.map.title).toBe("缓存版本");
    }
  });

  it("fails closed and purges cache when source is deleted or access is revoked", async () => {
    for (const status of [401, 403, 404]) {
      const cache = memoryCache({ map: map("不能继续展示"), cachedAt: 789 });
      await expect(loadDocumentMindMap(ID, {
        fetcher: async () => { throw httpError(status); },
        cache: cache.adapter,
        online: true,
      })).rejects.toMatchObject({ status });

      expect(cache.adapter.remove).toHaveBeenCalledWith(ID);
      expect(cache.record).toBeNull();
      expect(isPermanentMindMapEmbedFailure(httpError(status))).toBe(true);
    }
  });

  it("does not manufacture an offline preview when no authorized cache exists", async () => {
    const cache = memoryCache();
    await expect(loadDocumentMindMap(ID, {
      fetcher: async () => map(),
      cache: cache.adapter,
      online: false,
    })).rejects.toThrow(/offline/i);
  });
});
