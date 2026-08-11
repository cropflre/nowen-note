import { useEffect } from "react";
import { api } from "@/lib/api";
import { SYNC_SNAPSHOT_APPLIED_EVENT } from "@/lib/syncEngine";
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
