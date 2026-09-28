import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

describe("iOS WebKit startup contract", () => {
  it("executes a zero-dependency runtime prelude before compatibility/application modules", () => {
    const main = source("../../main.tsx");
    const compatibility = source("../runtimeCompatibility.ts");
    const preludeIndex = main.indexOf('import "./lib/runtimePrelude"');
    const compatibilityIndex = main.indexOf('import "./lib/runtimeCompatibility"');

    expect(preludeIndex).toBeGreaterThanOrEqual(0);
    expect(compatibilityIndex).toBeGreaterThan(preludeIndex);
    expect(compatibility.startsWith('import { installRuntimePrelude } from "./runtimePrelude";')).toBe(true);
    expect(compatibility).toContain("installRuntimePrelude();");
  });

  it("does not depend on Promise.finally to mount the application", () => {
    const main = source("../../main.tsx");

    expect(main).not.toContain(".finally(renderApplication)");
    expect(main).toContain("Promise.resolve()");
    expect(main).toContain('reportBootError("mobile-local-first"');
    expect(main).toContain("ApplicationBootErrorBoundary");
  });

  it("targets Safari and keeps modulepreload compatibility enabled", () => {
    const config = source("../../../vite.config.ts");

    expect(config).toContain('target: ["chrome64", "safari13"]');
    expect(config).toContain('cssTarget: ["chrome64", "safari13"]');
    expect(config).toContain("modulePreload: { polyfill: true }");
  });

  it("captures pre-React boot failures and offers safe diagnostics", () => {
    const html = source("../../../index.html");
    const splash = source("../bootSplash.ts");

    expect(html).toContain("__NOWEN_REPORT_BOOT_ERROR__");
    expect(html).toContain('window.addEventListener("unhandledrejection"');
    expect(html).toContain("应用启动失败");
    expect(html).toContain("复制诊断信息");
    expect(html).toContain('id="app-boot-code"');
    expect(html).not.toContain("加载时间较长，请检查网络或刷新重试");
    expect(splash).toContain("__NOWEN_MARK_BOOT_READY__");
  });
});
