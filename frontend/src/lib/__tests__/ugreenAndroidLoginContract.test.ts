import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Android UGREEN remote login contract", () => {
  const source = fs.readFileSync("src/components/LoginPage.tsx", "utf8");

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

  it("does not require Nowen credentials before opening the UGREEN workspace", () => {
    expect(source).toContain("if (!isRegister && isMobileUgreenAddress) return false");
    expect(source).toContain('t("auth.ugreenAccess.button")');
  });

  it("does not leave the native login button in a permanent waiting state", () => {
    const authStart = source.indexOf("const beginUgreenAuthorization = async");
    const authEnd = source.indexOf("const resolveBaseUrl = async", authStart);
    const authorization = source.slice(authStart, authEnd);

    expect(authorization).toContain("if (isNativeMobileClient)");
    expect(authorization).toContain("pendingUgreenLoginRef.current = false");
    expect(authorization).toContain("setIsAuthorizingUgreen(false)");
  });
});
