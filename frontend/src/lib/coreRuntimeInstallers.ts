import { initCodeBlockTheme } from "./codeBlockTheme";
import { installAndroidNativeHttpBridge } from "./androidNativeHttpBridge";
import { installDesktopNativeHttpBridge } from "./desktopNativeHttpBridge";
import { installMobileStartupBridge } from "./mobileStartupBridge";
import { installMobileWebStartupBridge } from "./mobileWebStartupBridge";
import { installAttachmentUploadPolicyBridge } from "./attachmentUploadPolicyBridge";
import { captureAttachmentAccessUpstreamFetch } from "./attachmentAccessUpstreamFetch";
import { installNoteAttachmentAccessBridge } from "./noteAttachmentAccessBridge";
import { installNonBlockingNoteFetch } from "./nonBlockingNoteFetch";
import { installReliableExportDownloadBridge } from "./reliableExportDownloadBridge";
import { installNoteSyncSafety } from "./noteSyncSafety";
import { installNoteUpdateResponseGuard } from "./noteUpdateResponseGuard";
import { installNoteUpdateSerialQueue } from "./noteUpdateSerialQueue";
import { installKnowledgeTreeTitleSyncBridge } from "./knowledgeTreeTitleSyncBridge";
import { installKnowledgeTreeNoteLoadRecovery } from "./knowledgeTreeNoteLoadRecovery";
import { installTaskAttachmentExportFallback } from "./taskAttachmentExportFallback";
import { installTwoFactorLoginChallengeBridge } from "./twoFactorLoginChallenge";
import { installTaskUpdateSafetyBridge } from "./taskUpdateSafetyBridge";
import { installNodeViewMutationGuard } from "./nodeViewMutationGuard";
import { installEditorMediaScopeGuard } from "./editorMediaScopeGuard";
import { installRoundTripImportReviewBridge } from "./roundTripImportReview";
import { installRoundTripPermissionExportBridge } from "./roundTripPermissionExport";
import { installEditorPerformanceGlobal } from "./editorPerformanceHarness";
import { installIssue210SignoffRuntime } from "./issue210Signoff";
import { cleanupRemovedServerProfiles } from "./removedServerProfileCleanup";
import { installKnowledgeTreeScrollbarBridge } from "./knowledgeTreeScrollbarBridge";
import { installKnowledgeTreeMarkdownDrop } from "./knowledgeTreeMarkdownDrop";
import { installInlineCommentTooltipMount } from "./inlineCommentTooltipMount";
import { installUgreenCredentialedFetch } from "./ugreenRemoteAccess";

/**
 * Install transport and editor guards before starting any local session or mounting App.
 * Kept in a separately fetched chunk so the login entry does not eagerly embed these
 * low-frequency bridge dependencies; ordering is unchanged from the original entry.
 */
export function installCoreRuntime(
  installOptionalRuntime: (source: string, install: () => unknown) => void,
  reportBootError: (source: string, error: unknown, fatal: boolean) => void,
): void {
  try {
    void Promise.resolve(cleanupRemovedServerProfiles()).catch((error) => {
      reportBootError("removed-server-profile-cleanup", error, false);
    });
  } catch (error) {
    reportBootError("removed-server-profile-cleanup", error, false);
  }
  installOptionalRuntime("ugreen-credentialed-fetch", installUgreenCredentialedFetch);

  installOptionalRuntime("knowledge-tree-scrollbar", installKnowledgeTreeScrollbarBridge);
  installOptionalRuntime("knowledge-tree-markdown-drop", installKnowledgeTreeMarkdownDrop);
  installOptionalRuntime("node-view-mutation-guard", installNodeViewMutationGuard);
  installOptionalRuntime("editor-media-scope-guard", installEditorMediaScopeGuard);
  installOptionalRuntime("android-native-http", installAndroidNativeHttpBridge);
  installOptionalRuntime("desktop-native-http", installDesktopNativeHttpBridge);
  installOptionalRuntime("mobile-startup", installMobileStartupBridge);
  installOptionalRuntime("mobile-web-startup", installMobileWebStartupBridge);
  // Install the runtime upload contract before any editor starts sending attachments. The policy
  // endpoint is warmed in the background; every actual upload still re-checks it before POST.
  installOptionalRuntime("attachment-upload-policy", installAttachmentUploadPolicyBridge);
  // Keep every transport wrapper installed above, but capture the chain before the attachment
  // bridge adds its note-detail prerequisite wait. Canonical note text can then render first while
  // signed media access is prepared in the background.
  installOptionalRuntime("attachment-access-upstream", captureAttachmentAccessUpstreamFetch);
  installOptionalRuntime("note-attachment-access", installNoteAttachmentAccessBridge);
  installOptionalRuntime("non-blocking-note-fetch", installNonBlockingNoteFetch);
  installOptionalRuntime("two-factor-login-challenge", installTwoFactorLoginChallengeBridge);
  installOptionalRuntime("note-sync-safety", installNoteSyncSafety);
  installOptionalRuntime("note-update-response-guard", installNoteUpdateResponseGuard);
  installOptionalRuntime("note-update-serial-queue", installNoteUpdateSerialQueue);
  installOptionalRuntime("knowledge-tree-title-sync", installKnowledgeTreeTitleSyncBridge);
  installOptionalRuntime("knowledge-tree-note-load-recovery", installKnowledgeTreeNoteLoadRecovery);
  installOptionalRuntime("task-attachment-export-fallback", installTaskAttachmentExportFallback);
  installOptionalRuntime("task-update-safety", installTaskUpdateSafetyBridge);
  installOptionalRuntime("reliable-export-download", installReliableExportDownloadBridge);
  installOptionalRuntime("round-trip-import-review", installRoundTripImportReviewBridge);
  installOptionalRuntime("round-trip-permission-export", installRoundTripPermissionExportBridge);
  installOptionalRuntime("editor-performance-global", installEditorPerformanceGlobal);
  installOptionalRuntime("issue-210-signoff", installIssue210SignoffRuntime);
  installOptionalRuntime("inline-comment-tooltip", installInlineCommentTooltipMount);
  installOptionalRuntime("code-block-theme", initCodeBlockTheme);
}
