import React from "react";
import ReactDOM from "react-dom/client";
import "./i18n";
import App from "./App";
import "./index.css";
import { initCodeBlockTheme } from "./lib/codeBlockTheme";

// 在应用渲染前应用已保存的代码块主题，避免首帧闪烁
initCodeBlockTheme();

// 默认展示日间模式：仅在用户首次打开、尚未存过主题偏好时写入 "light"。
// 这样 next-themes 在 enableSystem 开启下也不会被系统暗色覆盖；
// 用户在 ThemeToggle 里切到 system/dark 后，下次启动会沿用其选择。
const THEME_KEY = "nowen-note-theme";
if (typeof localStorage !== "undefined" && !localStorage.getItem(THEME_KEY)) {
  localStorage.setItem(THEME_KEY, "light");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
