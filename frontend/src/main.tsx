import "./lib/runtimeCompatibility";
import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/androidCompat";
import "./lib/noteTransferRefreshBridge";
import "./lib/workspaceRefreshBridge";
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
import MindMapAppearanceBridge from "./components/MindMapAppearanceBridge";
import EmbedPasswordBridge from "./components/EmbedPasswordBridge";
import ImageExperienceBridge from "./components/ImageExperienceBridge";
import MediaExperienceBridge from "./components/MediaExperienceBridge";
import EditorImageTransformBridge from "./components/EditorImageTransformBridge";
import DesktopUpdateCenter from "./components/DesktopUpdateCenter";
import DockerUpdateCenter from "./components/DockerUpdateCenter";
import TwoFactorLoginChallengeCenter from "./components/TwoFactorLoginChallengeCenter";
import TaskDataTransferBridgeV2 from "./components/TaskDataTransferBridgeV2";
import SystemFullDataTransferBridge from "./components/SystemFullDataTransferBridge";
import AndroidShareImportCenter from "./components/AndroidShareImportCenter";
import NoteImageExportCenter from "./components/NoteImageExportCenter";
import DocxImportCenter from "./components/DocxImportCenter";
import NoteTransferCenter from "./components/NoteTransferCenter";
import RoundTripImportBatchCenter from "./components/RoundTripImportBatchCenter";
import RoundTripPermissionMappingCenter from "./components/RoundTripPermissionMappingCenter";
import RoundTripPermissionExportCenter from "./components/RoundTripPermissionExportCenter";
import "./index.css";
import "./editor-list-markers.css";
import "./code-block-wrap.css";
import "./overlay-layers.css";
import "./space-actions.css";
import "./settings-switches.css";
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
import { installNoteUpdateSerialQueue } from "./lib/noteUpdateSerialQueue";
import { installTaskAttachmentExportFallback } from "./lib/taskAttachmentExportFallback";
import { installTwoFactorLoginChallengeBridge } from "./lib/twoFactorLoginChallenge";
import { installTaskUpdateSafetyBridge } from "./lib/taskUpdateSafetyBridge";
import { installNodeViewMutationGuard } from "./lib/nodeViewMutationGuard";
import { installEditorMediaScopeGuard } from "./lib/editorMediaScopeGuard";
import { installRoundTripImportReviewBridge } from "./lib/roundTripImportReview";
import { installRoundTripPermissionExportBridge } from "./lib/roundTripPermissionExport";
import { installEditorPerformanceGlobal } from "./lib/editorPerformanceHarness";
import { cleanupRemovedServerProfiles } from "./lib/removedServerProfileCleanup";

void cleanupRemovedServerProfiles();

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

installNodeViewMutationGuard();
installEditorMediaScopeGuard();
installAndroidNativeHttpBridge();
installMobileStartupBridge();
installMobileWebStartupBridge();
installNoteAttachmentAccessBridge();
installTwoFactorLoginChallengeBridge();
installNoteSyncSafety();
installNoteUpdateResponseGuard();
installNoteUpdateSerialQueue();
installShareLightboxRotationGuard();
installMobileImageFocusGuard();
installTaskAttachmentExportFallback();
installTaskUpdateSafetyBridge();
installReliableExportDownloadBridge();
installRoundTripImportReviewBridge();
installRoundTripPermissionExportBridge();
installEditorPerformanceGlobal();

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
        <MindMapAppearanceBridge />
        <EmbedPasswordBridge />
        <ImageExperienceBridge />
        <MediaExperienceBridge />
        <EditorImageTransformBridge />
        <DesktopUpdateCenter />
        <DockerUpdateCenter />
        <TwoFactorLoginChallengeCenter />
        <TaskDataTransferBridgeV2 />
        <SystemFullDataTransferBridge />
        <AndroidShareImportCenter />
        <NoteImageExportCenter />
        <DocxImportCenter />
        <PublicSpaceLauncher />
        <NoteTransferCenter />
        <RoundTripImportBatchCenter />
        <RoundTripPermissionMappingCenter />
        <RoundTripPermissionExportCenter />
        <App />
      </>
    )}
  </React.StrictMode>,
);
