import { beforeEach, describe, expect, it } from "vitest";
import {
  completeMobileAccountLogin,
  continueMobileLocalMode,
  enterMobileLocalMode,
  getMobileLocalUser,
  isMobileLocalMode,
  requestMobileAccountLogin,
} from "@/lib/mobileLocalMode";

function installCapacitor(platform: string, native = true): void {
  (window as any).Capacitor = {
    isNativePlatform: () => native,
    getPlatform: () => platform,
    platform,
  };
}

describe("Android 未登录本地模式", () => {
  beforeEach(() => {
    localStorage.clear();
    installCapacitor("android");
  });

  it("Android 无 token 时默认进入稳定的设备本地账号", () => {
    expect(isMobileLocalMode()).toBe(true);
    expect(getMobileLocalUser()).toMatchObject({
      id: "android-local-user",
      username: "local",
      displayName: "本地用户",
    });
  });

  it("用户主动进入登录页后暂停本地模式，返回后恢复", () => {
    requestMobileAccountLogin();
    expect(isMobileLocalMode()).toBe(false);

    continueMobileLocalMode();
    expect(isMobileLocalMode()).toBe(true);
  });

  it("登录成功或已有 token 时不再使用本地账号", () => {
    requestMobileAccountLogin();
    completeMobileAccountLogin();
    localStorage.setItem("nowen-token", "signed-in-token");
    expect(isMobileLocalMode()).toBe(false);
  });

  it("保留已登录令牌时也可以切换到设备离线模式", () => {
    localStorage.setItem("nowen-token", "signed-in-token");
    enterMobileLocalMode();
    expect(isMobileLocalMode()).toBe(true);

    requestMobileAccountLogin();
    expect(isMobileLocalMode()).toBe(false);
  });

  it("不会改变 Web 和 iOS 的既有登录流程", () => {
    installCapacitor("web", false);
    expect(isMobileLocalMode()).toBe(false);

    installCapacitor("ios");
    expect(isMobileLocalMode()).toBe(false);
  });
});
