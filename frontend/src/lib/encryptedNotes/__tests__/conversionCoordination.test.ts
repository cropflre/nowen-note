import { afterEach, expect, it, vi } from "vitest";
import { CONVERSION_REPLAY_LOCK, conversionLockName, holdConversionEditorLease, withConversionCleanupLease } from "../conversionCoordination";

// Model lock release/queued acquisition, including the old ifAvailable failure.
function locksInitiallyHeld(...names: string[]) {
  const held = new Set(names);
  const queued = new Map<string, Array<() => void>>();
  const release = (name: string) => { held.delete(name); queued.get(name)?.shift()?.(); };
  const request = vi.fn((name: string, options: LockOptions, callback: LockGrantedCallback) => new Promise((resolve, reject) => {
    const abort = () => {
      const waiting = queued.get(name); const index = waiting?.indexOf(grant) ?? -1;
      if (index >= 0) waiting!.splice(index, 1);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const grant = () => {
      options.signal?.removeEventListener("abort", abort);
      held.add(name);
      Promise.resolve().then(() => callback({ name, mode: options.mode ?? "exclusive" })).then(resolve, reject).finally(() => release(name));
    };
    if (options.signal?.aborted) { abort(); return; }
    if (!held.has(name)) { grant(); return; }
    if (options.ifAvailable) { Promise.resolve(callback(null)).then(resolve, reject); return; }
    queued.set(name, [...(queued.get(name) ?? []), grant]);
    options.signal?.addEventListener("abort", abort, { once: true });
  }));
  vi.stubGlobal("navigator", { locks: { request } });
  return { release, request };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("waits for a background replay/cache writer to finish before conversion", async () => {
  const locks = locksInitiallyHeld(CONVERSION_REPLAY_LOCK); const convert = vi.fn();
  const pending = withConversionCleanupLease("note", convert);
  const completed = expect(pending).resolves.toBeUndefined();
  await vi.waitFor(() => expect(locks.request).toHaveBeenCalledTimes(2));
  expect(convert).not.toHaveBeenCalled();
  locks.release(CONVERSION_REPLAY_LOCK);
  await completed; expect(convert).toHaveBeenCalledTimes(1);
});

it("waits for this editor's asynchronous lock release after unmount", async () => {
  locksInitiallyHeld(); const ready = vi.fn(); const convert = vi.fn();
  const release = holdConversionEditorLease("note", ready, vi.fn());
  await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
  release();
  await expect(withConversionCleanupLease("note", convert)).resolves.toBeUndefined();
  expect(convert).toHaveBeenCalledTimes(1);
});

it("still refuses an editor that remains open in another window without running conversion", async () => {
  vi.useFakeTimers(); locksInitiallyHeld(conversionLockName("note")); const convert = vi.fn();
  const pending = withConversionCleanupLease("note", convert);
  const rejected = expect(pending).rejects.toMatchObject({ code: "busy" });
  await vi.advanceTimersByTimeAsync(5_000); await rejected;
  expect(convert).not.toHaveBeenCalled();
});

it("cancels a queued acquisition and never converts after the blocker later releases", async () => {
  const locks = locksInitiallyHeld(conversionLockName("note")); const convert = vi.fn(); const controller = new AbortController();
  const pending = withConversionCleanupLease("note", convert, controller.signal);
  const rejected = expect(pending).rejects.toMatchObject({ code: "scope_changed" });
  controller.abort(); await rejected;
  locks.release(conversionLockName("note"));
  await withConversionCleanupLease("note", async () => {});
  expect(convert).not.toHaveBeenCalled();
});
