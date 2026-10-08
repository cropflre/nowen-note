import { EncryptedContentError, type EncryptedContentEnvelope } from "./envelope";
import type { CryptoRequest, CryptoResponse } from "./protocol";

let busy = false;
export function runEncryptedContentOperation(request: CryptoRequest & { operation: "decrypt" }, signal?: AbortSignal): Promise<string>;
export function runEncryptedContentOperation(request: CryptoRequest & { operation: "create" | "update" | "change-passphrase" }, signal?: AbortSignal): Promise<EncryptedContentEnvelope>;
export function runEncryptedContentOperation(request: CryptoRequest, signal?: AbortSignal): Promise<EncryptedContentEnvelope | string> {
  if (signal?.aborted) return Promise.reject(new EncryptedContentError("aborted"));
  if (busy) return Promise.reject(new EncryptedContentError("busy"));
  if (typeof Worker === "undefined" || !globalThis.crypto?.subtle) return Promise.reject(new EncryptedContentError("unavailable"));
  busy = true;
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (result?: CryptoResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      if (worker) { worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null; worker.terminate(); }
      busy = false;
      if (result?.ok) resolve(result.result);
      else reject(new EncryptedContentError(result?.code ?? "unavailable"));
    };
    const abort = () => finish({ ok: false, code: "aborted" });
    const timeout = setTimeout(() => finish(), 30_000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      // A fresh worker per operation releases WASM memory and secret copies after every result.
      worker = new Worker(new URL("./crypto.worker.ts", import.meta.url), { type: "module", name: "nowen-encrypted-content" });
      worker.onmessage = (event: MessageEvent<CryptoResponse>) => finish(event.data);
      worker.onerror = (event) => { event.preventDefault(); finish(); };
      worker.onmessageerror = () => finish();
      worker.postMessage(request);
    } catch { finish(); }
  });
}
