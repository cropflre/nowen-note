import assert from "node:assert/strict";
import test from "node:test";
import { ping } from "../src/lib/api";
import { getConfig, setConfig } from "../src/lib/storage";

type StorageData = Record<string, unknown>;

function installChromeStorage(initial: StorageData = {}) {
  const data = structuredClone(initial);
  const store = {
    async get(key: string) {
      return { [key]: data[key] };
    },
    async set(items: StorageData) {
      Object.assign(data, structuredClone(items));
    },
  };
  globalThis.chrome = { storage: { sync: store, local: store } } as unknown as typeof chrome;
  return data;
}

test("refreshes an expired access token and persists the replacement", async (t) => {
  installChromeStorage();
  const cfg = await setConfig({
    serverUrl: "https://note.example.com",
    username: "alice",
    userId: "user-1",
    token: "expired-access-token",
    refreshToken: "valid-refresh-token",
  });
  const requests: Array<{ url: string; authorization: string | null; body: string }> = [];

  t.mock.method(globalThis, "fetch", async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      authorization: headers.get("Authorization"),
      body: String(init?.body || ""),
    });
    if (url.endsWith("/api/auth/refresh")) {
      return Response.json({ token: "renewed-access-token" });
    }
    if (headers.get("Authorization") === "Bearer expired-access-token") {
      return Response.json({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }, { status: 401 });
    }
    return Response.json({ id: "user-1", username: "alice", role: "user" });
  });

  const user = await ping(cfg);
  const stored = await getConfig();

  assert.equal(user.username, "alice");
  assert.equal(cfg.token, "renewed-access-token");
  assert.equal(stored.token, "renewed-access-token");
  assert.equal(stored.refreshToken, "valid-refresh-token");
  assert.deepEqual(requests.map((item) => item.url), [
    "https://note.example.com/api/me",
    "https://note.example.com/api/auth/refresh",
    "https://note.example.com/api/me",
  ]);
  assert.equal(requests[1].body, JSON.stringify({ refreshToken: "valid-refresh-token" }));
  assert.equal(requests[2].authorization, "Bearer renewed-access-token");
});

test("clears credentials only when refresh is explicitly rejected", async (t) => {
  installChromeStorage();
  const cfg = await setConfig({
    serverUrl: "https://note.example.com",
    token: "expired-access-token",
    refreshToken: "revoked-refresh-token",
  });

  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).endsWith("/api/auth/refresh")) {
      return Response.json(
        { error: "登录已过期，请重新登录", code: "REFRESH_TOKEN_INVALID" },
        { status: 401 },
      );
    }
    return Response.json({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }, { status: 401 });
  });

  await assert.rejects(() => ping(cfg), /登录已过期/);
  const stored = await getConfig();
  assert.equal(cfg.token, "");
  assert.equal(cfg.refreshToken, "");
  assert.equal(stored.token, "");
  assert.equal(stored.refreshToken, "");
});

test("keeps credentials when the refresh service is temporarily unavailable", async (t) => {
  installChromeStorage();
  const cfg = await setConfig({
    serverUrl: "https://note.example.com",
    token: "expired-access-token",
    refreshToken: "valid-refresh-token",
  });

  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).endsWith("/api/auth/refresh")) {
      return Response.json({ error: "服务暂时不可用" }, { status: 503 });
    }
    return Response.json({ error: "Token 无效或已过期", code: "TOKEN_INVALID" }, { status: 401 });
  });

  await assert.rejects(() => ping(cfg), /服务暂时不可用/);
  const stored = await getConfig();
  assert.equal(cfg.token, "expired-access-token");
  assert.equal(cfg.refreshToken, "valid-refresh-token");
  assert.equal(stored.token, "expired-access-token");
  assert.equal(stored.refreshToken, "valid-refresh-token");
});

test("a delayed old-account refresh cannot replace the newly selected account credentials", async (t) => {
  installChromeStorage();
  const cfg = await setConfig({ serverUrl: "https://old.example.com", username: "old", userId: "old-id", token: "old-access", refreshToken: "old-refresh" });
  let release!: () => void;
  let started!: () => void;
  const refreshStarted = new Promise<void>((resolve) => { started = resolve; });
  t.mock.method(globalThis, "fetch", async (input) => {
    if (String(input).endsWith("/api/auth/refresh")) {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return Response.json({ token: "late-old-access" });
    }
    return Response.json({ error: "Expired" }, { status: 401 });
  });
  const request = ping(cfg);
  await refreshStarted;
  await setConfig({ serverUrl: "https://new.example.com", username: "new", userId: "new-id", token: "new-access", refreshToken: "new-refresh" });
  release();
  await assert.rejects(() => request, /账号或服务器已切换/);
  const current = await getConfig();
  assert.equal(current.token, "new-access");
  assert.equal(current.refreshToken, "new-refresh");
  assert.equal(current.userId, "new-id");
});

test("switching destinations at refresh persistence writes only the old session overlay", async (t) => {
  const data = installChromeStorage();
  const cfg = await setConfig({ serverUrl: "https://old.example.com/Path", username: "old", userId: "old-id", token: "old-access", refreshToken: "old-refresh" });
  const originalSet = chrome.storage.local.set.bind(chrome.storage.local);
  let switched = false;
  t.mock.method(chrome.storage.local, "set", async (items) => {
    if (Object.keys(items).some((key) => key.startsWith("nowenClipperSession:"))) {
      switched = true;
      data.nowenClipperConfig = { ...cfg, serverUrl: "https://new.example.com/OtherPath", username: "new", userId: "new-id", token: "new-access", refreshToken: "new-refresh" };
    }
    await originalSet(items);
  });
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    requests.push(String(input));
    if (String(input).endsWith("/api/auth/refresh")) return Response.json({ token: "late-old-access" });
    if (new Headers(init?.headers).get("Authorization") === "Bearer old-access") return Response.json({ error: "Expired" }, { status: 401 });
    return Response.json({ id: "old-id", username: "old", role: "user" });
  });
  await ping(cfg);
  assert.equal(switched, true);
  const selected = await getConfig();
  assert.equal(selected.serverUrl, "https://new.example.com/OtherPath");
  assert.equal(selected.token, "new-access");
  assert.equal(selected.refreshToken, "new-refresh");
  assert.equal(selected.userId, "new-id");
  assert.equal(requests.every((url) => url.startsWith("https://old.example.com/Path/")), true);
  assert.equal(Object.keys(data).some((key) => key.includes("old-refresh")), false);
});
