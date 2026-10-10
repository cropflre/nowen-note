import { EncryptedContentError, type EncryptedContentErrorCode } from "./envelope";
import { acquireKdfSlot } from "./kdfGate";

type Result = { id: number; ok: true; result: unknown } | { id: number; ok: false; code: EncryptedContentErrorCode };
/** Single-operation transport shared by v1 and v2; secrets only live in the target Worker. */
export class SessionTransport {
  private readonly worker: Worker;
  private closed = false;
  private nextId = 0;
  private pending?: { id: number; controller: AbortController; finish: (response: Result) => void; touch: () => void;
    io?: (value: unknown, signal: AbortSignal) => Promise<unknown>; handlingIo: boolean };
  constructor(createWorker: () => Worker) {
    if (typeof Worker === "undefined" || !globalThis.crypto?.subtle) throw new EncryptedContentError("unavailable");
    try { this.worker = createWorker(); }
    catch { throw new EncryptedContentError("unavailable"); }
    this.worker.onmessage = (event: MessageEvent) => { void this.receive(event.data); };
    this.worker.onerror = (event) => { event.preventDefault(); this.close("unavailable"); };
    this.worker.onmessageerror = () => this.close("unavailable");
  }
  private async receive(value: Result | { id: number; ioId: number; io: unknown }) {
    const pending = this.pending;
    if (!pending || value?.id !== pending.id) { this.close("unavailable"); return; }
    if ("ioId" in value) {
      if (!pending.io || pending.handlingIo || !Number.isSafeInteger(value.ioId) || value.ioId < 1) { this.close("unavailable"); return; }
      pending.handlingIo = true; pending.touch();
      try {
        const result = await pending.io(value.io, pending.controller.signal);
        if (this.pending === pending && !pending.controller.signal.aborted) { pending.touch(); this.respond({ id: pending.id, ioId: value.ioId, ok: true, result }); }
      } catch {
        if (this.pending === pending && !pending.controller.signal.aborted) this.respond({ id: pending.id, ioId: value.ioId, ok: false });
      } finally { pending.handlingIo = false; }
      return;
    }
    if (pending.handlingIo || (value.ok !== true && value.ok !== false)) { this.close("unavailable"); return; }
    pending.finish(value);
  }
  private respond(value: unknown) { try { this.worker.postMessage(value); } catch { this.close("unavailable"); } }
  close(code: "aborted" | "unavailable" = "aborted") {
    if (this.closed) return;
    this.closed = true; this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null; this.worker.terminate();
    this.pending?.controller.abort(); this.pending?.finish({ id: this.pending.id, ok: false, code });
  }
  call(request: { operation: string; input: unknown }, options: {
    signal?: AbortSignal; kdf?: boolean; io?: (value: unknown, signal: AbortSignal) => Promise<unknown>;
  } = {}): Promise<unknown> {
    if (this.closed || options.signal?.aborted) return Promise.reject(new EncryptedContentError("aborted"));
    if (this.pending) return Promise.reject(new EncryptedContentError("busy"));
    let release: (() => void) | undefined;
    try { if (options.kdf) release = acquireKdfSlot(); } catch (error) { return Promise.reject(error); }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const abort = () => this.close(); let timer: ReturnType<typeof setTimeout>;
      const touch = () => { clearTimeout(timer); timer = setTimeout(() => this.close("unavailable"), 30_000); };
      this.pending = { id, controller: new AbortController(), handlingIo: false, touch, io: options.io, finish: (response) => {
        clearTimeout(timer); options.signal?.removeEventListener("abort", abort); release?.(); this.pending = undefined;
        if (response.ok) resolve(response.result); else reject(new EncryptedContentError(response.code));
      } };
      touch(); options.signal?.addEventListener("abort", abort, { once: true });
      try { this.worker.postMessage({ ...request, id }); } catch { this.close("unavailable"); }
    });
  }
}
