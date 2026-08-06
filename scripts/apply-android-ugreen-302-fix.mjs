import fs from "node:fs";

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`Unable to find ${label}`);
  if (source.indexOf(search, index + search.length) >= 0) {
    throw new Error(`Expected a single ${label}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

const loginFile = "frontend/src/components/LoginPage.tsx";
let login = fs.readFileSync(loginFile, "utf8");

login = replaceOnce(
  login,
  '  const isDesktopClient = !!(window as any).nowenDesktop?.isDesktop;\n',
  '  const isDesktopClient = !!(window as any).nowenDesktop?.isDesktop;\n  const isNativeMobileClient = isMobileNativeClientRuntime() && !isDesktopClient;\n  const isMobileUgreenAddress = isNativeMobileClient && isUgreenRemoteAccessUrl(buildServerUrl(serverParts));\n',
  "client runtime declarations",
);

login = replaceOnce(
  login,
  '    if (isLoading || isAuthorizingUgreen) return true;\n    if (isTwoFactorStep) return false;\n    if (!username.trim() || !password) return true;\n',
  '    if (isLoading || isAuthorizingUgreen) return true;\n    if (isTwoFactorStep) return false;\n    // 绿联远程域名需要先在绿联网关页面完成认证；本地表单账号不会提交给网关。\n    if (!isRegister && isMobileUgreenAddress) return false;\n    if (!username.trim() || !password) return true;\n',
  "submit disabled conditions",
);

login = replaceOnce(
  login,
  '  }, [confirmPassword, isAuthorizingUgreen, isClientMode, isLoading, isRegister, isTwoFactorStep, password, serverParts.host, username]);\n',
  '  }, [confirmPassword, isAuthorizingUgreen, isClientMode, isLoading, isMobileUgreenAddress, isRegister, isTwoFactorStep, password, serverParts.host, username]);\n',
  "submit disabled dependencies",
);

login = replaceOnce(
  login,
  '  const handleServerBlur = async () => {\n    if (!isClientMode) return;\n    const url = buildServerUrl(serverParts);\n    if (!url) return;\n    setServerStatus("checking");\n',
  '  const handleServerBlur = async () => {\n    if (!isClientMode) return;\n    const url = buildServerUrl(serverParts);\n    if (!url) return;\n    // UGREENlink 的远程 Docker 域名会先跳转到网关认证页，不能按普通 API 健康检查判失败。\n    if (isNativeMobileClient && isUgreenRemoteAccessUrl(url)) {\n      setServerStatus("ok");\n      setServerUrl(url);\n      localStorage.setItem("nowen-server-url-last", url);\n      return;\n    }\n    setServerStatus("checking");\n',
  "server blur handler",
);

login = replaceOnce(
  login,
  '    try {\n      await openUgreenRemoteWorkspace(url);\n    } catch (openError) {\n',
  '    try {\n      await openUgreenRemoteWorkspace(url);\n      // Android/iOS 使用系统安全浏览器打开远程工作台，不会收到 Electron 网关事件。\n      // Browser.open 返回后立即释放本地等待态，避免回到 App 时按钮永久转圈。\n      if (isNativeMobileClient) {\n        pendingUgreenLoginRef.current = false;\n        setIsAuthorizingUgreen(false);\n        setServerStatus("ok");\n      }\n    } catch (openError) {\n',
  "UGREEN authorization handler",
);

login = replaceOnce(
  login,
  '    if (!url) {\n      setError(t("auth.serverRequired"));\n      return null;\n    }\n    setServerStatus("checking");\n',
  '    if (!url) {\n      setError(t("auth.serverRequired"));\n      return null;\n    }\n    // Android 原生 HTTP 无法完成绿联网关的交互式 302 认证。\n    // 对可信 UGREENlink 域名直接打开远程 Web 工作台，且不发送 Nowen 账号密码。\n    if (isNativeMobileClient && isUgreenRemoteAccessUrl(url)) {\n      setServerStatus("ok");\n      setServerUrl(url);\n      localStorage.setItem("nowen-server-url-last", url);\n      await beginUgreenAuthorization(url);\n      return null;\n    }\n    setServerStatus("checking");\n',
  "base URL resolver",
);

login = replaceOnce(
  login,
  '                : isRegister ? t("auth.registerButton") : t("auth.loginButton")}\n',
  '                : isRegister\n                  ? t("auth.registerButton")\n                  : isMobileUgreenAddress\n                    ? t("auth.ugreenAccess.button")\n                    : t("auth.loginButton")}\n',
  "login button label",
);

fs.writeFileSync(loginFile, login);

const contractTest = `import fs from "node:fs";\nimport { describe, expect, it } from "vitest";\n\ndescribe("Android UGREEN remote login contract", () => {\n  const source = fs.readFileSync("src/components/LoginPage.tsx", "utf8");\n\n  it("routes a trusted native UGREEN address before the normal health request", () => {\n    const resolverStart = source.indexOf("const resolveBaseUrl = async");\n    const resolverEnd = source.indexOf("const persistRememberedLogin", resolverStart);\n    const resolver = source.slice(resolverStart, resolverEnd);\n\n    const nativeGatewayBranch = resolver.indexOf(\n      "isNativeMobileClient && isUgreenRemoteAccessUrl(url)",\n    );\n    const normalHealthRequest = resolver.indexOf("testServerConnection(url)");\n\n    expect(nativeGatewayBranch).toBeGreaterThan(-1);\n    expect(normalHealthRequest).toBeGreaterThan(nativeGatewayBranch);\n    expect(resolver).toContain("await beginUgreenAuthorization(url)");\n    expect(resolver).toContain("return null");\n  });\n\n  it("does not require Nowen credentials before opening the UGREEN workspace", () => {\n    expect(source).toContain("if (!isRegister && isMobileUgreenAddress) return false");\n    expect(source).toContain('t("auth.ugreenAccess.button")');\n  });\n\n  it("does not leave the native login button in a permanent waiting state", () => {\n    const authStart = source.indexOf("const beginUgreenAuthorization = async");\n    const authEnd = source.indexOf("const resolveBaseUrl = async", authStart);\n    const authorization = source.slice(authStart, authEnd);\n\n    expect(authorization).toContain("if (isNativeMobileClient)");\n    expect(authorization).toContain("pendingUgreenLoginRef.current = false");\n    expect(authorization).toContain("setIsAuthorizingUgreen(false)");\n  });\n});\n`;
fs.writeFileSync("frontend/src/lib/__tests__/ugreenAndroidLoginContract.test.ts", contractTest);

console.log("Applied Android UGREEN 302 login fix");
