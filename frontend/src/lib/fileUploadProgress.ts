import { getAttachmentUploadTimeoutMs } from "./uploadRequest";

/** Fetch adapter for authSession's existing 401 renewal, backed by real XHR events. */
export function fileUploadProgressFetch(onProgress: (loaded: number, total: number) => void, fileSize: number): typeof fetch {
  return (input, init) => new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const signal = init?.signal;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const fail = (message: string, code: string) => { cleanup(); reject(Object.assign(new Error(message), { code })); };
    const abort = () => xhr.abort();
    if (signal?.aborted) { reject(new DOMException("Upload cancelled", "AbortError")); return; }
    xhr.open(init?.method || "POST", String(input));
    xhr.timeout = getAttachmentUploadTimeoutMs(fileSize);
    new Headers(init?.headers).forEach((value, key) => xhr.setRequestHeader(key, value));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      cleanup();
      const headers = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const separator = line.indexOf(":");
        if (separator > 0) headers.append(line.slice(0, separator), line.slice(separator + 1).trim());
      }
      resolve(new Response(xhr.responseText || null, { status: xhr.status, headers }));
    };
    xhr.onerror = () => fail("Network connection failed", "NETWORK_ERROR");
    xhr.ontimeout = () => fail("Upload timed out", "UPLOAD_TIMEOUT");
    xhr.onabort = () => { cleanup(); reject(new DOMException("Upload cancelled", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(init?.body as FormData);
  });
}
