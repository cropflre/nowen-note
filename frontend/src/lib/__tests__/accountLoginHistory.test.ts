import { beforeEach, describe, expect, it, vi } from "vitest";

const secureValues = new Map<string, unknown>();

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock("@aparajita/capacitor-secure-storage", () => ({
  SecureStorage: {
    setKeyPrefix: vi.fn(async () => undefined),
    get: vi.fn(async (key: string) => secureValues.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => { secureValues.set(key, value); }),
    remove: vi.fn(async (key: string) => { secureValues.delete(key); }),
  },
}));

import {
  consumePendingAccountReauth,
  listAccountLoginHistory,
  loadAccountLoginToken,
  markAccountLoginRequiresReauth,
  removeAccountLoginHistory,
  saveAccountLoginHistory,
  setPendingAccountReauth,
} from "@/lib/accountLoginHistory";
import { SecureStorage } from "@aparajita/capacitor-secure-storage";

describe("移动端账号登录历史", () => {
  beforeEach(() => {
    secureValues.clear();
    localStorage.clear();
    sessionStorage.clear();
    delete (window as any).nowenDesktop;
  });

  it("在系统安全存储中保存全部账号并按最近使用排序", async () => {
    const alice = await saveAccountLoginHistory({
      serverUrl: "https://notes.example.com/",
      token: "token-alice",
      user: { id: "user-1", username: "alice", displayName: "Alice" },
      lastUsedAt: 100,
    });
    const bob = await saveAccountLoginHistory({
      serverUrl: "https://notes.example.com",
      token: "token-bob",
      user: { id: "user-2", username: "bob", displayName: "Bob" },
      lastUsedAt: 200,
    });

    expect(alice.ok).toBe(true);
    expect(bob.ok).toBe(true);
    const history = await listAccountLoginHistory();
    expect(history.map((item) => item.username)).toEqual(["bob", "alice"]);
    expect(await loadAccountLoginToken(alice.id!)).toEqual({ ok: true, token: "token-alice" });
    expect(localStorage.getItem("nowen.accountHistory.records")).toBeNull();
    expect(localStorage.getItem("nowen-account-history-current-id")).toBe(bob.id);
  });

  it("更新同一服务器同一用户并保留其它账号", async () => {
    const first = await saveAccountLoginHistory({
      serverUrl: "https://notes.example.com",
      token: "old-token",
      user: { id: "user-1", username: "alice" },
      lastUsedAt: 100,
    });
    const updated = await saveAccountLoginHistory({
      serverUrl: "https://notes.example.com/",
      token: "new-token",
      user: { id: "user-1", username: "alice-new" },
      lastUsedAt: 300,
    });
    await saveAccountLoginHistory({
      serverUrl: "https://other.example.com",
      token: "other-token",
      user: { id: "user-1", username: "alice" },
      lastUsedAt: 200,
    });

    expect(updated.id).toBe(first.id);
    expect((await listAccountLoginHistory()).map((item) => item.username)).toEqual(["alice-new", "alice"]);
    expect(await loadAccountLoginToken(first.id!)).toEqual({ ok: true, token: "new-token" });
  });

  it("令牌失效时保留账号元数据，且可单独删除历史", async () => {
    const saved = await saveAccountLoginHistory({
      serverUrl: "https://notes.example.com",
      token: "token-alice",
      user: { id: "user-1", username: "alice" },
    });

    await markAccountLoginRequiresReauth(saved.id!);
    expect((await listAccountLoginHistory())[0].requiresReauth).toBe(true);
    expect(localStorage.getItem("nowen-account-history-current-id")).toBeNull();
    expect(await loadAccountLoginToken(saved.id!)).toEqual({ ok: false, error: "TOKEN_UNAVAILABLE" });
    await removeAccountLoginHistory(saved.id!);
    expect(await listAccountLoginHistory()).toEqual([]);
  });

  it("待重登信息只消费一次且不包含令牌", () => {
    setPendingAccountReauth({
      id: "history-1",
      serverUrl: "https://notes.example.com",
      username: "alice",
    });

    expect(consumePendingAccountReauth()).toEqual({
      id: "history-1",
      serverUrl: "https://notes.example.com",
      username: "alice",
    });
    expect(consumePendingAccountReauth()).toBeNull();
  });

  it("安全存储临时读取失败时返回存储错误而不是令牌失效", async () => {
    vi.mocked(SecureStorage.get).mockRejectedValueOnce(new Error("keystore unavailable"));

    expect(await loadAccountLoginToken("history-1")).toEqual({
      ok: false,
      error: "STORAGE_ERROR",
    });
  });
});
