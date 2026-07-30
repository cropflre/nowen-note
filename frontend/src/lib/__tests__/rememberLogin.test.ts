import { beforeEach, describe, expect, it, vi } from "vitest";

const storageHarness = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    api: {
      setKeyPrefix: vi.fn(async () => undefined),
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
      remove: vi.fn(async (key: string) => { values.delete(key); }),
    },
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock("@aparajita/capacitor-secure-storage", () => ({
  SecureStorage: storageHarness.api,
}));

describe("安卓端记住登录", () => {
  beforeEach(() => {
    storageHarness.values.clear();
    vi.clearAllMocks();
    delete (window as typeof window & { nowenDesktop?: unknown }).nowenDesktop;
  });

  it("通过系统安全存储保存并回填账号、密码和服务器", async () => {
    const {
      canPersistPassword,
      clearRememberedCredentials,
      loadRememberedCredentials,
      saveRememberedCredentials,
    } = await import("@/lib/rememberLogin");

    expect(await canPersistPassword()).toBe(true);
    expect(await saveRememberedCredentials({
      remember: true,
      autoLogin: false,
      serverUrl: "http://192.168.1.115:3001",
      username: "alice",
      password: "secret-password",
    })).toMatchObject({ ok: true, encrypted: true });

    await expect(loadRememberedCredentials()).resolves.toMatchObject({
      serverUrl: "http://192.168.1.115:3001",
      username: "alice",
      password: "secret-password",
      hasPassword: true,
    });

    await clearRememberedCredentials();
    await expect(loadRememberedCredentials()).resolves.toBeNull();
  });
});
