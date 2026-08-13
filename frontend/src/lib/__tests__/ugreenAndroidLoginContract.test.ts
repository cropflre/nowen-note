import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Android UGREEN external-browser fallback contract", () => {
  const source = fs.readFileSync("src/components/LoginPage.tsx", "utf8");
  const remoteAccessSource = fs.readFileSync("src/lib/ugreenRemoteAccess.ts", "utf8");
  const i18nSource = fs.readFileSync("src/i18n/index.ts", "utf8");

  it("routes a trusted native UGREEN address before the normal health request", () => {
    const resolverStart = source.indexOf("const resolveBaseUrl = async");
    const resolverEnd = source.indexOf("const persistRememberedLogin", resolverStart);
    const resolver = source.slice(resolverStart, resolverEnd);

    const nativeGatewayBranch = resolver.indexOf(
      "isNativeMobileClient && isUgreenRemoteAccessUrl(url)",
    );
    const normalHealthRequest = resolver.indexOf("testServerConnection(url)");

    expect(nativeGatewayBranch).toBeGreaterThan(-1);
    expect(normalHealthRequest).toBeGreaterThan(nativeGatewayBranch);
    expect(resolver).toContain("await beginUgreenAuthorization(url)");
    expect(resolver).toContain("return null");
  });

  it("opens native UGREEN access in the system browser instead of claiming in-app login", () => {
    const nativeStart = remoteAccessSource.indexOf("if (Capacitor.isNativePlatform())");
    const desktopStart = remoteAccessSource.indexOf("if ((window as any).nowenDesktop?.isDesktop)", nativeStart);
    const nativeBranch = remoteAccessSource.slice(nativeStart, desktopStart);

    expect(nativeBranch).toContain("await Browser.open({ url })");
    expect(nativeBranch).toContain("return");

    const authStart = source.indexOf("const beginUgreenAuthorization = async");
    const authEnd = source.indexOf("const resolveBaseUrl = async", authStart);
    const authorization = source.slice(authStart, authEnd);
    expect(authorization).toContain("if (isNativeMobileClient)");
    expect(authorization).toContain("pendingUgreenLoginRef.current = false");
    expect(authorization).toContain("setIsAuthorizingUgreen(false)");
    expect(authorization).not.toContain("requestSubmit");
  });

  it("labels the native action as an external system-browser fallback", () => {
    expect(source).toContain("if (!isRegister && isMobileUgreenAddress) return false");
    expect(source).toContain('t("auth.ugreenAccess.button")');
    expect(i18nSource).toContain('button: "在系统浏览器中打开"');
    expect(i18nSource).toContain('button: "Open in system browser"');
  });
});
