import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import { applyTheme, watchSystemTheme } from "./lib/theme";
import { applyEditorFontSize } from "./lib/editorFontSize";
import { applyUiStyle } from "./lib/uiStyle";

// index.html 里的内联脚本已经在首帧前定过主题了，这里再跑一次是为了：
//   ① 万一内联脚本被 CSP 拦掉（那时是浅色兜底）；
//   ② 挂上「跟随系统」的监听 —— 系统切深色时立刻跟着变。
applyTheme();
watchSystemTheme();
applyEditorFontSize();
applyUiStyle();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
