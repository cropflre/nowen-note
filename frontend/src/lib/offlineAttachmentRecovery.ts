import {
  deleteOfflineAttachment,
  getOfflineAttachment,
  putOfflineAttachmentJob,
  type OfflineAttachmentRecord,
} from "@/lib/localStore";

export const OFFLINE_ATTACHMENT_RETRY_EVENT = "nowen:offline-attachment-retry-requested";

const offlineRenderUrlAttachmentIds = new Map<string, string>();
let captureInstalled = false;

export function requestOfflineAttachmentRetry(attachmentIds: readonly string[]): void {
  if (attachmentIds.length === 0 || typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OFFLINE_ATTACHMENT_RETRY_EVENT, {
    detail: { attachmentIds: [...attachmentIds] },
  }));
}

export function rememberOfflineAttachmentRenderUrl(url: string | null, attachmentId: string): void {
  if (!url || !attachmentId) return;
  offlineRenderUrlAttachmentIds.set(url, attachmentId);
}

function toRetryJob(record: OfflineAttachmentRecord) {
  return {
    id: record.id,
    noteId: record.noteId,
    filename: record.filename,
    mimeType: record.mimeType,
    // record.size is the server/manifest size for legacy zero-byte cache entries and is
    // therefore the best expected size to preserve when requesting a fresh download.
    size: record.size,
    createdAt: record.createdAt,
    queuedAt: Date.now(),
    retryCount: 0,
    lastAttemptAt: Date.now(),
    lastError: "本地离线附件无效，等待重新下载",
  };
}

export async function quarantineOfflineAttachmentRecord(
  record: OfflineAttachmentRecord,
  reason = "本地离线附件无效",
): Promise<void> {
  await deleteOfflineAttachment(record.id);
  await putOfflineAttachmentJob({
    ...toRetryJob(record),
    lastError: reason,
  });
  requestOfflineAttachmentRetry([record.id]);
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
