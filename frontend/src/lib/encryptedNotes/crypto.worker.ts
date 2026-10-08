import { createEncryptedContent, decryptEncryptedContent, updateEncryptedContent, changeEncryptedContentPassphrase } from "./crypto";
import { EncryptedContentError } from "./envelope";
import type { CryptoRequest, CryptoResponse } from "./protocol";

self.onmessage = async (event: MessageEvent<CryptoRequest>) => {
  const request = event.data;
  let response: CryptoResponse;
  try {
    let result;
    switch (request.operation) {
      case "create": result = await createEncryptedContent(request.input); break;
      case "decrypt": result = await decryptEncryptedContent(request.input.envelope, request.input.passphrase, request.input.expected); break;
      case "update": result = await updateEncryptedContent(request.input.envelope, request.input.passphrase, request.input.expected, request.input.plaintext); break;
      case "change-passphrase": result = await changeEncryptedContentPassphrase(request.input.envelope, request.input.passphrase, request.input.expected, request.input.newPassphrase); break;
      default: throw new EncryptedContentError("invalid");
    }
    response = { ok: true, result };
  } catch (error) {
    response = { ok: false, code: error instanceof EncryptedContentError ? error.code : "unavailable" };
  }
  self.postMessage(response);
};
