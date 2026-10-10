import type { EncryptedContentEnvelope, EncryptedContentErrorCode, EncryptedContentIdentity } from "./envelope";

export type SessionRequest = { id: number } & (
  | { operation: "open"; input: { envelope: unknown; expected: EncryptedContentIdentity; passphrase: string } }
  | { operation: "update"; input: { envelope: unknown; plaintext: string } }
  | { operation: "change-passphrase"; input: { envelope: unknown; passphrase: string; newPassphrase: string } }
);
export type SessionResponse = { id: number } & (
  | { ok: true; result: string | EncryptedContentEnvelope }
  | { ok: false; code: EncryptedContentErrorCode }
);
