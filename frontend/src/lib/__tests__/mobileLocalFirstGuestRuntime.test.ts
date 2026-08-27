import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const repository = {
    warmAttachmentUrls: vi.fn(async () => undefined),
    exportWorkspaceScope: vi.fn(async () => ({ version: 1 })),
  };
  const db = { close: vi.fn(async () => undefined) };
  return {
    repository,
    db,
    openNativeDatabase: vi.fn(async () => db),
    createNativeAttachmentStore: vi.fn(async () => ({})),
    createNativeLocalRepository: vi.fn(() => repository),
    createMobileSyncEngine: vi.fn(),
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
  getServerUrl: () => "",
  setCurrentWorkspace: mocks.setCurrentWorkspace,
  SERVER_URL_CHANGED_EVENT: "nowen:server-url-changed",
}));
vi.mock("@/lib/authSession", () => ({ getAccessToken: () => null }));
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

describe("Android 本地优先游客运行时", () => {
  beforeEach(() => {
    localStorage.clear();
    (window as any).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => "android",
      platform: "android",
    };
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
});
