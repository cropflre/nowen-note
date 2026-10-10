import { EncryptedContentError } from "./envelope";
import { identityV2, type ContentIdentityV2 } from "./envelopeV2";
import { changeContentV2Passphrase, createContentV2Session, decryptHistoryV2, encryptHistoryV2, unlockContentV2, updateContentV2, validateDocumentV2, type EncryptedDocumentV2 } from "./cryptoV2";
import { decryptAttachment, encryptAttachment, validateAttachmentManifest } from "./attachmentCodec";
import type { SessionV2Io, SessionV2Request } from "./sessionV2Protocol";

let key: CryptoKey | undefined;
let identity: ContentIdentityV2 | undefined;
let busy = false;
let currentFiles = new Set<string>();
let historyFiles = new Set<string>();
const preparedFiles = new Set<string>();
let nextIo = 0;
let pendingIo: { id: number; ioId: number; resolve: (result: unknown) => void; reject: () => void } | undefined;
function remember(document: EncryptedDocumentV2) {
  currentFiles = new Set(document.attachments.map((manifest) => JSON.stringify(manifest)));
  for (const manifest of currentFiles) preparedFiles.delete(manifest);
}
function io(id: number, value: SessionV2Io): Promise<unknown> {
  if (pendingIo) return Promise.reject(new EncryptedContentError("busy"));
  return new Promise((resolve, reject) => {
    const ioId = ++nextIo; pendingIo = { id, ioId, resolve, reject: () => reject(new EncryptedContentError("unavailable")) };
    const transfers = "bytes" in value ? [value.bytes.buffer] : [];
    try { self.postMessage({ id, ioId, io: value }, { transfer: transfers }); }
    catch { pendingIo = undefined; reject(new EncryptedContentError("unavailable")); }
  });
}
self.onmessage = async (event: MessageEvent<SessionV2Request | { id: number; ioId: number; ok: boolean; result?: unknown }>) => {
  const request = event.data;
  if ("ioId" in request) {
    if (!pendingIo || request.id !== pendingIo.id || request.ioId !== pendingIo.ioId) { pendingIo?.reject(); pendingIo = undefined; return; }
    const pending = pendingIo; pendingIo = undefined; if (request.ok) pending.resolve(request.result); else pending.reject(); return;
  }
  if (busy) { self.postMessage({ id: request.id, ok: false, code: "busy" }); return; }
  busy = true;
  try {
    let result: unknown;
    if (request.operation === "open" || request.operation === "create") {
      if (key) throw new EncryptedContentError("invalid");
      if (request.operation === "open") {
        const opened = await unlockContentV2(request.input.envelope, request.input.passphrase, request.input.expected);
        key = opened.key; identity = identityV2(request.input.expected); remember(opened.document); result = opened.document;
      } else {
        const created = await createContentV2Session(request.input); key = created.key; identity = identityV2(created.envelope);
        remember(validateDocumentV2(request.input.document)); result = created.envelope;
      }
    } else {
      if (!key || !identity) throw new EncryptedContentError("invalid");
      switch (request.operation) {
        case "update": result = await updateContentV2(request.input.envelope, key, identity, request.input.document); remember(validateDocumentV2(request.input.document)); break;
        case "change-passphrase": result = await changeContentV2Passphrase(request.input.envelope, request.input.passphrase, identity, request.input.newPassphrase); break;
        case "encrypt-history": result = await encryptHistoryV2(key, identity, request.input.context, request.input.document, request.input.changeSummary); break;
        case "decrypt-history": {
          const history = await decryptHistoryV2(key, identity, request.input.history);
          historyFiles = new Set(history.document.attachments.map((manifest) => JSON.stringify(manifest))); result = history; break;
        }
        case "encrypt-file": {
          if (preparedFiles.size >= 1000) throw new EncryptedContentError("invalid");
          const manifest = await encryptAttachment({ ...request.input, rootKey: key, identity,
            begin: async (descriptor) => { await io(request.id, { operation: "begin", descriptor }); },
            writeChunk: async (index, bytes) => { await io(request.id, { operation: "write", index, bytes }); } });
          preparedFiles.add(JSON.stringify(manifest)); result = manifest; break;
        }
        case "decrypt-file": {
          const manifest = validateAttachmentManifest(request.input.manifest); const serialized = JSON.stringify(manifest);
          if (!currentFiles.has(serialized) && !historyFiles.has(serialized) && !preparedFiles.has(serialized)) throw new EncryptedContentError("invalid");
          let index = 0;
          for await (const bytes of decryptAttachment({ manifest, rootKey: key, identity, readChunk: async (chunk) => {
            const result = await io(request.id, { operation: "read", index: chunk });
            if (!(result instanceof Uint8Array)) throw new EncryptedContentError("invalid"); return result;
          } })) await io(request.id, { operation: "consume", index: index++, bytes: bytes.slice() });
          result = null; break;
        }
        default: throw new EncryptedContentError("invalid");
      }
    }
    self.postMessage({ id: request.id, ok: true, result });
  } catch (error) { self.postMessage({ id: request.id, ok: false, code: error instanceof EncryptedContentError ? error.code : "unavailable" }); }
  finally { busy = false; }
};
