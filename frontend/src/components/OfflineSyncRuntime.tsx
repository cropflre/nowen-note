import { useEffect } from "react";
import { api } from "@/lib/api";
import { SYNC_SNAPSHOT_APPLIED_EVENT } from "@/lib/syncEngine";
import { syncOfflineWorkspace } from "@/lib/offlineWorkspaceSync";
import {
  installOfflineAttachmentRecoveryCapture,
  OFFLINE_ATTACHMENT_RETRY_EVENT,
} from "@/lib/offlineAttachmentRecovery";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useAppActions } from "@/store/AppContext";

/**
 * Headless sync runtime shared by Web, Electron and mobile.
 *
 * Network probing, offline queue replay and collection refresh remain active, but sync state is
 * no longer promoted into a global banner, snackbar or recovery notification.
 */
export default function OfflineSyncRuntime() {
  const actions = useAppActions();
  useNetworkStatus({ signalRecovery: false });

  useEffect(() => installOfflineAttachmentRecoveryCapture(), []);

  useEffect(() => {
    const handleAttachmentRetry = () => {
      // syncOfflineWorkspace already coalesces concurrent runs. If a broken local Blob is
      // quarantined while a sync is active, the queued job remains durable and the normal
      // interval will pick it up even when this call joins the current run.
      void syncOfflineWorkspace({ force: true, reason: "network" });
    };
    window.addEventListener(OFFLINE_ATTACHMENT_RETRY_EVENT, handleAttachmentRetry);
    return () => window.removeEventListener(OFFLINE_ATTACHMENT_RETRY_EVENT, handleAttachmentRetry);
  }, []);

  useEffect(() => {
    const handleSnapshot = () => {
      actions.refreshNotes();
      actions.refreshNotebooks();
      api.getTags().then(actions.setTags).catch((error) => {
        console.warn("[OfflineSyncRuntime] refresh tags after sync failed:", error);
      });
    };
    window.addEventListener(SYNC_SNAPSHOT_APPLIED_EVENT, handleSnapshot);
    return () => window.removeEventListener(SYNC_SNAPSHOT_APPLIED_EVENT, handleSnapshot);
  }, [actions]);

  return null;
}
