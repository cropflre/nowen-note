// 安卓热更新的真实运行环境与全局实例。说明见 docs/architecture/hot-update.md。
import { useSyncExternalStore } from "react";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { toast } from "@/lib/toast";
import {
  createHotUpdateController,
  HotUpdateHttpError,
  type HotUpdateController,
  type HotUpdateEnvironment,
  type HotUpdateRuntimeInfo,
  type HotUpdateSnapshot,
  type LiveUpdateBridge,
} from "./controller";

export type { HotUpdateSnapshot } from "./controller";

const PRODUCTION_CHANNEL = {
  urls: (runtimeVersion: string) => [
    `https://download.nowen.cn/hot/stable/android/${runtimeVersion}.json`,
    `https://github.com/cropflre/nowen-note/releases/latest/download/nowen-hot-android-${runtimeVersion}.json`,
  ],
  allowedOrigins: ["https://download.nowen.cn", "https://github.com"],
};

/** 只有 `vite build --mode hotupdate-test` 的测试包允许改用本机测试服务；正式构建永远走固定地址。 */
function resolveChannel(): HotUpdateEnvironment["channel"] {
  const base = import.meta.env.MODE === "hotupdate-test" ? import.meta.env.VITE_HOT_UPDATE_TEST_CHANNEL : undefined;
  if (typeof base !== "string" || !base) return PRODUCTION_CHANNEL;
  const origin = new URL(base).origin;
  return { urls: (runtimeVersion) => [`${origin}/hot/stable/android/${runtimeVersion}.json`], allowedOrigins: [origin] };
}

interface RuntimePlugin {
  getInfo(): Promise<Partial<Record<keyof HotUpdateRuntimeInfo, string>>>;
}

const NowenHotUpdateRuntime = registerPlugin<RuntimePlugin>("NowenHotUpdateRuntime");

async function fetchText(url: string): Promise<string> {
  // 按小时变化的查询参数，避开 CDN 和 WebView 缓存的旧渠道文件。
  const target = new URL(url);
  target.searchParams.set("t", String(Math.floor(Date.now() / 3_600_000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(target.toString(), { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new HotUpdateHttpError(response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

let bridgePromise: Promise<LiveUpdateBridge> | null = null;

/**
 * 不能直接从 async 函数返回 Capacitor 插件代理：代理对任何属性都返回方法，Promise 解析时会把它当成
 * thenable 调用 `.then()`，安卓上直接报 "LiveUpdate.then() is not implemented"。这里包一层只转发的普通对象。
 */
export function loadLiveUpdateBridge(): Promise<LiveUpdateBridge> {
  bridgePromise ??= import("@capawesome/capacitor-live-update").then(({ LiveUpdate }) => ({
    ready: () => LiveUpdate.ready(),
    getCurrentBundle: () => LiveUpdate.getCurrentBundle(),
    getNextBundle: () => LiveUpdate.getNextBundle(),
    getBundles: () => LiveUpdate.getBundles(),
    getBlockedBundles: () => LiveUpdate.getBlockedBundles(),
    clearBlockedBundles: () => LiveUpdate.clearBlockedBundles(),
    downloadBundle: (options) => LiveUpdate.downloadBundle(options),
    setNextBundle: (options) => LiveUpdate.setNextBundle(options),
    reload: () => LiveUpdate.reload(),
    reset: () => LiveUpdate.reset(),
  }));
  return bridgePromise;
}

function safeStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function createBrowserHotUpdateEnvironment(): HotUpdateEnvironment {
  return {
    isSupported: () => Capacitor.getPlatform() === "android",
    runtime: async () => {
      const info = await NowenHotUpdateRuntime.getInfo();
      return {
        runtimeVersion: info.runtimeVersion || "",
        publicKey: info.publicKey || "",
        keyId: info.keyId || "",
        versionName: info.versionName || null,
        versionCode: info.versionCode || null,
      };
    },
    liveUpdate: loadLiveUpdateBridge,
    fetchText,
    connectionType: async () => (await (await import("@capacitor/network")).Network.getStatus()).connectionType,
    onResume: (listener) => {
      let removed = false;
      let remove: (() => void) | null = null;
      void import("@capacitor/app")
        .then(({ App }) => App.addListener("resume", listener))
        .then((handle) => {
          if (removed) void handle.remove();
          else remove = () => void handle.remove();
        })
        .catch(() => undefined);
      return () => {
        removed = true;
        remove?.();
      };
    },
    notify: (kind, message) => {
      toast[kind](message, 6000);
    },
    storage: safeStorage(),
    now: () => Date.now(),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    currentVersion: typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0",
    channel: resolveChannel(),
  };
}

let instance: HotUpdateController | null = null;

export function getHotUpdateController(): HotUpdateController {
  if (!instance) {
    instance = createHotUpdateController(createBrowserHotUpdateEnvironment());
    // 只给 `--mode hotupdate-test` 的测试包做设备验收用；正式构建里这段在编译期被裁掉。
    if (import.meta.env.MODE === "hotupdate-test") Object.assign(window, { __nowenHotUpdateTest: instance });
  }
  return instance;
}

export function useHotUpdateSnapshot(): HotUpdateSnapshot {
  const controller = getHotUpdateController();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
