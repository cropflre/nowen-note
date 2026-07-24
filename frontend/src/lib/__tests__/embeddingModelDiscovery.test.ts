import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEmbeddingProbePayload,
  discoverEmbeddingModels,
  mergeEmbeddingModelOptions,
  testEmbeddingModel,
} from "../embeddingModelDiscovery";

vi.mock("@/lib/api", () => ({
  getBaseUrl: () => "https://nowen.test/api",
}));

describe("embedding model discovery client", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("builds profile payloads without copying profile secrets", () => {
    expect(buildEmbeddingProbePayload({
      source: "profile",
      profileId: " profile-1 ",
      url: "https://ignored.example/v1",
      key: "ignored-secret",
      model: " bge-m3 ",
    })).toEqual({
      source: "profile",
      profileId: "profile-1",
      model: "bge-m3",
    });
  });

  it("sends only newly typed custom credentials", () => {
    expect(buildEmbeddingProbePayload({
      source: "custom",
      profileId: "",
      url: " https://embedding.example/v1/ ",
      key: "new-secret",
      model: "text-embedding-3-small",
    })).toEqual({
      source: "custom",
      url: "https://embedding.example/v1/",
      apiKey: "new-secret",
      model: "text-embedding-3-small",
    });

    expect(buildEmbeddingProbePayload({
      source: "custom",
      profileId: "",
      url: "https://embedding.example/v1",
      key: "sk-****1234",
      model: "",
    })).toEqual({
      source: "custom",
      url: "https://embedding.example/v1",
    });
  });

  it("deduplicates defaults and discovered models while keeping recommendations first", () => {
    expect(mergeEmbeddingModelOptions(
      ["text-embedding-3-small", "bge-m3"],
      [
        { id: "acme-semantic", name: "Acme Semantic", recommended: false },
        { id: "bge-m3", name: "BGE M3", recommended: true },
      ],
    )).toEqual([
      { id: "bge-m3", name: "BGE M3", recommended: true },
      { id: "text-embedding-3-small", name: "text-embedding-3-small", recommended: true },
      { id: "acme-semantic", name: "Acme Semantic", recommended: false },
    ]);
  });

  it("calls discovery and test endpoints with auth and exposes errors", async () => {
    localStorage.setItem("nowen-token", "token-1");
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ id: "bge-m3", name: "bge-m3", recommended: true }],
        source: "profile",
        endpoint: "https://models.example/v1/models",
        discoveredCount: 3,
        filteredCount: 2,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        source: "profile",
        provider: "openai",
        model: "bge-m3",
        dimension: 1024,
        durationMs: 86,
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "认证失败",
        code: "EMBEDDING_AUTH_FAILED",
        upstreamStatus: 401,
      }), { status: 502, headers: { "content-type": "application/json" } }));

    const draft = {
      source: "profile" as const,
      profileId: "profile-1",
      url: "",
      key: "",
      model: "bge-m3",
    };
    const models = await discoverEmbeddingModels(draft);
    const tested = await testEmbeddingModel(draft);
    expect(models.models[0].id).toBe("bge-m3");
    expect(tested.dimension).toBe(1024);
    expect(fetchMock.mock.calls[0][0]).toBe("https://nowen.test/api/ai/embeddings/models");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe("Bearer token-1");

    await expect(testEmbeddingModel(draft)).rejects.toMatchObject({
      message: "认证失败",
      code: "EMBEDDING_AUTH_FAILED",
      upstreamStatus: 401,
      status: 502,
    });
  });
});
