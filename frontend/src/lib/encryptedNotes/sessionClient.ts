import type { EncryptedContentEnvelope, EncryptedContentIdentity } from "./envelope";
import { SessionTransport } from "./sessionTransport";

/** Only the Worker holds a key. Closing or aborting destroys the entire session. */
export class EncryptedContentSession {
  private readonly transport = new SessionTransport(() => new Worker(new URL("./session.worker.ts", import.meta.url), { type: "module", name: "nowen-encrypted-session" }));
  async open(envelope: EncryptedContentEnvelope, passphrase: string, expected: EncryptedContentIdentity, signal?: AbortSignal): Promise<string> {
    try { return await this.transport.call({ operation: "open", input: { envelope, passphrase, expected } }, { signal, kdf: true }) as string; }
    catch (error) { this.close(); throw error; }
  }
  update(envelope: EncryptedContentEnvelope, plaintext: string, signal?: AbortSignal): Promise<EncryptedContentEnvelope> {
    return this.transport.call({ operation: "update", input: { envelope, plaintext } }, { signal }) as Promise<EncryptedContentEnvelope>;
  }
  changePassphrase(envelope: EncryptedContentEnvelope, passphrase: string, newPassphrase: string, signal?: AbortSignal): Promise<EncryptedContentEnvelope> {
    return this.transport.call({ operation: "change-passphrase", input: { envelope, passphrase, newPassphrase } }, { signal, kdf: true }) as Promise<EncryptedContentEnvelope>;
  }
  close(code: "aborted" | "unavailable" = "aborted") { this.transport.close(code); }
}
