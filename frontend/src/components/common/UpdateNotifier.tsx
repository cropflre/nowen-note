/**
 * UpdateNotifier — 服务端升级提示
 * =========================================================================
 *
 * 三个场景、两种形态：
 *
 *   [软提示]  后端 bundle 版本 ≠ 当前 bundle
 *       ├─ Web:        刷新按钮 → location.reload()
 *       ├─ Electron:   刷新按钮（同时桌面端还走 electron-updater 二进制升级；
 *       │              那条通道在 updater.js 里独立处理，与本横幅互不干扰）
 *       └─ Android:    刷新按钮（仅换 JS bundle，原生壳保持不变）
 *
 *   [硬提示]  Android 原生壳低于 `minClientVersion`（后端 ENV 配置）
 *       └─ 不可关闭，只提供"前往下载页"——因为 WebView 里刷再多次 JS 也
 *          装不上新的原生 plugin / 权限 / API。用户必须重装 APK。
 *
 * =========================================================================
 * 版本比对策略：
 *
 *   "appVersion 优先 + buildId 辅助去重"
 *
 *   1) server.appVersion 与 __APP_VERSION__ 相等 → 静默。版本号是发版的唯一
 *      信源，相等就不该骚扰用户——即便 buildId 因 dev 态、CDN 前缀、反代重写
 *      等原因对不上，也属于环境差异，不能越权触发提示。
 *
 *   2) server.appVersion 不同 → 真发了新版，提示刷新。展示字符串用 appVersion
 *      （更可读）；dismiss key 在两边 buildId 都存在且不同时升级为
 *      `build:<hash>`，便于"同版本号但偷偷换了 bundle"的极端运维场景下做
 *      精细去重，否则退回 appVersion。
 *
 *   3) server.appVersion 缺失或为 "0.0.0"（/api/version 的 fallback） → 没有
 *      可靠的"新版本"概念，直接不提示。
 *
 *   历史背景：早期版本仅用 appVersion 比对，"只升后端忘推前端" 时前端
 *   __APP_VERSION__ 永远赶不上服务器 → 刷新 loop。后来一度把 buildId 提到
 *   最高优先级，反而引入相反的误报（同 appVersion 但 buildId 不同 → 假阳性）。
 *   现在的折中是：把 buildId 降级为 dismiss 的辅助维度，提示触发完全交给
 *   appVersion，两个误报方向都不会出现。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { RefreshCw, X, AlertTriangle, ExternalLink } from "lucide-react";

// 编译期常量兜底：开发态走 HMR / 旧构建可能没注入，统一给"取不到"的哨兵值。
const CLIENT_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/**
 * 从当前已加载的 <script type="module"> 里提取入口 bundle 的 hashed 文件名
 * 作为 buildId。这个值与后端 `/api/version` 返回的 `frontendBuildId` 是同一
 * 来源（后端也是解析 `dist/index.html` 里的这个 script 标签），因此只要两
 * 边都看到"同一份前端产物"，值就会精确匹配。
 *
 * 取值约束：
 *   - 只认 type="module" 的 script；vite 生产构建里入口 chunk 一定是 module。
 *   - 取第一个匹配到的 src 即可；vite 只有一个 entry HTML。
 *   - 只保留文件名部分（去掉协议 / host / 前缀路径），避免 CDN / baseUrl
 *     变化导致无谓的 buildId 不一致。
 *
 * dev 态（vite dev 走 HMR，没有 hash 文件名）会拿到类似 "main.tsx" 的路径，
 * 与后端解析路径天然不同 → 始终触发软提示。为了不在 dev 态骚扰开发者，
 * 组件上层已经确保 UpdateNotifier 只在登录后挂载；dev 环境下手动关一次
 * 横幅即可走 sessionStorage dismiss 路径，不会反复提示。
 */
function detectClientBuildId(): string | null {
  if (typeof document === "undefined") return null;
  try {
    const scripts = document.querySelectorAll<HTMLScriptElement>(
      'script[type="module"][src]',
    );
    for (const s of scripts) {
      const src = s.getAttribute("src");
      if (!src) continue;
      // 只取文件名；去掉 query / hash / 前缀路径
      const cleaned = src.split("?")[0].split("#")[0];
      const name = cleaned.substring(cleaned.lastIndexOf("/") + 1);
      if (name) return name;
    }
  } catch {
    // ignore
  }
  return null;
}

const CLIENT_BUILD_ID: string | null = detectClientBuildId();

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const DISMISS_KEY = "nowen-update-dismissed-version";

/**
 * dismiss 的读写。
 *
 * 历史：原本只写 sessionStorage，关 tab 即失效——这是对的，因为发版很频繁，
 * 不希望旧 dismiss 永久压住新提示。
 *
 * 现状不够用的两个场景：
 *   1) 用户点"刷新"：仅 reload()，没记 dismiss。如果刷新后版本依然不一致
 *      （典型：dev/leading 版本本地 v1.0.36 而服务器 v1.0.32），就会再弹，
 *      用户感觉"按了刷新没用"。
 *   2) 用户在多 tab 工作：A tab dismiss，B tab 仍弹，体感像"关不掉"。
 *
 * 解决：dismiss 同时写 sessionStorage（向后兼容老逻辑）和 localStorage
 * （跨 tab、跨会话生效）；读取时取两者较新的那个。下一次 server.appVersion
 * 真的变化（=新发版）时，dismiss key 自然失效，提示能力不会被永久关闭。
 */
function readDismissed(): string | null {
  try {
    const ls = localStorage.getItem(DISMISS_KEY);
    if (ls) return ls;
  } catch { /* ignore */ }
  try {
    return sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}
function writeDismissed(key: string) {
  try { sessionStorage.setItem(DISMISS_KEY, key); } catch { /* ignore */ }
  try { localStorage.setItem(DISMISS_KEY, key); } catch { /* ignore */ }
}

// Android native 壳的 APK 下载页（落在 GitHub release 页，最稳）
const APK_DOWNLOAD_URL = "https://github.com/cropflre/nowen-note/releases/latest";

/**
 * 简单的 semver 比较：a < b 返回 -1；a > b 返回 1；相等返回 0。
 * 只处理常见的 `MAJOR.MINOR.PATCH[.EXTRA]` 形态；非法输入按 NaN 处理
 * 时会落到 0（视为相等），从而避免误触发"强制升级"。
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.\-+]/).map((x) => parseInt(x, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * 当前是否运行在 Android 原生壳（Capacitor）里。
 * 我们不在这里 import @capacitor/core（会把 UpdateNotifier 拖进 native 依赖链），
 * 而是复用 useCapacitor.ts 在启动时已经往 <html data-native="..."> 写入的标记。
 * 未挂载 useStatusBarSync 的路径（极少见）会退化为 false，正好避免误伤 Web 用户。
 */
function isAndroidNative(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-native") === "android";
}

export default function UpdateNotifier() {
  const [serverInfo, setServerInfo] = useState<{
    appVersion: string;
    frontendBuildId?: string;
    minClientVersion?: string;
  } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const check = useCallback(async () => {
    try {
      const info = await api.getVersion();
      setServerInfo({
        appVersion: info.appVersion,
        frontendBuildId: info.frontendBuildId,
        minClientVersion: info.minClientVersion,
      });
    } catch {
      // 后端不可达 / 老版本没有 /api/version → 静默失败
    }
  }, []);

  useEffect(() => {
    const initial = setTimeout(check, 3000);
    timerRef.current = setInterval(check, POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        check();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearTimeout(initial);
      if (timerRef.current) clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [check]);

  // 决策中心：区分"硬升级 / 软提示 / 不显示"三态。
  // 用 useMemo 保证 serverInfo / dismissed 变化时 O(1) 重算，避免渲染里写大量三元。
  const state = useMemo((): {
    kind: "none" | "soft" | "hard-android";
    serverDisplay: string; // 横幅里显示用的"目标版本"字符串
  } => {
    if (!serverInfo) return { kind: "none", serverDisplay: "" };

    // ---- 硬升级：仅 Android 原生壳 + 配置了 minClientVersion 时触发 ----
    // WebView 里刷 JS 解决不了原生 plugin / 权限 / API 不兼容，必须重装 APK。
    // 不走 sessionStorage 关闭逻辑（hard 模式本就是阻断性的）。
    if (
      isAndroidNative() &&
      serverInfo.minClientVersion &&
      compareVersions(CLIENT_VERSION, serverInfo.minClientVersion) < 0
    ) {
      return { kind: "hard-android", serverDisplay: serverInfo.minClientVersion };
    }

    // ---- 软提示：前端 bundle 不一致 ----
    //
    // 比对优先级（从强到弱）：
    //   1) appVersion 相等          → 直接静默。这是用户最直觉的"版本号一样
    //      为什么还提示我"。即便 buildId 因 dev 态、CDN 前缀、反代重写等原因
    //      对不上，也不该越权骚扰；版本号是发版的唯一信源。
    //   2) appVersion 不同          → 真发了新版，提示。展示字符串用 appVersion，
    //      dismiss key 用 buildId（若两边都有）以便同版本下不同 bundle 的精细
    //      去重，否则退回 appVersion。
    //   3) appVersion 缺失/不可信   → 服务器是 "0.0.0"（fallback）或空串，
    //      不存在"新版本"语义，直接不提示。
    //
    // 关键修复：之前 buildId 优先级最高，导致 appVersion 相等但 buildId 不同
    // 的常见环境（dev、反代、CDN）也持续提示——明明用户什么也升不动。
    const serverApp = serverInfo.appVersion;
    if (!serverApp || serverApp === "0.0.0") {
      return { kind: "none", serverDisplay: "" };
    }
    if (serverApp === CLIENT_VERSION) {
      // 版本号一致 → 安静。即使 buildId 不同也认为是环境差异（hash 算法 / 反代
      // 路径），而不是"用户需要刷新"。真出现"同版本号不同 bundle"的运维事故，
      // 会通过下一次发版的版本号变化自动恢复提示，不会丢失通知能力。
      return { kind: "none", serverDisplay: "" };
    }

    // 客户端版本号 > 服务端：典型 dev/leading 场景（例如本地 v1.0.36 vs
    // 线上 v1.0.32）。刷新多少次 bundle 都不会让本地 "降级" 到低版本，
    // 此时提示对用户完全无意义，只会反复骚扰。直接静默。
    if (
      CLIENT_VERSION !== "0.0.0" &&
      compareVersions(CLIENT_VERSION, serverApp) > 0
    ) {
      return { kind: "none", serverDisplay: "" };
    }

    // 走到这里说明 appVersion 真的不同 → 提示
    const buildKey =
      serverInfo.frontendBuildId && CLIENT_BUILD_ID && serverInfo.frontendBuildId !== CLIENT_BUILD_ID
        ? `build:${serverInfo.frontendBuildId}`
        : null;
    const displayKey = buildKey ?? serverApp;

    if (displayKey === dismissed) return { kind: "none", serverDisplay: "" };

    return {
      kind: "soft",
      // 即使内部用 buildId 比对，展示给用户仍用 appVersion（更可读）
      serverDisplay: serverInfo.appVersion || "new",
    };
  }, [serverInfo, dismissed]);

  /**
   * 计算当前这对 (server, client) 版本差异对应的 dismiss key。
   * 规则与 state 计算里保持一致：appVersion 为主、buildId 仅作为 "同版本号不同
   * bundle" 的精细去重维度。抽成函数后 handleReload / handleDismiss 共用，保证
   * 两处行为一致。
   *
   * 注意：必须放在所有 early return 之前，否则不同渲染路径下 hook 数量不一致，
   * React 会抛 "Rendered more hooks than during the previous render"。
   */
  const computeDismissKey = useCallback((): string | null => {
    if (!serverInfo) return null;
    const buildKey =
      serverInfo.frontendBuildId && CLIENT_BUILD_ID && serverInfo.frontendBuildId !== CLIENT_BUILD_ID
        ? `build:${serverInfo.frontendBuildId}`
        : null;
    return buildKey ?? serverInfo.appVersion ?? null;
  }, [serverInfo]);

  if (state.kind === "none") return null;

  const handleReload = () => {
    // 先记 dismiss：刷新后如果版本差异依旧存在（后端没推新 bundle、或本地是
    // leading 版本），就不会立刻又弹出——用户点"刷新"的意图已经被尊重过一次。
    const key = computeDismissKey();
    if (key) writeDismissed(key);
    try {
      window.location.reload();
    } catch {
      /* ignore */
    }
  };

  const handleDismiss = () => {
    // 软提示才允许关闭。硬升级走这里不会被调用（UI 根本不渲染关闭按钮）。
    // 走到这里 serverInfo.appVersion 必定 ≠ CLIENT_VERSION（state 计算保证），
    // 所以 dismiss key 至少能拿到一个稳定的服务器版本号；buildId 只在两边
    // 都有且不同时作为更精细的去重维度，避免"同版本号下 bundle 微变"也被
    // 一次 dismiss 永久压住。
    const key = computeDismissKey();
    if (!key) return;
    writeDismissed(key);
    setDismissed(key);
  };

  const handleOpenDownload = () => {
    // Android WebView 里点超链接有时会被拦住；统一用 window.open 兜底到系统浏览器。
    try {
      window.open(APK_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
    } catch {
      window.location.href = APK_DOWNLOAD_URL;
    }
  };

  // ============ 硬升级 UI：全屏遮罩卡片，不可关闭 ============
  if (state.kind === "hard-android") {
    return (
      <div
        className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
        style={{ paddingTop: "calc(var(--safe-area-top, 0px) + 16px)" }}
      >
        <div className="max-w-sm w-full bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 p-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-500/15 flex items-center justify-center flex-shrink-0">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            </div>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              需要更新应用
            </h2>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
            当前版本 <span className="font-mono">v{CLIENT_VERSION}</span> 已不兼容服务端
            （需 <span className="font-mono">v{state.serverDisplay}</span> 或更高）。请
            下载并安装新版本 APK 后继续使用。
          </p>
          <button
            type="button"
            onClick={handleOpenDownload}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-accent-primary text-white text-sm font-medium hover:opacity-90 active:opacity-80 transition-opacity"
          >
            <ExternalLink className="w-4 h-4" />
            前往下载页
          </button>
          <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center">
            GitHub Releases · 请选择最新的 Android APK 资源
          </p>
        </div>
      </div>
    );
  }

  // ============ 软提示 UI：顶部横幅，可关闭 ============
  return (
    <div
      className="fixed top-0 left-0 right-0 z-[10000] flex justify-center pointer-events-none"
      style={{ paddingTop: "calc(var(--safe-area-top, 0px) + 8px)" }}
    >
      <div className="pointer-events-auto max-w-md w-[min(92vw,28rem)] mx-auto flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-600/95 text-white text-sm shadow-lg backdrop-blur-sm">
        <RefreshCw className="w-4 h-4 flex-shrink-0" />
        <span className="flex-1 min-w-0 truncate">
          有新版本 <span className="font-mono font-semibold">v{state.serverDisplay}</span>
          ，当前 <span className="font-mono opacity-80">v{CLIENT_VERSION}</span>
        </span>
        <button
          onClick={handleReload}
          className="flex-shrink-0 px-2.5 py-1 rounded-md bg-white/20 hover:bg-white/30 transition-colors text-xs font-medium"
        >
          刷新
        </button>
        <button
          onClick={handleDismiss}
          className="flex-shrink-0 p-1 rounded-md hover:bg-white/20 transition-colors"
          aria-label="稍后再说"
          title="稍后再说"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
