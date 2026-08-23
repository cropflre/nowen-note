import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  getBaseUrl: () => "https://note.example.com/api",
}));

import { aiProfiles } from "@/lib/aiProfiles";

describe("aiProfiles client", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("nowen-token", "token-1");
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads profiles with the current authorization token", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      profiles: [{ id: "p1", name: "OpenAI" }],
      activeProfileId: "p1",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await aiProfiles.list();

    expect(result.activeProfileId).toBe("p1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://note.example.com/api/user-preferences/ai-profiles");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer token-1");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });

  it("activates a profile through the dedicated endpoint", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      profile: { id: "p2" },
      activeProfileId: "p2",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await aiProfiles.activate("p2");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://note.example.com/api/user-preferences/ai-profiles/p2/activate",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("tests a saved profile with a non-empty JSON request body", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      message: "连接成功",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await aiProfiles.test("lm-studio");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://note.example.com/api/user-preferences/ai-profiles/lm-studio/test");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("sends unsaved profile fields when discovering models", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      models: [{ id: "qwen-plus", name: "qwen-plus" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await aiProfiles.discoverModels({
      name: "Qwen",
      provider: "qwen",
      apiUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "dash-key",
      model: "qwen-plus",
    }, "p-qwen");

    expect(result.models[0].id).toBe("qwen-plus");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      profileId: "p-qwen",
      provider: "qwen",
      apiKey: "dash-key",
    });
  });

  it("surfaces backend discovery errors instead of silently returning an empty list", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: "401 invalid api key",
      models: [],
    }), { status: 502, headers: { "content-type": "application/json" } }));

    await expect(aiProfiles.discoverModels({
      name: "Broken",
      provider: "custom",
      apiUrl: "https://example.com/v1",
      apiKey: "bad",
      model: "",
    })).rejects.toThrow("401 invalid api key");
  });
});
