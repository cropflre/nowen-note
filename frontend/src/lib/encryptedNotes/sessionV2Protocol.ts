import type { ContentEnvelopeV2, ContentIdentityV2 } from "./envelopeV2";
import type { EncryptedDocumentV2 } from "./cryptoV2";
import type { EncryptedAttachmentManifest, EncryptedHistoryV2, EncryptedUploadDescriptor } from "./attachmentCodec";

export type SessionV2Request = { id: number } & (
  | { operation: "open"; input: { envelope: ContentEnvelopeV2; passphrase: string; expected: ContentIdentityV2 } }
  | { operation: "create"; input: { document: EncryptedDocumentV2; passphrase: string; identity: ContentIdentityV2 } }
  | { operation: "update"; input: { envelope: ContentEnvelopeV2; document: EncryptedDocumentV2 } }
  | { operation: "change-passphrase"; input: { envelope: ContentEnvelopeV2; passphrase: string; newPassphrase: string } }
  | { operation: "encrypt-history"; input: { context: Pick<EncryptedHistoryV2, "version" | "historyId" | "sourceVersion" | "originalFormat">; document: EncryptedDocumentV2; changeSummary: string | null } }
  | { operation: "decrypt-history"; input: { history: EncryptedHistoryV2 } }
  | { operation: "encrypt-file"; input: { source: Blob; name: string; mime: string } }
  | { operation: "decrypt-file"; input: { manifest: EncryptedAttachmentManifest } }
);
export type SessionV2Io =
  | { operation: "begin"; descriptor: EncryptedUploadDescriptor }
  | { operation: "write"; index: number; bytes: Uint8Array }
  | { operation: "read"; index: number }
  | { operation: "consume"; index: number; bytes: Uint8Array };
