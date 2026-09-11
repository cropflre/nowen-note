import { api } from "@/lib/api";
import {
  formatAttachmentLimit,
  loadAttachmentUploadPolicy,
  validateAttachmentSize,
  warmAttachmentUploadPolicy,
} from "@/lib/attachmentUploadPolicy";
import { UploadRequestError } from "@/lib/uploadRequest";

const INSTALL_FLAG = Symbol.for("nowen.attachmentUploadPolicyBridge.installed");

type FlaggedWindow = Window & Record<symbol, boolean>;

/**
 * One upload boundary for editor, paste, drag-drop, imports and media picker.
 * The server policy is fetched at runtime, so MAX_ATTACHMENT_SIZE_MB changes do not require a
 * frontend rebuild. If policy discovery fails, the POST remains authoritative instead of using a
 * guessed local limit.
 */
export function installAttachmentUploadPolicyBridge(): void {
  if (typeof window === "undefined") return;
  const flagged = window as FlaggedWindow;
  if (flagged[INSTALL_FLAG]) return;
  flagged[INSTALL_FLAG] = true;

  const nativeUpload = api.attachments.upload.bind(api.attachments);
  api.attachments.upload = (async (noteId: string, file: File) => {
    const policy = await loadAttachmentUploadPolicy();
    const validation = validateAttachmentSize(file.size, policy);
    if (!validation.ok) {
      throw new UploadRequestError(validation.message, {
        code: "ATTACHMENT_TOO_LARGE",
        status: 413,
        retryable: false,
        maxSizeBytes: validation.maxSizeBytes,
        actualSizeBytes: validation.actualSizeBytes,
      });
    }

    try {
      return await nativeUpload(noteId, file);
    } catch (error) {
      if (error instanceof UploadRequestError && error.code === "ATTACHMENT_TOO_LARGE") {
        const max = error.maxSizeBytes || policy.maxAttachmentSizeBytes;
        error.message = `文件大小超过服务器附件上限 ${formatAttachmentLimit(max)}`;
      }
      throw error;
    }
  }) as typeof api.attachments.upload;

  warmAttachmentUploadPolicy();
}
