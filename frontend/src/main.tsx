import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/androidCompat";
import "./i18n";
// Must run before App and its import/export/editor schemas are evaluated.
import "./lib/imageNodeTransformBootstrap";
import App from "./App";
import PublicNotebookView from "./components/PublicNotebookView";
import PublicSpaceLauncher from "./components/PublicSpaceLauncher";
import { ThemeProvider } from "./components/ThemeProvider";
import Toaster from "./components/Toaster";
import NoteIconBridge from "./components/NoteIconBridge";
import AIProfileSwitcherBridge from "./components/AIProfileSwitcherBridge";
import MarkdownExperienceBridge from "./components/MarkdownExperienceBridge";
import EmbedPasswordBridge from "./components/EmbedPasswordBridge";
import ImageExperienceBridge from "./components/ImageExperienceBridge";
import MediaExperienceBridge from "./components/MediaExperienceBridge";
import EditorImageTransformBridge from "./components/EditorImageTransformBridge";
import DesktopUpdateCenter from "./components/DesktopUpdateCenter";
import TwoFactorLoginChallengeCenter from "./components/TwoFactorLoginChallengeCenter";
import TaskDataTransferBridgeV2 from "./components/TaskDataTransferBridgeV2";
import SystemFullDataTransferBridge from "./components/SystemFullDataTransferBridge";
import AndroidShareImportCenter from "./components/AndroidShareImportCenter";
import ServerConnectionCenter from "./components/ServerConnectionCenter";
import NoteImageExportCenter from "./components/NoteImageExportCenter";
import "./index.css";
import "./code-block-wrap.css";
import "./overlay-layers.css";
import { initCodeBlockTheme } from "./lib/codeBlockTheme";
import { installAndroidNativeHttpBridge } from "./lib/androidNativeHttpBridge";
import { installMobileStartupBridge } from "./lib/mobileStartupBridge";
import { installMobileWebStartupBridge } from "./lib/mobileWebStartupBridge";
import { installNoteAttachmentAccessBridge } from "./lib/noteAttachmentAccessBridge";
import { installReliableExportDownloadBridge } from "./lib/reliableExportDownloadBridge";
import { installShareLightboxRotationGuard } from "./lib/shareLightboxRotationGuard";
import { installMobileImageFocusGuard } from "./lib/mobileImageFocusGuard";
import { installNoteSyncSafety } from "./lib/noteSyncSafety";
import { installNoteUpdateResponseGuard } from "./lib/noteUpdateResponseGuard";
import { installTaskAttachmentExportFallback } from "./lib/taskAttachmentExportFallback";
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
// Collapse the duplicate Android cold-start collection reads into one compact native response.
// The bridge is Android-only and transparently falls back to the original APIs when unavailable.
installMobileStartupBridge();
// Phones that load the NAS-hosted web bundle (browser, PWA or a remote WebView) do not expose
// the native Capacitor marker. Give them the same compact startup snapshot while leaving desktop
// Web and Electron untouched.
installMobileWebStartupBridge();
// The attachment bridge wraps the active transport so Web, Electron and Capacitor all exchange
// note/share read permission for the same revocable signed URLs before content is rendered.
installNoteAttachmentAccessBridge();
// Observe auth responses after the Android transport bridge is installed so Web, Electron and
// Capacitor all persist the same short-lived 2FA challenge before LoginPage can be remounted.
installTwoFactorLoginChallengeBridge();
// Install the revision guard first, then reject any partial optimistic response left by
// metadata-only writes before it can replace activeNote in React state.
installNoteSyncSafety();
installNoteUpdateResponseGuard();
installShareLightboxRotationGuard();
installMobileImageFocusGuard();
// Keep one stale task-image reference from aborting an otherwise valid full task backup.
installTaskAttachmentExportFallback();
// Route Markdown/ZIP/PDF/DOCX Blob downloads through the reliable HTTP transport. New clients
// connected to an older NAS automatically fall back to the original local Blob download.
installReliableExportDownloadBridge();

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

function resolvePublicNotebookRoute(): { matched: boolean; token?: string } {
  const match = window.location.pathname.match(/^\/public(?:\/([^/]+))?\/?$/);
  if (!match) return { matched: false };
  if (!match[1]) return { matched: true };
  try {
    return { matched: true, token: decodeURIComponent(match[1]) };
  } catch {
    return { matched: true, token: match[1] };
  }
}

const publicRoute = resolvePublicNotebookRoute();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BootSplashRemover />
    {publicRoute.matched ? (
      <ThemeProvider>
        <PublicNotebookView token={publicRoute.token} />
        <Toaster />
      </ThemeProvider>
    ) : (
      <>
        <NoteIconBridge />
        <AIProfileSwitcherBridge />
        <MarkdownExperienceBridge />
        <EmbedPasswordBridge />
        <ImageExperienceBridge />
        <MediaExperienceBridge />
        <EditorImageTransformBridge />
        <DesktopUpdateCenter />
        <TwoFactorLoginChallengeCenter />
        <TaskDataTransferBridgeV2 />
        <SystemFullDataTransferBridge />
        <AndroidShareImportCenter />
        <ServerConnectionCenter />
        <NoteImageExportCenter />
        <PublicSpaceLauncher />
        <App />
      </>
    )}
  </React.StrictMode>,
);
