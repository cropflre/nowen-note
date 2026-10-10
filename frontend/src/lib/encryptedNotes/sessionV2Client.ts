import { EncryptedContentError } from "./envelope";
import { SessionTransport } from "./sessionTransport";
import type { ContentEnvelopeV2, ContentIdentityV2 } from "./envelopeV2";
import type { EncryptedDocumentV2, EncryptedHistoryPlaintextV2 } from "./cryptoV2";
import type { EncryptedAttachmentManifest, EncryptedHistoryV2, EncryptedUploadDescriptor } from "./attachmentCodec";
import type { SessionV2Io } from "./sessionV2Protocol";

export class EncryptedContentV2Session {
  private readonly transport = new SessionTransport(() => new Worker(new URL("./sessionV2.worker.ts", import.meta.url), { type: "module", name: "nowen-encrypted-session-v2" }));
  async open(envelope: ContentEnvelopeV2, passphrase: string, expected: ContentIdentityV2, signal?: AbortSignal): Promise<EncryptedDocumentV2> {
    try { return await this.transport.call({ operation: "open", input: { envelope, passphrase, expected } }, { signal, kdf: true }) as EncryptedDocumentV2; }
    catch (error) { this.close(); throw error; }
  }
  async create(document: EncryptedDocumentV2, passphrase: string, identity: ContentIdentityV2, signal?: AbortSignal): Promise<ContentEnvelopeV2> {
    try { return await this.transport.call({ operation: "create", input: { document, passphrase, identity } }, { signal, kdf: true }) as ContentEnvelopeV2; }
    catch (error) { this.close(); throw error; }
  }
  update(envelope: ContentEnvelopeV2, document: EncryptedDocumentV2, signal?: AbortSignal): Promise<ContentEnvelopeV2> {
    return this.transport.call({ operation: "update", input: { envelope, document } }, { signal }) as Promise<ContentEnvelopeV2>;
  }
  changePassphrase(envelope: ContentEnvelopeV2, passphrase: string, newPassphrase: string, signal?: AbortSignal): Promise<ContentEnvelopeV2> {
    return this.transport.call({ operation: "change-passphrase", input: { envelope, passphrase, newPassphrase } }, { signal, kdf: true }) as Promise<ContentEnvelopeV2>;
  }
  encryptHistory(context: Pick<EncryptedHistoryV2, "version" | "historyId" | "sourceVersion" | "originalFormat">, document: EncryptedDocumentV2, changeSummary: string | null, signal?: AbortSignal): Promise<EncryptedHistoryV2> {
    return this.transport.call({ operation: "encrypt-history", input: { context, document, changeSummary } }, { signal }) as Promise<EncryptedHistoryV2>;
  }
  decryptHistory(history: EncryptedHistoryV2, signal?: AbortSignal): Promise<EncryptedHistoryPlaintextV2> {
    return this.transport.call({ operation: "decrypt-history", input: { history } }, { signal }) as Promise<EncryptedHistoryPlaintextV2>;
  }
  encryptFile(source: Blob, name: string, mime: string, callbacks: {
    begin: (descriptor: EncryptedUploadDescriptor, signal: AbortSignal) => Promise<void>;
    write: (index: number, bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  }, signal?: AbortSignal): Promise<EncryptedAttachmentManifest> {
    let began = false; let index = 0;
    return this.transport.call({ operation: "encrypt-file", input: { source, name, mime } }, { signal, io: async (value, abort) => {
      const event = value as SessionV2Io;
      if (event.operation === "begin" && !began) { began = true; await callbacks.begin(event.descriptor, abort); }
      else if (event.operation === "write" && began && event.index === index++ && event.bytes instanceof Uint8Array) await callbacks.write(event.index, event.bytes, abort);
      else throw new EncryptedContentError("invalid");
      return null;
    } }) as Promise<EncryptedAttachmentManifest>;
  }
  async decryptFile(manifest: EncryptedAttachmentManifest, callbacks: {
    read: (index: number, signal: AbortSignal) => Promise<Uint8Array>;
    consume: (index: number, bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  }, signal?: AbortSignal): Promise<void> {
    let index = 0; let reading = true;
    await this.transport.call({ operation: "decrypt-file", input: { manifest } }, { signal, io: async (value, abort) => {
      const event = value as SessionV2Io;
      if (event.operation === "read" && reading && event.index === index) { reading = false; return await callbacks.read(event.index, abort); }
      if (event.operation !== "consume" || reading || event.index !== index || !(event.bytes instanceof Uint8Array)) throw new EncryptedContentError("invalid");
      const erase = () => event.bytes.fill(0); abort.addEventListener("abort", erase, { once: true });
      try { await callbacks.consume(index++, event.bytes, abort); reading = true; return null; }
      finally { abort.removeEventListener("abort", erase); erase(); }
    } });
  }
  close() { this.transport.close(); }
}
