import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ENCRYPTED_IDLE_LOCK_MS, useEncryptedAutoLock } from "../useAutoLock";

let root: Root;
let container: HTMLDivElement;
const lock = vi.fn();
function Session({ active = true, callback = lock }: { active?: boolean; callback?: typeof lock }) {
  useEncryptedAutoLock(active, callback); return null;
}
beforeEach(() => {
  vi.useFakeTimers(); lock.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("locks after five minutes and activity extends only a live session", () => {
  act(() => root.render(<Session />));
  act(() => vi.advanceTimersByTime(ENCRYPTED_IDLE_LOCK_MS - 1)); expect(lock).not.toHaveBeenCalled();
  act(() => window.dispatchEvent(new Event("input")));
  act(() => vi.advanceTimersByTime(ENCRYPTED_IDLE_LOCK_MS - 1)); expect(lock).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1)); expect(lock).toHaveBeenCalledTimes(1); expect(lock).toHaveBeenCalledWith("idle");
  act(() => window.dispatchEvent(new Event("input")));
  act(() => vi.advanceTimersByTime(ENCRYPTED_IDLE_LOCK_MS)); expect(lock).toHaveBeenCalledTimes(1);
});
it.each(["blur", "pagehide", "visibilitychange"])("locks immediately on %s, including idle timers suspended in the background", (event) => {
  act(() => root.render(<Session />));
  if (event === "visibilitychange") {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event(event)));
  } else act(() => window.dispatchEvent(new Event(event)));
  expect(lock).toHaveBeenCalledWith("background");
  act(() => vi.advanceTimersByTime(ENCRYPTED_IDLE_LOCK_MS)); expect(lock).toHaveBeenCalledTimes(1);
});
it("returning input cannot revive an expired session when timers were suspended", () => {
  act(() => root.render(<Session />)); vi.setSystemTime(Date.now() + ENCRYPTED_IDLE_LOCK_MS);
  act(() => window.dispatchEvent(new Event("keydown"))); expect(lock).toHaveBeenCalledWith("idle");
});
it("native desktop events lock once and remove the preload subscription when inactive", () => {
  let background!: () => void;
  const unsubscribe = vi.fn();
  const on = vi.fn((_channel: string, callback: () => void) => { background = callback; return unsubscribe; });
  Object.defineProperty(window, "nowenDesktop", { configurable: true, value: { on } });
  try {
    act(() => root.render(<Session />)); expect(on).toHaveBeenCalledWith("security:auto-lock", expect.any(Function));
    act(() => { background(); background(); }); expect(lock).toHaveBeenCalledTimes(1); expect(lock).toHaveBeenCalledWith("background");
    act(() => root.render(<Session active={false} />)); expect(unsubscribe).toHaveBeenCalledTimes(1);
  } finally { delete (window as any).nowenDesktop; }
});
it("rerenders use the current callback without resetting the deadline; inactive sessions remove observers", () => {
  act(() => root.render(<Session />)); act(() => vi.advanceTimersByTime(ENCRYPTED_IDLE_LOCK_MS - 1));
  const next = vi.fn(); act(() => root.render(<Session callback={next} />));
  act(() => vi.advanceTimersByTime(1)); expect(next).toHaveBeenCalledWith("idle"); expect(lock).not.toHaveBeenCalled();
  act(() => root.render(<Session active={false} />)); act(() => window.dispatchEvent(new Event("blur")));
  expect(vi.getTimerCount()).toBe(0); expect(lock).not.toHaveBeenCalled();
  act(() => root.render(<Session />)); act(() => window.dispatchEvent(new Event("pagehide")));
  expect(lock).toHaveBeenCalledWith("background");
});
