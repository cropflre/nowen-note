import type { EncryptedContentEnvelope, EncryptedContentErrorCode, EncryptedContentIdentity } from "./envelope";

type ExistingInput = { envelope: unknown; passphrase: string; expected: EncryptedContentIdentity };
export type CryptoRequest =
  | { operation: "create"; input: { plaintext: string; passphrase: string; kind: EncryptedContentIdentity["kind"]; originalFormat: EncryptedContentIdentity["originalFormat"] } }
  | { operation: "decrypt"; input: ExistingInput }
  | { operation: "update"; input: ExistingInput & { plaintext: string } }
  | { operation: "change-passphrase"; input: ExistingInput & { newPassphrase: string } };
export type CryptoResponse = { ok: true; result: EncryptedContentEnvelope | string } | { ok: false; code: EncryptedContentErrorCode };
