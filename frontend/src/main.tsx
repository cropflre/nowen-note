import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/androidCompat";
import "./i18n";
import App from "./App";
import NoteIconBridge from "./components/NoteIconBridge";
import "./index.css";
import "./overlay-layers.css";
import { initCodeBlockTheme } from "./lib/codeBlockTheme";
import { installAndroidNativeHttpBridge } from "./lib/androidNativeHttpBridge";

function removeBootSplash() {
  try {
    window.clearTimeout((window as any).__NOWEN_BOOT_TIMER__);
    const el = document.getElementById("app-boot-splash");
    if (!el) return;
    el.classList.add("app-boot-splash--leaving");
    window.setTimeout(() => el.remove(), 220);
  } catch {
    /* ignore */
  }
}

function BootSplashRemover() {
  React.useEffect(() => {
    removeBootSplash();
  }, []);
  return null;
}

// Android 原生端的 API GET/HEAD 在 React 挂载前启用 CapacitorHttp 优先通道。
// 这会同时覆盖启动鉴权与笔记列表首屏请求，避免蜂窝网络下 WebView fetch 长时间挂起。
installAndroidNativeHttpBridge();

// 在应用渲染前应用已保存的代码块主题，避免首帧闪烁
initCodeBlockTheme();

// 默认展示日间模式：仅在用户首次打开、尚未存过主题偏好时写入 "light"。
// 这样 next-themes 在 enableSystem 开启下也不会被系统暗色覆盖；
// 用户在 ThemeToggle 里切到 system/dark 后，下次启动会沿用其选择。
const THEME_KEY = "nowen-note-theme";
if (typeof localStorage !== "undefined" && !localStorage.getItem(THEME_KEY)) {
  localStorage.setItem(THEME_KEY, "light");
}

// Electron 平台标记：供 CSS 做平台定向样式（主要给 macOS hiddenInset 下的 drag region 用）。
// 放在渲染之前，避免首帧看到侧栏被 Traffic Light 遮挡。
try {
  const desk: any = (window as any).nowenDesktop;
  if (desk && desk.isDesktop && typeof desk.platform === "string") {
    document.documentElement.setAttribute("data-electron", desk.platform);
  }
} catch {
  /* 纯 Web 环境：静默 */
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BootSplashRemover />
    <NoteIconBridge />
    <App />
  </React.StrictMode>
);
