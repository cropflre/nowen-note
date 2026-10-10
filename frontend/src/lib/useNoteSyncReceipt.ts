import { useEffect, useState } from "react";
import { getNoteSyncReceipt, NOTE_SYNC_RECEIPT_CHANGED_EVENT, resolveNoteReceiptPhase, type NoteReceiptPhase } from "./noteSyncReceipt";
import { getQueue, subscribe } from "./offlineQueue";
import { getNoteSyncConflict } from "./noteSyncSafety";
import { isAndroidNativeRuntime } from "./mobileLocalMode";
import { MOBILE_SYNC_STATUS_CHANGED_EVENT } from "./mobileSyncStatus";
import { fetchNoteSyncReceipt } from "./syncLocalApi";

/** No aggregate "synced" or lastSyncAt may confirm an individual note. */
export function useNoteSyncReceipt(noteId?: string, syncEnabled = false): NoteReceiptPhase {
  const [phase, setPhase] = useState<NoteReceiptPhase>("unverified");
  useEffect(() => {
    if (!noteId || !syncEnabled) { setPhase("unverified"); return; }
    let disposed = false;
    let requestId = 0;
    const refresh = () => {
      if (isAndroidNativeRuntime()) {
        const current = ++requestId;
        void fetchNoteSyncReceipt(noteId).then((receipt) => {
          if (!disposed && requestId === current) setPhase(receipt.phase);
        }).catch(() => {
          if (!disposed && requestId === current) setPhase("unverified");
        });
        return;
      }
      const queue = getQueue().filter((item) => item.noteId === noteId);
      const next = resolveNoteReceiptPhase(getNoteSyncReceipt(noteId), queue);
      setPhase(getNoteSyncConflict(noteId) ? "conflict" : next);
    };
    refresh();
    const unsubscribe = subscribe(refresh);
    const onReceipt = (event: Event) => {
      if ((event as CustomEvent<{ noteId: string }>).detail?.noteId === noteId) refresh();
    };
    window.addEventListener(NOTE_SYNC_RECEIPT_CHANGED_EVENT, onReceipt);
    window.addEventListener(MOBILE_SYNC_STATUS_CHANGED_EVENT, refresh);
    return () => {
      disposed = true; ++requestId; unsubscribe();
      window.removeEventListener(NOTE_SYNC_RECEIPT_CHANGED_EVENT, onReceipt);
      window.removeEventListener(MOBILE_SYNC_STATUS_CHANGED_EVENT, refresh);
    };
  }, [noteId, syncEnabled]);
  return phase;
}
