import { NowenClient as CoreNowenClient } from "./client.js";
import { NowenAttachmentClient } from "./attachments.js";
import type { NowenConfig } from "./types.js";
import type {
  AttachToNoteParams,
  AttachmentFile,
  AttachmentListResponse,
  AttachmentUploadResult,
  ListAttachmentsParams,
  UploadAttachmentParams,
} from "./attachments.js";

/**
 * Public SDK client.
 *
 * The original REST client remains the superclass, so all existing methods and constructor
 * behaviour stay compatible. Attachment methods are delegated to the binary-focused client to
 * keep multipart/FormData concerns isolated without forcing consumers to create a second client.
 */
export class NowenClient extends CoreNowenClient {
  readonly attachments: NowenAttachmentClient;

  constructor(config: NowenConfig) {
    super(config);
    this.attachments = new NowenAttachmentClient(config);
  }

  uploadAttachment(params: UploadAttachmentParams): Promise<AttachmentUploadResult> {
    return this.attachments.uploadAttachment(params);
  }

  listAttachments(params: ListAttachmentsParams = {}): Promise<AttachmentListResponse> {
    return this.attachments.listAttachments(params);
  }

  getAttachment(id: string): Promise<AttachmentFile> {
    return this.attachments.getAttachment(id);
  }

  attachToNote(params: AttachToNoteParams): Promise<Record<string, unknown>> {
    return this.attachments.attachToNote(params);
  }
}
