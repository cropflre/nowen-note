import {
  deleteOfflineAttachment,
  getOfflineAttachment,
  type OfflineAttachmentRecord,
} from "@/lib/localStore";

const offlineRenderUrlAttachmentIds = new Map<string, string>();
let captureInstalled = false;

export function rememberOfflineAttachmentRenderUrl(url: string | null, attachmentId: string): void {
  if (!url || !attachmentId) return;
  offlineRenderUrlAttachmentIds.set(url, attachmentId);
}

export async function quarantineOfflineAttachmentRecord(
  record: OfflineAttachmentRecord,
  _reason = "本地离线附件无效",
): Promise<void> {
  await deleteOfflineAttachment(record.id);
}

export async function quarantineOfflineAttachmentById(
  attachmentId: string,
  reason = "本地离线附件无法解码",
): Promise<boolean> {
  const record = await getOfflineAttachment(attachmentId);
  if (!record) return false;
  await quarantineOfflineAttachmentRecord(record, reason);
  return true;
}

/**
 * Capture resource errors globally so every offline image renderer (Tiptap, Markdown preview,
 * read-only DOM, fullscreen entry points) gets the same bad-cache recovery behavior without
 * duplicating platform-specific onError branches in each component.
 */
export function installOfflineAttachmentRecoveryCapture(): () => void {
  if (typeof window === "undefined" || captureInstalled) return () => undefined;
  captureInstalled = true;

  const handleResourceError = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement)) return;
    const src = target.currentSrc || target.src || target.getAttribute("src") || "";
    const attachmentId = offlineRenderUrlAttachmentIds.get(src);
    if (!attachmentId) return;

    // Forget the failed URL immediately so repeated error dispatches for the same DOM node do
    // not enqueue duplicate retry work while IndexedDB deletion is still in flight.
    offlineRenderUrlAttachmentIds.delete(src);
    void quarantineOfflineAttachmentById(attachmentId).catch((error) => {
      console.warn("[offline-attachment-recovery] quarantine failed", error);
    });
  };

  window.addEventListener("error", handleResourceError, true);
  return () => {
    window.removeEventListener("error", handleResourceError, true);
    captureInstalled = false;
  };
}
