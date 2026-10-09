import { changeEncryptedContentPassphrase, unlockEncryptedContentKey, updateEncryptedContentWithKey } from "./crypto";
import { EncryptedContentError, type EncryptedContentIdentity } from "./envelope";
import type { SessionRequest, SessionResponse } from "./sessionProtocol";

let key: CryptoKey | undefined;
let identity: EncryptedContentIdentity | undefined;
let busy = false;
self.onmessage = async (event: MessageEvent<SessionRequest>) => {
  const request = event.data;
  let response: SessionResponse;
  if (busy) { self.postMessage({ id: request.id, ok: false, code: "busy" }); return; }
  busy = true;
  try {
    let result;
    if (request.operation === "open") {
      if (key) throw new EncryptedContentError("invalid");
      const opened = await unlockEncryptedContentKey(request.input.envelope, request.input.passphrase, request.input.expected);
      key = opened.key; identity = { ...request.input.expected }; result = opened.plaintext;
    } else {
      if (!key || !identity) throw new EncryptedContentError("invalid");
      if (request.operation === "update") result = await updateEncryptedContentWithKey(request.input.envelope, key, identity, request.input.plaintext);
      else if (request.operation === "change-passphrase") result = await changeEncryptedContentPassphrase(request.input.envelope, request.input.passphrase, identity, request.input.newPassphrase);
      else throw new EncryptedContentError("invalid");
    }
    response = { id: request.id, ok: true, result };
  } catch (error) {
    response = { id: request.id, ok: false, code: error instanceof EncryptedContentError ? error.code : "unavailable" };
  } finally { busy = false; }
  self.postMessage(response);
};
