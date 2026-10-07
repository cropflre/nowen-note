import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import DataManager from "../DataManager";
import zh from "@/i18n/locales/zh-CN.json";
const mocks = vi.hoisted(() => ({ me: vi.fn(), download: vi.fn(), dryRun: vi.fn(), import: vi.fn(), export: vi.fn(), backupStatus: vi.fn(), deviceOnly: false }));
vi.mock("@/lib/mobileLocalMode", () => ({ isMobileLocalMode: () => mocks.deviceOnly }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key.split(".").reduce((value: any, part) => value?.[part], zh) || key }) }));
vi.mock("@/store/AppContext", () => ({ useApp: () => ({ state: { notebooks: [] } }), useAppActions: () => ({ refreshNotes: vi.fn(), refreshNotebooks: vi.fn() }) }));
vi.mock("@/lib/api", () => ({ getBaseUrl: () => "/api", getServerUrl: () => "", getCurrentWorkspace: () => "other-global-space", setCurrentWorkspace: vi.fn(), withSudo: vi.fn(), api: {
  getMe: mocks.me, getWorkspaces: async () => [{ id: "chosen-space", name: "工作区 A" }], downloadNowenPackage: mocks.download, dryRunNowenPackage: mocks.dryRun, importNowenPackage: mocks.import,
  backup: { status: mocks.backupStatus, list: async () => [] },
} }));
vi.mock("@/lib/exportService", () => ({ exportAllNotes: mocks.export }));
vi.mock("@/lib/backupWebDavApi", () => ({ backupWebDavApi: { config: async () => ({ enabled: false, configured: false }) } }));
vi.mock("@/lib/desktopBridge", () => ({ isDesktop: () => false }));
vi.mock("@/components/MiCloudImport", () => ({ default: () => null }));
vi.mock("@/components/OppoCloudImport", () => ({ default: () => null }));
vi.mock("@/components/iCloudImport", () => ({ default: () => null }));
vi.mock("@/components/YoudaoImport", () => ({ default: () => null }));
vi.mock("@/components/ObsidianImport", () => ({ default: () => null }));
vi.mock("@/components/WeChatFavoritesImport", () => ({ default: () => null }));
vi.mock("@/components/UrlImport", () => ({ default: () => null }));
vi.mock("@/components/RemoteImageLocalizationPanel", () => ({ default: () => null }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks(); mocks.me.mockResolvedValue({ id: "admin", username: "admin", role: "admin" });
  localStorage.clear();
  mocks.deviceOnly = false;
  mocks.backupStatus.mockResolvedValue({ backupDirWritable: true, autoBackupRunning: false, autoBackupIntervalHours: 24 });
  mocks.download.mockResolvedValue({ blob: new Blob(["test"]), filename: "data.nowen.zip" });
  mocks.dryRun.mockResolvedValue({ success: true, package: { counts: { notes: 1, attachments: 1 } } });
  mocks.import.mockResolvedValue({ success: true, counts: { notes: 1, attachments: 1 } });
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => root.render(<DataManager />)); };
const click = async (text: string) => { const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === text)!; await act(async () => button.click()); };
describe("数据管理首页和迁移范围", () => {
  it("首页只给出备份、恢复、导入、导出入口；范围在进入迁移流程后出现", async () => {
    await mount();
    expect(host.querySelector("select")).toBeNull();
    expect(host.textContent).not.toContain("本地优先同步");
    expect(host.textContent).not.toContain("任务数据");
    expect(host.textContent).not.toContain("数据库文件");
    await click("导出数据");
    expect(host.querySelector('select[aria-label="选择数据范围"]')).not.toBeNull();
    expect(host.querySelectorAll('input[name="data-export-format"]')).toHaveLength(2);
    await click("返回数据管理");
    expect(host.querySelector("select")).toBeNull();
  });
  it("Nowen 数据包导出使用流程中所选工作区，不受全局侧栏空间影响", async () => {
    await mount(); await click("导出数据");
    const scope = host.querySelector<HTMLSelectElement>('select[aria-label="选择数据范围"]')!;
    await act(async () => { scope.value = "workspace"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
    const nowen = host.querySelector<HTMLInputElement>('input[value="nowen"]')!;
    await act(async () => nowen.click());
    await click(zh.note.nowenPackage);
    expect(mocks.download).toHaveBeenCalledWith({ workspaceId: "chosen-space" });
  });
  it("普通用户没有全库备份/高级维护入口，管理员禁用个人导出仍生效", async () => {
    mocks.me.mockResolvedValue({ id: "user", username: "user", role: "user", personalExportEnabled: false });
    await mount();
    expect(host.textContent).not.toContain("立即备份");
    expect(host.textContent).not.toContain("高级数据管理");
    await click("导出数据");
    expect(host.textContent).toContain(zh.dataManager.scope.personalExportDisabled);
    expect(host.querySelector('option[value="workspace"]')).toBeNull();
    const exportButton = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(zh.dataManager.exportAsZip))!;
    expect(exportButton.disabled).toBe(true);
  });
  it("Android 独立本机空间不请求服务器备份状态", async () => {
    mocks.deviceOnly = true;
    await mount();
    expect(mocks.backupStatus).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("立即备份");
    expect(host.textContent).toContain("导出数据");
  });
  it("Nowen 导入的预览与正式导入使用同一个所选工作区", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await mount(); await click("导入数据");
    const method = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(zh.dataManager.importMethodNowenDesc))!;
    await act(async () => method.click());
    const scope = host.querySelector<HTMLSelectElement>('select[aria-label="选择数据范围"]')!;
    await act(async () => { scope.value = "workspace"; scope.dispatchEvent(new Event("change", { bubbles: true })); });
    const file = new File(["fixture"], "notes.nowen.zip", { type: "application/zip" });
    const input = host.querySelector<HTMLInputElement>('#nowen-package-import-input')!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    expect(mocks.dryRun).toHaveBeenCalledWith(file, { workspaceId: "chosen-space" });
    expect(mocks.import).toHaveBeenCalledWith(file, { workspaceId: "chosen-space" });
  });
});
