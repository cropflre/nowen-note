import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const repository = {
    warmAttachmentUrls: vi.fn(async () => undefined),
    exportWorkspaceScope: vi.fn(async () => ({ version: 1 })),
  };
  const run = vi.fn(async () => undefined);
  const db = {
    close: vi.fn(async () => undefined),
    query: vi.fn(async () => [{ value: "complete" }]),
    run,
    transaction: vi.fn(async (callback: (tx: { run: typeof run }) => Promise<void>) => callback({ run })),
  };
  const engine = { start: vi.fn(), stop: vi.fn(), requestSync: vi.fn() };
  const secureValues = new Map<string, string>();
  const secureApi = {
    setKeyPrefix: vi.fn(async () => undefined),
    get: vi.fn(async (key: string) => secureValues.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => { secureValues.set(key, value); }),
  };
  const thenAccess = vi.fn(() => {
    // Fail immediately on Promise assimilation instead of leaving the native proxy's Promise pending.
    throw new Error('"SecureStorage.then()" is not implemented on android');
  });
  const secureStorage = new Proxy(secureApi, {
    get(target, property, receiver) {
      if (property === "then") return thenAccess();
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    engine,
    endpoints: { beforeSync: vi.fn(async () => {}), refresh: vi.fn(async () => {}), networkChanged: vi.fn(async () => {}), recover: vi.fn(), dispose: vi.fn() },
    networkListener: vi.fn(async () => ({ remove: vi.fn() })),
    secureValues,
    secureApi,
    secureStorage,
    thenAccess,
    repository,
    db,
    openNativeDatabase: vi.fn(async () => db),
    createNativeAttachmentStore: vi.fn(async () => ({})),
    createNativeLocalRepository: vi.fn(() => repository),
    createMobileSyncEngine: vi.fn(() => engine),
    installMobileLocalFirstBridge: vi.fn(() => vi.fn()),
    setLocalRepository: vi.fn(),
    setSyncLocalAdminAdapter: vi.fn(),
    setCurrentUser: vi.fn(),
    setCurrentWorkspace: vi.fn(),
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
}));
vi.mock("@/lib/api.impl", () => ({
  getCurrentWorkspace: () => "personal",
  getServerUrl: () => "https://notes.example.com",
  setCurrentWorkspace: mocks.setCurrentWorkspace,
  SERVER_URL_CHANGED_EVENT: "nowen:server-url-changed",
}));
vi.mock("@/lib/authSession", () => ({ getAccessToken: () => localStorage.getItem("nowen-token") }));
vi.mock("@aparajita/capacitor-secure-storage", () => ({ SecureStorage: mocks.secureStorage }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }));
vi.mock("@capacitor/network", () => ({ Network: { addListener: mocks.networkListener } }));
vi.mock("@/lib/mobileServerEndpointRuntime", () => ({ createMobileServerEndpointRuntime: () => mocks.endpoints }));
vi.mock("@/lib/mobileLocalAccountMigration", () => ({ migrateMobileLocalAccount: vi.fn(async () => undefined) }));
vi.mock("@/lib/localStore", () => ({
  getAllNotebooks: vi.fn(async () => []),
  getAllNotes: vi.fn(async () => []),
  getAllOfflineAttachmentJobs: vi.fn(async () => []),
  getAllTags: vi.fn(async () => []),
  getOfflineAttachmentsByNote: vi.fn(async () => []),
  setCurrentUser: mocks.setCurrentUser,
}));
vi.mock("@/lib/mobileLocalFirstBridge", () => ({ installMobileLocalFirstBridge: mocks.installMobileLocalFirstBridge }));
vi.mock("@/lib/mobileSyncEngine", () => ({ createMobileSyncEngine: mocks.createMobileSyncEngine }));
vi.mock("@/lib/nativeAttachmentStore", () => ({ createNativeAttachmentStore: mocks.createNativeAttachmentStore }));
vi.mock("@/lib/nativeDatabase", () => ({ openNativeDatabase: mocks.openNativeDatabase }));
vi.mock("@/lib/nativeLocalRepository", () => ({ createNativeLocalRepository: mocks.createNativeLocalRepository }));
vi.mock("@/lib/localRepository", () => ({ newLocalId: () => "local-id", setLocalRepository: mocks.setLocalRepository }));
vi.mock("@/lib/offlineQueue", () => ({ clearQueue: vi.fn(), getQueue: vi.fn(() => []) }));
vi.mock("@/lib/syncLocalApi", () => ({
  setSyncLocalAdminAdapter: mocks.setSyncLocalAdminAdapter,
  SYNC_CONFLICT_ENTITY_TYPES: [],
}));

import { initializeMobileLocalFirstRuntime } from "@/lib/mobileLocalFirstRuntime";
import { enterMobileLocalMode } from "@/lib/mobileLocalMode";

describe("Android 本地优先运行时与离线切换", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.secureValues.clear();
    localStorage.clear();
    Object.assign(window, { Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      platform: "android",
    } });
  });

  it("已有登录凭据时冷启动能完成初始化并继续渲染（#798）", async () => {
    const token = `header.${btoa(JSON.stringify({ userId: "user-1" }))}.signature`;
    localStorage.setItem("nowen-token", token);
    mocks.secureValues.set("nowen.localFirst.deviceId", "saved-device");
    const renderApplication = vi.fn();

    await Promise.resolve()
      .then(() => initializeMobileLocalFirstRuntime())
      .then(renderApplication);

    expect(mocks.thenAccess).not.toHaveBeenCalled();
    expect(mocks.openNativeDatabase).toHaveBeenCalledWith("https://notes.example.com\nuser-1");
    expect(mocks.createMobileSyncEngine).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: "saved-device",
      token,
    }));
    expect(mocks.engine.start).toHaveBeenCalledOnce();
    expect(renderApplication).toHaveBeenCalledOnce();
    const listener = mocks.networkListener.mock.calls[0] as unknown as [string, (status: unknown) => void];
    listener[1]({ connected: true, connectionType: "wifi" });
    listener[1]({ connected: true, connectionType: "cellular" });
    await initializeMobileLocalFirstRuntime();
    expect(mocks.endpoints.networkChanged).toHaveBeenCalledTimes(2);
    expect(mocks.createMobileSyncEngine).toHaveBeenCalledOnce();
    expect(mocks.engine.stop).not.toHaveBeenCalled();
    expect(mocks.db.close).toHaveBeenCalledTimes(1); // only the migration source database
  });

  it("无 token 仍打开独立 SQLite，但不创建同步引擎", async () => {
    await initializeMobileLocalFirstRuntime();

    expect(mocks.openNativeDatabase).toHaveBeenCalledWith("android-device-local");
    expect(mocks.setCurrentUser).toHaveBeenCalledWith("android-local-user");
    expect(mocks.setCurrentWorkspace).toHaveBeenCalledWith("personal");
    expect(mocks.createNativeLocalRepository).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "android-device-local",
      userId: "android-local-user",
    }));
    expect(mocks.installMobileLocalFirstBridge).toHaveBeenCalledWith(
      mocks.repository,
      mocks.db,
      "android-local-user",
    );
    expect(mocks.setSyncLocalAdminAdapter).toHaveBeenCalledWith(expect.any(Function));
    expect(mocks.createMobileSyncEngine).not.toHaveBeenCalled();
  });

  it("登录后读写安全存储而不访问插件 then，并可切换到离线库", async () => {
    const token = `header.${btoa(JSON.stringify({ userId: "user-1" }))}.signature`;
    const accountId = "https://notes.example.com\nuser-1";
    const storageKey = btoa(accountId).replace(/[^A-Za-z0-9]/g, "").slice(0, 48);
    localStorage.setItem("nowen-token", token);
    mocks.secureValues.set("nowen.localFirst.deviceId", "saved-device");
    mocks.secureValues.set(`nowen.localFirst.profile.${storageKey}`, "saved-profile");

    await initializeMobileLocalFirstRuntime();

    expect(mocks.thenAccess).not.toHaveBeenCalled();
    expect(mocks.secureApi.get).toHaveBeenCalledWith("nowen.localFirst.deviceId");
    expect(mocks.secureApi.get).toHaveBeenCalledWith(`nowen.localFirst.profile.${storageKey}`);
    expect(mocks.secureApi.set).toHaveBeenCalledWith(`nowen.localFirst.token.${storageKey}`, token);
    expect(mocks.createMobileSyncEngine).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: "saved-device",
      profileId: "saved-profile",
      token,
    }));
    expect(mocks.engine.start).toHaveBeenCalledOnce();
    mocks.openNativeDatabase.mockClear();
    mocks.db.close.mockClear();

    enterMobileLocalMode();
    await initializeMobileLocalFirstRuntime();

    expect(mocks.engine.stop).toHaveBeenCalledOnce();
    expect(mocks.db.close).toHaveBeenCalledOnce();
    expect(mocks.openNativeDatabase).toHaveBeenCalledOnce();
    expect(mocks.openNativeDatabase).toHaveBeenCalledWith("android-device-local");
    expect(mocks.createNativeLocalRepository).toHaveBeenLastCalledWith(expect.objectContaining({
      accountId: "android-device-local",
      userId: "android-local-user",
    }));
    expect(localStorage.getItem("nowen-token")).toBe(token);
  });
});
