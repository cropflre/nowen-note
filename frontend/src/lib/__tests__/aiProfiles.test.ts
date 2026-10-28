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

  it("tests an unsaved draft with selected profile ID and key", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true,
      message: "连接成功",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await aiProfiles.testDraft({
      name: "SiliconFlow",
      provider: "custom",
      apiUrl: "https://api.siliconflow.cn/v1",
      apiKey: "****5432",
      model: "deepseek-ai/DeepSeek-V4-Flash",
    }, "profile-sf");

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://note.example.com/api/user-preferences/ai-profiles/test-draft");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      profileId: "profile-sf",
      apiKey: "****5432",
      model: "deepseek-ai/DeepSeek-V4-Flash",
    });
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
  it("falls back to personal profiles only when the shared capability endpoint is absent", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ profiles: [{id: "p1"}], activeProfileId: "p1" }), { status: 200 }));
    expect(await aiProfiles.available()).toMatchObject({ sharedSupported: false, sharedProfiles: [], active: {scope: "personal", id: "p1"} });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat permission or server errors as an old server", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({error: "Forbidden"}), {status: 403}));
    await expect(aiProfiles.available()).rejects.toThrow("Forbidden");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("activates a shared profile using only its server reference", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ active: {scope: "shared", id: "team"} }), {status: 200}));
    await aiProfiles.activateSelection({scope: "shared", id: "team"});
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://note.example.com/api/ai/profiles/active");
    expect(JSON.parse(init.body)).toEqual({scope: "shared", id: "team"});
  });

  it("publishes existing profiles server-side and deletes with an explicit revision", async () => {
    fetchMock.mockResolvedValue(new Response("{}", {status: 200}));
    await aiProfiles.shared.create({sourceProfileId: "personal", enabled: true, memberIds: ["a"]});
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({sourceProfileId: "personal", enabled: true, memberIds: ["a"]});
    fetchMock.mockResolvedValueOnce(new Response("{}", {status: 200}));
    await aiProfiles.shared.remove("team", 4);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({method: "DELETE", body: JSON.stringify({revision: 4})});
  });

  it("rejects a delayed response after switching account (DCC-006)", async () => {
    const token = (userId: string) => `e30.${btoa(JSON.stringify({userId}))}.signature`;
    localStorage.setItem("nowen-token", token("a"));
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = aiProfiles.available();
    localStorage.setItem("nowen-token", token("b"));
    finish(new Response(JSON.stringify({sharedProfiles: [{id: "a-only"}]}), {status: 200}));
    await expect(pending).rejects.toThrow("session changed");
  });

  it("does not contact a server in Native local-only mode (DCC-009)", async () => {
    Object.assign(window, {Capacitor: {isNativePlatform: () => true, getPlatform: () => "android"}});
    localStorage.setItem("nowen-mobile-force-local-mode", "1");
    try { await expect(aiProfiles.available()).rejects.toMatchObject({code: "MOBILE_LOCAL_ONLY"}); expect(fetchMock).not.toHaveBeenCalled(); }
    finally { delete (window as unknown as {Capacitor?: unknown}).Capacitor; }
  });

  it("rejects an HTML or malformed successful directory response", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Login</html>", {status: 200}));
    await expect(aiProfiles.available()).rejects.toThrow("Invalid AI profile response");
    fetchMock.mockResolvedValueOnce(new Response("{}", {status: 200}));
    await expect(aiProfiles.available()).rejects.toThrow("Invalid AI profile directory");
  });

});
