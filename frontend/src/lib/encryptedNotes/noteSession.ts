import { EncryptedContentSession } from "./sessionClient";
import { EncryptedContentV2Session } from "./sessionV2Client";
import { EncryptedContentError, type EncryptedContentEnvelope } from "./envelope";
import type { ContentEnvelopeV2 } from "./envelopeV2";
import { validateHistoryV2, type EncryptedAttachmentManifest } from "./attachmentCodec";
import { readEncryptedNoteEnvelope, validateEncryptedNotePlaintext } from "./noteDocument";

export type NoteEnvelope = EncryptedContentEnvelope | ContentEnvelopeV2;
/** Text-only product adapter. Private content stays outside the ordinary editor/save tree. */
export class EncryptedNoteSession {
  private readonly v1: EncryptedContentSession | null;
  private readonly v2: EncryptedContentV2Session | null;
  constructor(version: 1 | 2) {
    this.v1 = version === 1 ? new EncryptedContentSession() : null;
    this.v2 = version === 2 ? new EncryptedContentV2Session() : null;
  }
  async open(envelope: NoteEnvelope, passphrase: string, expected: NoteEnvelope, signal?: AbortSignal): Promise<string> {
    if (envelope.version === 1 && expected.version === 1 && this.v1) return this.v1.open(envelope, passphrase, expected, signal);
    if (envelope.version !== 2 || expected.version !== 2 || !this.v2) throw new EncryptedContentError("invalid");
    const document = await this.v2.open(envelope, passphrase, expected, signal);
    this.assertTextOnly(document.attachments);
    return document.content;
  }
  update(envelope: NoteEnvelope, plaintext: string, signal?: AbortSignal): Promise<NoteEnvelope> {
    if (envelope.version === 1 && this.v1) return this.v1.update(envelope, plaintext, signal);
    if (envelope.version !== 2 || !this.v2) throw new EncryptedContentError("invalid");
    return this.v2.update(envelope, { documentSchemaVersion: 1, content: plaintext, attachments: [] }, signal);
  }
  changePassphrase(envelope: NoteEnvelope, passphrase: string, next: string, signal?: AbortSignal): Promise<NoteEnvelope> {
    if (envelope.version === 1 && this.v1) return this.v1.changePassphrase(envelope, passphrase, next, signal);
    if (envelope.version !== 2 || !this.v2) throw new EncryptedContentError("invalid");
    return this.v2.changePassphrase(envelope, passphrase, next, signal);
  }
  async readVersion(row: { id: string; version: number; content?: string | null; contentFormat?: string | null; changeSummary?: string | null }, signal?: AbortSignal) {
    if (typeof row.content !== "string") throw new EncryptedContentError("invalid");
    if (this.v1) {
      const envelope = readEncryptedNoteEnvelope({ content: row.content, contentFormat: row.contentFormat ?? undefined });
      if (envelope.version !== 1) throw new EncryptedContentError("invalid");
      const content = await this.v1.read(envelope, signal);
      validateEncryptedNotePlaintext(content, envelope.originalFormat);
      return { content, format: envelope.originalFormat, changeSummary: row.changeSummary ?? null };
    }
    if (!this.v2) throw new EncryptedContentError("invalid");
    let content: string; let format: "markdown" | "tiptap-json";
    let changeSummary = row.changeSummary ?? null;
    if (row.contentFormat === "encrypted-history-v2") {
      const history = validateHistoryV2(JSON.parse(row.content));
      if (history.historyId !== row.id || history.sourceVersion !== row.version) throw new EncryptedContentError("invalid");
      const opened = await this.v2.decryptHistory(history, signal); this.assertTextOnly(opened.document.attachments);
      content = opened.document.content; format = history.originalFormat;
      changeSummary = opened.changeSummary;
    } else {
      const envelope = readEncryptedNoteEnvelope({ content: row.content, contentFormat: row.contentFormat ?? undefined });
      if (envelope.version !== 2) throw new EncryptedContentError("invalid");
      const document = await this.v2.readDocument(envelope, signal); this.assertTextOnly(document.attachments);
      content = document.content; format = envelope.originalFormat;
    }
    validateEncryptedNotePlaintext(content, format);
    return { content, format, changeSummary };
  }
  private assertTextOnly(attachments: EncryptedAttachmentManifest[]) {
    if (attachments.length) { this.close(); throw new EncryptedContentError("invalid"); }
  }
  close() { this.v1?.close(); this.v2?.close(); }
}
