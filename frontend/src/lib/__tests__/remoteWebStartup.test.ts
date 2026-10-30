import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}
const html = source("../../../index.html");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1]).find((value) => value.includes("__NOWEN_BOOT_DIAGNOSTICS__"))!;

function boot(language = "zh-CN", writeText = vi.fn().mockResolvedValue(undefined)) {
  document.body.innerHTML = html.slice(html.indexOf("<body>"), html.indexOf("</body>"));
  const listeners = new Map<string, (event: unknown) => void>();
  const runtime = {
    location: { href: "https://nas.example:33813/", origin: "https://nas.example:33813", pathname: "/" },
    isSecureContext: true,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    getComputedStyle: window.getComputedStyle.bind(window),
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
  } as unknown as Window & {
    __NOWEN_BOOT_READY__: boolean;
    __NOWEN_BOOT_FAILED__: boolean;
    __NOWEN_BOOT_DIAGNOSTICS__: { stage: string; errors: Array<{ source: string }> };
    __NOWEN_REPORT_BOOT_ERROR__: (source: string, error: unknown, fatal: boolean) => void;
    __NOWEN_MARK_BOOT_READY__: () => void;
    __NOWEN_REPORT_BOOT_STAGE__: (stage: string) => void;
  };
  runInNewContext(script, {
    window: runtime, document, navigator: {
      userAgent: "Android FNOS/1.2 FNAppVer/1.37.1", language, clipboard: { writeText },
    },
    localStorage, URL, Date, Promise, Array,
  });
  return runtime;
}

beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); localStorage.clear(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.innerHTML = ""; });

describe("remote Web startup", () => {
  it("keeps loading after 12 seconds rather than reporting a failure", async () => {
    const runtime = boot();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(runtime.__NOWEN_BOOT_FAILED__).toBe(false);
    expect(document.querySelector(".app-boot-title")?.textContent).toBe("仍在加载");
    expect(document.querySelector<HTMLElement>(".app-boot-spinner")?.style.display).not.toBe("none");
    expect(runtime.__NOWEN_BOOT_DIAGNOSTICS__.errors).toEqual([]);
  });

  it("reveals a late login screen and cancels both startup deadlines", async () => {
    const runtime = boot();
    await vi.advanceTimersByTimeAsync(20_000);
    vi.stubGlobal("window", runtime);
    const { observeBootSplashReadiness } = await import("../bootSplash");
    const root = document.getElementById("root")!;
    root.innerHTML = "<form><input /></form>";
    observeBootSplashReadiness(root);
    await vi.advanceTimersByTimeAsync(41_000);
    expect(runtime.__NOWEN_BOOT_READY__).toBe(true);
    expect(document.getElementById("app-boot-splash")).toBeNull();
    expect(root.style.opacity).toBe("1");
    expect(runtime.__NOWEN_BOOT_DIAGNOSTICS__.errors).toEqual([]);
  });

  it("still reports a bounded timeout when the app never becomes ready", async () => {
    const runtime = boot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.__NOWEN_BOOT_FAILED__).toBe(true);
    expect(document.getElementById("app-boot-code")?.textContent).toBe("BOOT_TIMEOUT");
    expect(runtime.__NOWEN_BOOT_DIAGNOSTICS__.stage).toBe("resources");
    expect(runtime.__NOWEN_BOOT_DIAGNOSTICS__.errors).toEqual([expect.objectContaining({ source: "boot-timeout" })]);
  });

  it("can recover automatically even after the hard timeout", async () => {
    const runtime = boot();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.stubGlobal("window", runtime);
    const { observeBootSplashReadiness } = await import("../bootSplash");
    const root = document.getElementById("root")!;
    root.innerHTML = "<main>Workspace</main>";
    observeBootSplashReadiness(root);
    await vi.advanceTimersByTimeAsync(800);
    expect(runtime.__NOWEN_BOOT_FAILED__).toBe(false);
    expect(document.getElementById("app-boot-splash")).toBeNull();
    expect(runtime.__NOWEN_BOOT_DIAGNOSTICS__.stage).toBe("ready");
    runtime.__NOWEN_REPORT_BOOT_STAGE__("authentication");
    expect(runtime.__NOWEN_BOOT_DIAGNOSTICS__.stage).toBe("ready");
  });

  it("keeps an actual runtime failure visible instead of replacing it with slow loading or timeout", async () => {
    const runtime = boot();
    runtime.__NOWEN_REPORT_BOOT_ERROR__("react-render", new Error("render failed"), true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(document.getElementById("app-boot-code")?.textContent).toContain("BOOT_RUNTIME_ERROR");
    expect(runtime.__NOWEN_BOOT_DIAGNOSTICS__.errors).toHaveLength(1);
  });

  it("localizes the slow-loading message before the application modules load", async () => {
    boot("en-US");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(document.querySelector(".app-boot-title")?.textContent).toBe("Still loading");
  });

  it("uses the saved application language for slow-loading feedback", async () => {
    localStorage.setItem("i18nextLng", "en");
    boot();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(document.querySelector(".app-boot-title")?.textContent).toBe("Still loading");
  });

  it("copies startup phase and sanitized resource timings without API URLs or query secrets", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const runtime = boot("zh-CN", writeText);
    Object.assign(runtime, { performance: { getEntriesByType: () => [
      { name: "https://nas.example/assets/main.js?token=secret", duration: 15000, transferSize: 1024, responseStatus: 200 },
      { name: "https://nas.example/api/notes/private", duration: 1234 },
    ] } });
    runtime.__NOWEN_REPORT_BOOT_STAGE__("rendering");
    await vi.advanceTimersByTimeAsync(12_000);
    document.getElementById("app-boot-copy")!.click();
    const copied = JSON.parse(writeText.mock.calls[0][0]);
    expect(copied.stage).toBe("rendering");
    expect(copied.elapsedMs).toBe(12_000);
    expect(copied.resources).toEqual([{
      url: "https://nas.example/assets/main.js", durationMs: 15000, transferSize: 1024, responseStatus: 200,
    }]);
    expect(writeText.mock.calls[0][0]).not.toContain("secret");
    expect(writeText.mock.calls[0][0]).not.toContain("private");
  });
});
