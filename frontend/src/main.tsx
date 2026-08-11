import "./lib/runtimeCompatibility";
import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/androidCompat";
import "./lib/noteTransferRefreshBridge";
import "./lib/workspaceRefreshBridge";
import "./i18n";
// Must run before App and its import/export/editor schemas are evaluated.
import "./lib/imageNodeTransformBootstrap";
import { ThemeProvider } from "./components/ThemeProvider";
import { SiteSettingsProvider } from "./hooks/useSiteSettings";
import Toaster from "./components/Toaster";
import NoteIconBridge from "./components/NoteIconBridge";
import EmbedPasswordBridge from "./components/EmbedPasswordBridge";
import ImageExperienceBridge from "./components/ImageExperienceBridge";
import MobileImageViewerBridge from "./components/MobileImageViewerBridge";
import MediaExperienceBridge from "./components/MediaExperienceBridge";
import EditorImageTransformBridge from "./components/EditorImageTransformBridge";
import DesktopUpdateCenter from "./components/DesktopUpdateCenter";
import DockerUpdateCenter from "./components/DockerUpdateCenter";
import TwoFactorLoginChallengeCenter from "./components/TwoFactorLoginChallengeCenter";
import AndroidShareImportCenter from "./components/AndroidShareImportCenter";
import DeferredGlobalFeatureCentersMount from "./components/DeferredGlobalFeatureCentersMount";
import SiyuanRichTextCalloutBridge from "./components/SiyuanRichTextCalloutBridge";
import InlineCommentBridge from "./components/InlineCommentBridge";
import "./index.css";
import "./editor-list-markers.css";
import "./code-block-wrap.css";
import "./overlay-layers.css";
import "./space-actions.css";
import "./settings-switches.css";
import "./sidebar-search-experience.css";
import "./mobile-knowledge-tree-compact.css";
import "./siyuan-rich-text-callout.css";
import "./knowledge-tree-markdown-drop.css";
import "./inline-comments.css";
import "./loading-experience.css";
import { initCodeBlockTheme } from "./lib/codeBlockTheme";
import { installAndroidNativeHttpBridge } from "./lib/androidNativeHttpBridge";
import { installDesktopNativeHttpBridge } from "./lib/desktopNativeHttpBridge";
import { installMobileStartupBridge } from "./lib/mobileStartupBridge";
import { installMobileWebStartupBridge } from "./lib/mobileWebStartupBridge";
import { installNoteAttachmentAccessBridge } from "./lib/noteAttachmentAccessBridge";
import { installReliableExportDownloadBridge } from "./lib/reliableExportDownloadBridge";
import { installShareLightboxRotationGuard } from "./lib/shareLightboxRotationGuard";
import { installMobileImageFocusGuard } from "./lib/mobileImageFocusGuard";
import { installNoteSyncSafety } from "./lib/noteSyncSafety";
import { installNoteUpdateResponseGuard } from "./lib/noteUpdateResponseGuard";
import { installNoteUpdateSerialQueue } from "./lib/noteUpdateSerialQueue";
import { installKnowledgeTreeTitleSyncBridge } from "./lib/knowledgeTreeTitleSyncBridge";
import { installTaskAttachmentExportFallback } from "./lib/taskAttachmentExportFallback";
import { installTwoFactorLoginChallengeBridge } from "./lib/twoFactorLoginChallenge";
import { installTaskUpdateSafetyBridge } from "./lib/taskUpdateSafetyBridge";
import { installNodeViewMutationGuard } from "./lib/nodeViewMutationGuard";
import { installEditorMediaScopeGuard } from "./lib/editorMediaScopeGuard";
import { installRoundTripImportReviewBridge } from "./lib/roundTripImportReview";
import { installRoundTripPermissionExportBridge } from "./lib/roundTripPermissionExport";
import { installEditorPerformanceGlobal } from "./lib/editorPerformanceHarness";
import { installIssue210SignoffRuntime } from "./lib/issue210Signoff";
import { cleanupRemovedServerProfiles } from "./lib/removedServerProfileCleanup";
import { installKnowledgeTreeScrollbarBridge } from "./lib/knowledgeTreeScrollbarBridge";
import { installKnowledgeTreeMarkdownDrop } from "./lib/knowledgeTreeMarkdownDrop";
import { installInlineCommentTooltipMount } from "./lib/inlineCommentTooltipMount";
import { resolveCurrentAppPathname } from "./lib/appPathNavigation";
import { installUgreenCredentialedFetch } from "./lib/ugreenRemoteAccess";
import { observeBootSplashReadiness } from "./lib/bootSplash";

const App = React.lazy(() => import("./App"));
const PublicNotebookView = React.lazy(() => import("./components/PublicNotebookView"));

void cleanupRemovedServerProfiles();
installUgreenCredentialedFetch();

/**
 * The HTML startup card stays above React while lazy modules, auth restoration and quick
 * login probing are running. Once a real route or interactive surface mounts, this observer
 * dismisses it with the minimum-visible-time guard from bootSplash.ts.
 */
function BootSplashReadinessObserver() {
  React.useEffect(() => observeBootSplashReadiness(document.getElementById("root")), []);
  return null;
}

/**
 * Suspense must stay visually silent during cold start. The HTML startup card already owns
 * that feedback; rendering another centered spinner here caused the second loading screen.
 */
function MainRouteFallback() {
  return null;
}

installKnowledgeTreeScrollbarBridge();
installKnowledgeTreeMarkdownDrop();
installNodeViewMutationGuard();
installEditorMediaScopeGuard();
installAndroidNativeHttpBridge();
installDesktopNativeHttpBridge();
installMobileStartupBridge();
installMobileWebStartupBridge();
installNoteAttachmentAccessBridge();
installTwoFactorLoginChallengeBridge();
installNoteSyncSafety();
installNoteUpdateResponseGuard();
installNoteUpdateSerialQueue();
installKnowledgeTreeTitleSyncBridge();
installShareLightboxRotationGuard();
installMobileImageFocusGuard();
installTaskAttachmentExportFallback();
installTaskUpdateSafetyBridge();
installReliableExportDownloadBridge();
installRoundTripImportReviewBridge();
installRoundTripPermissionExportBridge();
installEditorPerformanceGlobal();
installIssue210SignoffRuntime();
installInlineCommentTooltipMount();

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
  const match = resolveCurrentAppPathname().match(/^\/public(?:\/([^/]+))?\/?$/);
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
    <SiteSettingsProvider>
      <BootSplashReadinessObserver />
      {publicRoute.matched ? (
        <ThemeProvider>
          <React.Suspense fallback={<MainRouteFallback />}>
            <PublicNotebookView token={publicRoute.token} />
          </React.Suspense>
          <Toaster />
        </ThemeProvider>
      ) : (
        <>
          <NoteIconBridge />
          <EmbedPasswordBridge />
          <ImageExperienceBridge />
          <MobileImageViewerBridge />
          <MediaExperienceBridge />
          <EditorImageTransformBridge />
          <DesktopUpdateCenter />
          <DockerUpdateCenter />
          <TwoFactorLoginChallengeCenter />
          <AndroidShareImportCenter />
          <DeferredGlobalFeatureCentersMount />
          <SiyuanRichTextCalloutBridge />
          <InlineCommentBridge />
          <React.Suspense fallback={<MainRouteFallback />}>
            <App />
          </React.Suspense>
        </>
      )}
    </SiteSettingsProvider>
  </React.StrictMode>,
);
