import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import BackupCenter from "../dataManagement/BackupCenter";
import DataTransferCenter from "../dataManagement/DataTransferCenter";
import zh from "@/i18n/locales/zh-CN.json";

const mocks = vi.hoisted(() => ({ status: vi.fn(), list: vi.fn(), run: vi.fn(), create: vi.fn(), setAuto: vi.fn(), config: vi.fn(), upload: vi.fn(), remoteList: vi.fn(), remoteImport: vi.fn(), restore: vi.fn(), desktop: false, serverUrl: "" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key.split(".").reduce((value: any, part) => value?.[part], zh) || key }) }));
vi.mock("@/lib/api", () => ({ getServerUrl: () => mocks.serverUrl, api: { getMe: async () => ({ role: "admin" }), backup: { status: mocks.status, list: mocks.list, create: mocks.create, setAuto: mocks.setAuto, restore: mocks.restore } }, withSudo: async (action: (token: string) => Promise<unknown>) => ({ result: await action("sudo"), sudoToken: "sudo" }) }));
vi.mock("@/lib/desktopBridge", () => ({ isDesktop: () => mocks.desktop }));
vi.mock("@/lib/fullBackupJobClient", () => ({ runFullBackupJob: mocks.run }));
vi.mock("@/lib/backupWebDavApi", () => ({ backupWebDavApi: { config: mocks.config, upload: mocks.upload, list: mocks.remoteList, import: mocks.remoteImport } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement, root: Root;
const row = { filename: "backup.zip", type: "full", size: 128, createdAt: "2026-10-07T09:00:00Z" };
const status = { backupDirWritable: true, degraded: false, autoBackupRunning: false, autoBackupIntervalHours: 24, autoBackupMode: "daily", autoBackupDailyAt: "03:00", autoBackupKeepCount: 15 };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.desktop = false; mocks.serverUrl = "";
  mocks.status.mockResolvedValue(status); mocks.list.mockResolvedValue([row]); mocks.config.mockResolvedValue({ enabled: false, configured: false });
  mocks.run.mockResolvedValue({ filename: row.filename, size: 128 }); mocks.upload.mockResolvedValue({});
  mocks.setAuto.mockImplementation(async (enabled: boolean) => { mocks.status.mockResolvedValue({ ...status, autoBackupRunning: enabled }); return { message: "saved" }; });
  mocks.remoteList.mockResolvedValue([{ ...row, filename: "remote.zip" }]); mocks.remoteImport.mockResolvedValue({ filename: row.filename });
  mocks.restore.mockResolvedValue({ success: true, dryRun: { tables: [], files: { attachments: 0, fonts: 0, plugins: 0 }, schemaVersion: 1 } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const mount = async () => { await act(async () => root.render(<BackupCenter migration={<DataTransferCenter onImport={vi.fn()} onExport={vi.fn()} />} advanced={<div>维护工具</div>} />)); };
const button = (text: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === text)!;
const click = async (text: string) => { await act(async () => button(text).click()); };

describe("数据管理目标入口", () => {
  it.each([
    ["桌面本机", true, "", "本机"],
    ["桌面连接服务器", true, "https://notes.example.test", "Nowen Server"],
    ["Web", false, "", "Nowen Server"],
    ["Android 连接服务器", false, "https://notes.example.test", "Nowen Server"],
  ])("%s 的备份和恢复使用真实存储位置", async (_name, desktop, serverUrl, location) => {
    mocks.desktop = desktop as boolean; mocks.serverUrl = serverUrl as string;
    await mount();
    const locationRow = Array.from(host.querySelectorAll("dt")).find((node) => node.textContent === "备份位置")!;
    expect(locationRow.nextElementSibling?.textContent).toBe(location);
    for (const action of ["立即备份", "恢复数据", "导入数据", "导出数据"]) expect(button(action)).toBeDefined();
    await click("恢复数据");
    const restoreRow = Array.from(host.querySelectorAll("button")).find((node) => node.textContent === "恢复数据" && node.parentElement?.textContent?.includes("完整备份"))!;
    expect(restoreRow.parentElement?.textContent).toContain(location);
  });
  it("首屏不显示技术设置或备份列表，展开高级和恢复后才显示", async () => {
    await mount();
    expect(host.querySelector('input[type="file"]')).toBeNull();
    expect(host.textContent).not.toContain("维护工具");
    expect(host.textContent).not.toContain("仅数据库");
    expect(host.textContent).not.toContain("backup.zip");
    const advanced = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    await act(async () => advanced.click());
    expect(host.textContent).toContain("维护工具");
    expect(host.querySelector('[data-nowen-backup-webdav-host]')).not.toBeNull();
    await click("恢复数据");
    expect(host.querySelector('input[type="file"]')).not.toBeNull();
    expect(host.textContent).toContain("完整备份");
  });
  it("立即备份只生成一次完整备份，随后自动上传至已启用的 WebDAV", async () => {
    mocks.config.mockResolvedValue({ enabled: true, configured: true });
    await mount(); await click("立即备份");
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledWith(row.filename, "sudo");
    expect(mocks.upload.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.run.mock.invocationCallOrder[0]);
  });
  it("远端上传失败保留本机成功信息", async () => {
    mocks.config.mockResolvedValue({ enabled: true, configured: true }); mocks.upload.mockRejectedValueOnce(new Error("unreachable"));
    await mount(); await click("立即备份");
    expect(host.textContent).toContain("备份已保存到当前实例");
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
  it("首页自动备份开关持久保存，沿用已有调度及保留策略", async () => {
    await mount();
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(mocks.setAuto).toHaveBeenCalledWith(true, 24, "sudo", expect.objectContaining({ mode: "daily", dailyAt: "03:00", keepCount: 15 }));
    expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });
  it("远端恢复先取回本机并预览；未经确认不执行覆盖", async () => {
    mocks.config.mockResolvedValue({ enabled: true, configured: true });
    await mount(); await click("恢复数据");
    expect(mocks.remoteList).toHaveBeenCalled();
    await click("恢复数据"); // Overview closes the list, retaining local data.
    await click("恢复数据");
    const remoteButton = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "恢复数据" && b.parentElement?.textContent?.includes("WebDAV"))!;
    await act(async () => remoteButton.click());
    expect(mocks.remoteImport).toHaveBeenCalledWith("remote.zip", "sudo");
    expect(mocks.restore).toHaveBeenCalledWith(row.filename, true);
    expect(button("确认恢复").disabled).toBe(true);
    const confirm = host.querySelector<HTMLInputElement>('input[type="checkbox"]:not([aria-label])')!;
    await act(async () => confirm.click());
    await click("确认恢复");
    expect(mocks.restore).toHaveBeenCalledWith(row.filename, false, "sudo");
  });
  it("加载失败或从未备份时不声称数据已保护", async () => {
    mocks.status.mockRejectedValueOnce(new Error("offline")); await mount();
    expect(host.textContent).toContain("暂时无法读取备份状态");
    expect(button("立即备份").disabled).toBe(true);
  });
  it("尚无完整备份时显示真实状态", async () => {
    mocks.list.mockResolvedValue([]); await mount();
    expect(host.textContent).toContain("尚无备份");
    expect(host.textContent).not.toContain("已有完整备份");
  });
});
