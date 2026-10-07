import { EncryptedContentError, type EncryptedContentEnvelope, type EncryptedContentIdentity } from "./envelope";
import { acquireKdfSlot } from "./kdfGate";
import type { SessionRequest, SessionResponse } from "./sessionProtocol";

type SessionInput = SessionRequest extends infer R ? R extends SessionRequest ? Omit<R, "id"> : never : never;

/** Only the Worker holds a key. Closing or aborting destroys the entire session. */
export class EncryptedContentSession {
  private readonly worker: Worker;
  private closed = false;
  private nextId = 0;
  private pending?: { id: number; finish: (response: SessionResponse) => void };

  constructor() {
    if (typeof Worker === "undefined" || !globalThis.crypto?.subtle) throw new EncryptedContentError("unavailable");
    try { this.worker = new Worker(new URL("./session.worker.ts", import.meta.url), { type: "module", name: "nowen-encrypted-session" }); }
    catch { throw new EncryptedContentError("unavailable"); }
    this.worker.onmessage = (event: MessageEvent<SessionResponse>) => {
      if (!this.pending || event.data?.id !== this.pending.id) { this.close("unavailable"); return; }
      this.pending.finish(event.data);
    };
    this.worker.onerror = (event) => { event.preventDefault(); this.close("unavailable"); };
    this.worker.onmessageerror = () => this.close("unavailable");
  }

  async open(envelope: EncryptedContentEnvelope, passphrase: string, expected: EncryptedContentIdentity, signal?: AbortSignal): Promise<string> {
    try { return await this.call({ operation: "open", input: { envelope, passphrase, expected } }, signal, true) as string; }
    catch (error) { this.close(); throw error; }
  }

  update(envelope: EncryptedContentEnvelope, plaintext: string, signal?: AbortSignal): Promise<EncryptedContentEnvelope> {
    return this.call({ operation: "update", input: { envelope, plaintext } }, signal) as Promise<EncryptedContentEnvelope>;
  }

  changePassphrase(envelope: EncryptedContentEnvelope, passphrase: string, newPassphrase: string, signal?: AbortSignal): Promise<EncryptedContentEnvelope> {
    return this.call({ operation: "change-passphrase", input: { envelope, passphrase, newPassphrase } }, signal, true) as Promise<EncryptedContentEnvelope>;
  }

  close(code: "aborted" | "unavailable" = "aborted") {
    if (this.closed) return;
    this.closed = true;
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
    this.worker.terminate();
    this.pending?.finish({ id: this.pending.id, ok: false, code });
  }

  private call(request: SessionInput, signal?: AbortSignal, kdf = false): Promise<string | EncryptedContentEnvelope> {
    if (this.closed || signal?.aborted) return Promise.reject(new EncryptedContentError("aborted"));
    if (this.pending) return Promise.reject(new EncryptedContentError("busy"));
    let release: (() => void) | undefined;
    try { if (kdf) release = acquireKdfSlot(); } catch (error) { return Promise.reject(error); }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => this.close();
      const timer = setTimeout(() => this.close("unavailable"), 30_000);
      this.pending = { id, finish: (response) => {
        clearTimeout(timer); signal?.removeEventListener("abort", abort); release?.(); this.pending = undefined;
        if (response.ok) resolve(response.result); else reject(new EncryptedContentError(response.code));
      } };
      signal?.addEventListener("abort", abort, { once: true });
      try { this.worker.postMessage({ ...request, id }); } catch { this.close("unavailable"); }
    });
  }
}
