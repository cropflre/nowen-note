import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/androidCompat";
import "./i18n";
// Must run before App and its import/export/editor schemas are evaluated.
import "./lib/imageNodeTransformBootstrap";
import App from "./App";
import NoteIconBridge from "./components/NoteIconBridge";
import AIProfileSwitcherBridge from "./components/AIProfileSwitcherBridge";
import MarkdownExperienceBridge from "./components/MarkdownExperienceBridge";
import ImageExperienceBridge from "./components/ImageExperienceBridge";
import EditorImageTransformBridge from "./components/EditorImageTransformBridge";
import DesktopUpdateCenter from "./components/DesktopUpdateCenter";
import TwoFactorLoginChallengeCenter from "./components/TwoFactorLoginChallengeCenter";
import TaskDataTransferBridge from "./components/TaskDataTransferBridge";
import "./index.css";
import "./overlay-layers.css";
import { initCodeBlockTheme } from "./lib/codeBlockTheme";
import { installAndroidNativeHttpBridge } from "./lib/androidNativeHttpBridge";
import { installShareLightboxRotationGuard } from "./lib/shareLightboxRotationGuard";
import { installMobileImageFocusGuard } from "./lib/mobileImageFocusGuard";
import { installNoteSyncSafety } from "./lib/noteSyncSafety";
import { installNoteUpdateResponseGuard } from "./lib/noteUpdateResponseGuard";
import { installTwoFactorLoginChallengeBridge } from "./lib/twoFactorLoginChallenge";

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

installAndroidNativeHttpBridge();
// Observe auth responses after the Android transport bridge is installed so Web, Electron and
// Capacitor all persist the same short-lived 2FA challenge before LoginPage can be remounted.
installTwoFactorLoginChallengeBridge();
// Install the revision guard first, then reject any partial optimistic response left by
// metadata-only writes before it can replace activeNote in React state.
installNoteSyncSafety();
installNoteUpdateResponseGuard();
installShareLightboxRotationGuard();
installMobileImageFocusGuard();

initCodeBlockTheme();

const THEME_KEY = "nowen-note-theme";
if (typeof localStorage !== "undefined" && !localStorage.getItem(THEME_KEY)) {
  localStorage.setItem(THEME_KEY, "light");
}

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
    <AIProfileSwitcherBridge />
    <MarkdownExperienceBridge />
    <ImageExperienceBridge />
    <EditorImageTransformBridge />
    <DesktopUpdateCenter />
    <TwoFactorLoginChallengeCenter />
    <TaskDataTransferBridge />
    <App />
  </React.StrictMode>
);
