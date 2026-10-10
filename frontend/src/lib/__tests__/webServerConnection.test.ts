import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRegisterConfig, getBaseUrl, getServerUrl, initializeServerUrlFromRuntime } from "../api.impl";
import { getOfflineQueueStorageKey } from "../offlineScope";
import { isNativeClientRuntime } from "../serverUrl";

describe("Web 与客户端服务器连接", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "nowenDesktop");
    Reflect.deleteProperty(window, "Capacitor");
    localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("Web 笔记链接使用同源 API，忽略历史服务器和 query 配置", () => {
    localStorage.setItem("nowen-server-url", "https://old.example.com");
    window.history.replaceState(null, "", "/notes/demo?serverUrl=https%3A%2F%2Fother.example.com");
    initializeServerUrlFromRuntime();

    expect(getServerUrl()).toBe("");
    expect(isNativeClientRuntime()).toBe(false);
    expect(getBaseUrl()).toBe("/api");
    expect(localStorage.getItem("nowen-server-url")).toBe("https://old.example.com");
  });

  it("Web 子路径部署自动使用当前站点的 API 前缀", () => {
    window.history.replaceState(null, "", "/nowen/notes/demo");
    expect(getServerUrl()).toBe(`${window.location.origin}/nowen`);
    expect(getBaseUrl()).toBe(`${window.location.origin}/nowen/api`);
  });

  it("Web 离线缓存使用当前站点身份，避免历史客户端配置混入", () => {
    localStorage.setItem("nowen-server-url", "https://old.example.com");
    window.history.replaceState(null, "", "/notes/demo");
    const rootScope = getOfflineQueueStorageKey();
    expect(rootScope).toContain(encodeURIComponent(window.location.origin));
    expect(rootScope).not.toContain("old.example.com");
    window.history.replaceState(null, "", "/nowen/notes/demo");
    expect(getOfflineQueueStorageKey()).not.toBe(rootScope);
    expect(getOfflineQueueStorageKey()).toContain(encodeURIComponent(`${window.location.origin}/nowen`));
  });

  it("注册配置服务不可用时抛出错误，由 Web 登录页提供重试", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await expect(fetchRegisterConfig()).rejects.toThrow("HTTP 503");
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchRegisterConfig()).rejects.toThrow("Failed to fetch");
  });

  it("Electron 保留用户选择的远程服务器", () => {
    Object.assign(window, { nowenDesktop: { isDesktop: true } });
    expect(isNativeClientRuntime()).toBe(true);
    localStorage.setItem("nowen-server-url", "https://remote.example.com/nowen");
    window.history.replaceState(null, "", "/notes/demo");
    expect(getBaseUrl()).toBe("https://remote.example.com/nowen/api");
  });

  it("Electron 本地服务仍优先使用本次启动注入的端口", () => {
    Object.assign(window, { nowenDesktop: { isDesktop: true } });
    localStorage.setItem("nowen-server-url", "http://127.0.0.1:3001");
    window.history.replaceState(null, "", "/?serverUrl=http%3A%2F%2F127.0.0.1%3A43127");
    initializeServerUrlFromRuntime();
    expect(getBaseUrl()).toBe("http://127.0.0.1:43127/api");
  });

  it("Android 未连接服务器时不会从 WebView 页面推断服务器", () => {
    Object.assign(window, { Capacitor: { isNativePlatform: () => true, platform: "android" } });
    window.history.replaceState(null, "", "/notes/demo");
    expect(getServerUrl()).toBe("");
    localStorage.setItem("nowen-server-url", "https://remote.example.com");
    expect(getBaseUrl()).toBe("https://remote.example.com/api");
  });
});
