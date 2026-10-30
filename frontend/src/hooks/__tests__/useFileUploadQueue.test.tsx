import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { FileItem } from "@/types";
import { useFileUploadQueue } from "../useFileUploadQueue";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let queue: ReturnType<typeof useFileUploadQueue>;
let currentScope = true;
function Harness({ scope = "account-a" }: { scope?: string }) { queue = useFileUploadQueue(scope, () => undefined, () => currentScope); return null; }
function result(id: string): FileItem { return { id, filename: id, size: 1, mimeType: "text/plain", url: `/api/attachments/${id}`, hash: null, category: "file", folderId: null, folderName: null, createdAt: "2026-10-14", primaryNote: null }; }
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function mount() {
  currentScope = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<Harness />));
}

describe("real upload queue semantics", () => {
  it("limits 100 jobs to three active requests and continues after one failure", async () => {
    // HTTP LAN deployments and older WebViews can lack secure-context randomUUID.
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const pending: Array<{ resolve: (value: FileItem) => void; reject: (reason: Error) => void }> = [];
    const upload = vi.spyOn(api.files, "upload").mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    await mount();
    await act(async () => queue.enqueue(Array.from({ length: 100 }, (_, index) => new File([String(index)], `${index}.txt`)), "destination"));
    expect(upload).toHaveBeenCalledTimes(3);
    expect(queue.tasks.filter((task) => task.status === "waiting")).toHaveLength(97);
    await act(async () => pending[0].reject(new Error("Network failed")));
    expect(upload).toHaveBeenCalledTimes(4);
    expect(queue.tasks.filter((task) => task.status === "failed")).toHaveLength(1);
    expect(queue.tasks.filter((task) => task.status === "uploading")).toHaveLength(3);
    for (let index = 1; index < 100; index++) await act(async () => pending[index].resolve(result(String(index))));
    expect(queue.tasks.filter((task) => task.status === "success")).toHaveLength(99);
    await act(async () => queue.retry(queue.tasks[0].id));
    await act(async () => pending[100].resolve(result("retried")));
    expect(queue.tasks.filter((task) => task.status === "success")).toHaveLength(100);
  });
  it("uses only network event bytes for in-flight progress and retains duplicate status", async () => {
    let resolve!: (value: FileItem) => void;
    let progress!: (loaded: number, total: number) => void;
    vi.spyOn(api.files, "upload").mockImplementation((_file, options) => {
      progress = options!.onProgress!;
      return new Promise((done) => { resolve = done; });
    });
    await mount();
    await act(async () => queue.enqueue([new File(["test"], "image.txt")], "new-folder"));
    expect(queue.tasks[0].progress).toBeNull();
    await act(async () => progress(41, 100));
    expect(queue.tasks[0].progress).toBe(41);
    await act(async () => resolve({ ...result("existing"), deduplicated: true, folderId: "old-folder" }));
    expect(queue.tasks[0]).toMatchObject({ status: "existing", result: { folderId: "old-folder" } });
  });
  it("cancels waiting requests and aborts the old account on a scope switch", async () => {
    const signals: AbortSignal[] = [];
    const upload = vi.spyOn(api.files, "upload").mockImplementation((_file, options) => {
      signals.push(options!.signal!); return new Promise(() => undefined);
    });
    await mount();
    await act(async () => queue.enqueue(Array.from({ length: 4 }, (_, index) => new File(["x"], `${index}.txt`)), null));
    await act(async () => queue.cancel(queue.tasks[3].id));
    expect(upload).toHaveBeenCalledTimes(3);
    expect(queue.tasks[3].status).toBe("cancelled");
    currentScope = false;
    window.dispatchEvent(new Event("nowen:workspace-changed"));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(upload).toHaveBeenCalledTimes(3);
    await act(async () => root!.render(<Harness scope="account-b" />));
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(queue.tasks).toEqual([]);
  });
  it("starts waiting jobs after active cancellations settle asynchronously", async () => {
    const rejectRequests: Array<() => void> = [];
    const upload = vi.spyOn(api.files, "upload").mockImplementation((_file, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => {
        rejectRequests.push(() => reject(new DOMException("Cancelled", "AbortError")));
      });
    }));
    await mount();
    await act(async () => queue.enqueue(Array.from({ length: 6 }, (_, index) => new File(["x"], `${index}.txt`)), null));
    const activeIds = queue.tasks.slice(0, 3).map((task) => task.id);
    await act(async () => activeIds.forEach(queue.cancel));
    expect(upload).toHaveBeenCalledTimes(3);
    await act(async () => rejectRequests.forEach((reject) => reject()));
    expect(upload).toHaveBeenCalledTimes(6);
    expect(queue.tasks.filter((task) => task.status === "uploading")).toHaveLength(3);
  });
});
