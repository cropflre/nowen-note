import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncSettingsPanel } from "../settings/SyncSettingsPanel";
import type { SyncSettingsResponse } from "@/lib/syncLocalApi";

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), diagnostics: vi.fn(), login: vi.fn(), bootstrap: vi.fn(),
  disable: vi.fn(), connect: vi.fn(),
}));
vi.mock("@/lib/syncLocalApi", () => ({
  fetchSyncSettings: mocks.settings, fetchSyncDiagnostics: mocks.diagnostics,
  loginSyncServer: mocks.login, startSyncBootstrap: mocks.bootstrap,
  disableSync: mocks.disable, connectSyncServer: mocks.connect,
  SyncV2DisabledError: class extends Error {},
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLElement, settings: SyncSettingsResponse;
const profile = { id: "profile-1", name: "My server", serverUrl: "https://notes.example.com", enabled: true };
beforeEach(() => {
  vi.resetAllMocks();
  settings = { mode: "device-only", activeProfile: null, profiles: [], authorized: false, authorizationState: "missing", engineRunning: false };
  mocks.settings.mockImplementation(async () => settings);
  mocks.diagnostics.mockResolvedValue({ pendingMutations: 2, conflictCount: 0, localCursor: 0, pendingSample: [] });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = async () => { await act(async () => root.render(<SyncSettingsPanel />)); };
const button = (name: string) => [...host.querySelectorAll("button")].find(node => node.textContent === name)!;
const click = async (name: string) => { await act(async () => button(name).click()); };
const fill = async (name: string, value: string) => {
  const input = [...host.querySelectorAll("input")].find(node => node.labels?.[0]?.textContent?.includes(name))!;
  expect(input, `labeled input: ${name}`).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const submit = async () => {
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
};
const enable = (engineRunning = true) => {
  settings = { mode: "server", activeProfile: profile, profiles: [profile], authorized: true, authorizationState: "ready", engineRunning };
};

describe("desktop sync settings actions", () => {
  it("replaces misleading radios with a status and labeled connection form", async () => {
    await mount();
    expect(host.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(host.textContent).toContain("未开启");
    expect(button("登录并开启同步")).toBeTruthy();
    await fill("服务器地址", profile.serverUrl);
    await fill("账号", "alice");
    await fill("密码", "test-password");
    mocks.login.mockImplementation(async () => { enable(); return { bootstrapRequired: false, engineRunning: true }; });
    await submit();
    expect(mocks.login).toHaveBeenCalledWith({ serverUrl: profile.serverUrl, username: "alice", password: "test-password" });
    expect(host.textContent).toContain("已开启");
    expect(button("关闭同步")).toBeTruthy();
    expect(host.textContent).not.toContain("同步已完成");
  });

  it("shows login and initialization progress and prevents duplicate submissions (DCC-001)", async () => {
    let loginDone!: (value: unknown) => void, bootstrapDone!: (value: unknown) => void;
    mocks.login.mockImplementation(() => new Promise(resolve => { loginDone = resolve; }));
    mocks.bootstrap.mockImplementation(() => new Promise(resolve => { bootstrapDone = resolve; }));
    await mount();
    await fill("服务器地址", profile.serverUrl); await fill("账号", "alice"); await fill("密码", "password");
    await submit();
    expect(button("正在登录…").disabled).toBe(true);
    expect([...host.querySelectorAll("input")].every(input => input.disabled)).toBe(true);
    await submit();
    expect(mocks.login).toHaveBeenCalledOnce();
    await act(async () => { enable(false); loginDone({ bootstrapRequired: true }); });
    expect(button("正在初始化同步…").disabled).toBe(true);
    await act(async () => { bootstrapDone({ status: "failed", engineRunning: false, error: "network unavailable" }); });
    expect(host.textContent).toContain("network unavailable");
    expect(host.textContent).toContain("待完成首次同步");
    expect(host.textContent).not.toContain("首次同步已完成");
    expect(button("继续首次同步")).toBeTruthy();
  });

  it("supports two-factor login and code submission", async () => {
    mocks.login.mockResolvedValueOnce({ requiresTwoFactor: true, ticket: "ticket", username: "alice" });
    await mount();
    await fill("服务器地址", profile.serverUrl); await fill("账号", "alice"); await fill("密码", "password");
    await submit();
    expect(button("验证并开启同步")).toBeTruthy();
    await fill("双重验证代码或恢复码", "recovery-code");
    mocks.login.mockImplementationOnce(async () => { enable(); return { bootstrapRequired: false }; });
    await submit();
    expect(mocks.login).toHaveBeenLastCalledWith({ serverUrl: profile.serverUrl, ticket: "ticket", code: "recovery-code" });
    expect(host.textContent).toContain("已开启");
  });

  it("keeps the form available after rejected credentials without enabling sync", async () => {
    mocks.login.mockRejectedValueOnce(new Error("账号或密码错误"));
    await mount();
    await fill("服务器地址", profile.serverUrl); await fill("账号", "alice"); await fill("密码", "wrong-password");
    await submit();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("账号或密码错误");
    expect(host.textContent).toContain("未开启");
    expect(button("登录并开启同步").disabled).toBe(false);
    expect(mocks.bootstrap).not.toHaveBeenCalled();
  });

  it("continues initialization and shows enabled only after confirmed settings reload", async () => {
    enable(false);
    mocks.bootstrap.mockImplementation(async () => { enable(); return { status: "ready", engineRunning: true }; });
    await mount();
    expect(host.textContent).toContain("待完成首次同步");
    await click("继续首次同步");
    expect(mocks.bootstrap).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("已开启");
    expect(host.textContent).toContain("同步初始化已完成");
    expect(button("继续首次同步")).toBeUndefined();
  });

  it("closes sync explicitly and keeps the saved server for re-login (DCC-003)", async () => {
    enable();
    mocks.disable.mockImplementation(async () => {
      settings = { ...settings, mode: "device-only", activeProfile: null, authorized: false, authorizationState: "missing", engineRunning: false };
      return { message: "已停止同步，本机笔记和待同步修改仍保留。" };
    });
    await mount(); await click("关闭同步");
    expect(mocks.disable).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("未开启");
    expect(host.textContent).toContain("待同步修改仍保留");
    expect(button("登录并开启同步")).toBeTruthy();
    expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe(profile.serverUrl);
  });

  it("does not show a successful state change when closing fails", async () => {
    enable(); mocks.disable.mockRejectedValueOnce(new Error("database unavailable"));
    await mount(); await click("关闭同步");
    expect(host.textContent).toContain("已开启");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("database unavailable");
  });

  it("shows read failure with retry instead of assuming sync is off", async () => {
    mocks.settings.mockRejectedValueOnce(new Error("database unavailable"));
    await mount();
    expect(host.textContent).toContain("暂时无法读取同步设置");
    expect(host.textContent).not.toContain("未开启");
    expect(host.querySelector("form")).toBeNull();
    await click("重试");
    expect(host.textContent).toContain("未开启");
    expect(host.textContent).not.toContain("database unavailable");
  });

  it("shows unknown state after a refresh fails, then recovers on retry", async () => {
    enable(); await mount();
    mocks.settings.mockRejectedValueOnce(new Error("database unavailable"));
    await click("刷新");
    expect(host.textContent).toContain("暂时无法读取同步设置");
    expect(button("关闭同步")).toBeUndefined();
    await click("重试");
    expect(host.textContent).toContain("已开启");
  });

  it("keeps confirmed settings when only diagnostics fail without claiming sync completion (DCC-001)", async () => {
    enable(); mocks.diagnostics.mockRejectedValueOnce(new Error("diagnostics unavailable"));
    await mount();
    expect(host.textContent).toContain("已开启");
    expect(host.textContent).toContain("诊断信息暂时不可用");
    expect(button("刷新状态")).toBeTruthy();
    expect(host.textContent).not.toContain("同步已完成");
  });

  it("requests re-login after authorization expires and preserves the configured address", async () => {
    enable(); settings = { ...settings, authorized: false, authorizationState: "expired" };
    await mount();
    expect(host.textContent).toContain("需要重新登录");
    expect(host.textContent).toContain("未同步修改仍保留在本机");
    expect(button("登录并开启同步")).toBeTruthy();
    expect(host.querySelector<HTMLInputElement>('input[type="url"]')?.value).toBe(profile.serverUrl);
  });

  it("resumes an authorized paused profile using its existing server", async () => {
    settings = { ...settings, authorized: true, authorizationState: "ready", profiles: [profile] };
    mocks.connect.mockImplementation(async () => { enable(); return { message: "已恢复后台同步。" }; });
    await mount(); await click("恢复同步");
    expect(mocks.connect).toHaveBeenCalledWith({ serverUrl: profile.serverUrl });
    expect(host.textContent).toContain("已开启");
  });
});
