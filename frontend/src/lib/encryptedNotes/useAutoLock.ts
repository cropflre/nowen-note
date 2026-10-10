import { useEffect, useRef } from "react";
import { onEncryptedAutoLock } from "../desktopBridge";
import { onNativeEncryptedLifecycle } from "./nativeLifecycle";

export const ENCRYPTED_IDLE_LOCK_MS = 5 * 60 * 1000;
export type AutoLockReason = "idle" | "background";

/** Observe only while secrets are present; never persist activity or session state. */
export function useEncryptedAutoLock(active: boolean, onLock: (reason: AutoLockReason) => void) {
  const callback = useRef(onLock); callback.current = onLock;
  useEffect(() => {
    if (!active) return;
    let deadline = Date.now() + ENCRYPTED_IDLE_LOCK_MS;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const lock = (reason: AutoLockReason) => {
      if (stopped) return;
      stopped = true; clearTimeout(timer); callback.current(reason);
    };
    const check = () => {
      clearTimeout(timer);
      if (stopped) return;
      if (Date.now() >= deadline) lock("idle");
      else timer = setTimeout(check, deadline - Date.now());
    };
    const activity = () => {
      if (stopped) return;
      // A throttled/suspended timer must not be reset by the first returning input.
      if (Date.now() >= deadline) { lock("idle"); return; }
      deadline = Date.now() + ENCRYPTED_IDLE_LOCK_MS;
      clearTimeout(timer); timer = setTimeout(check, ENCRYPTED_IDLE_LOCK_MS);
    };
    const background = () => lock("background");
    const visibility = () => { if (document.visibilityState === "hidden") background(); else check(); };
    const events = ["pointerdown", "keydown", "input", "wheel"];
    timer = setTimeout(check, ENCRYPTED_IDLE_LOCK_MS);
    for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", background);
    window.addEventListener("blur", background);
    window.addEventListener("focus", check);
    const unsubscribeDesktop = onEncryptedAutoLock(background);
    const unsubscribeNative = onNativeEncryptedLifecycle(background, check);
    if (document.visibilityState === "hidden") background();
    return () => {
      stopped = true; clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, activity, true);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", background);
      window.removeEventListener("blur", background);
      window.removeEventListener("focus", check);
      unsubscribeDesktop();
      unsubscribeNative();
    };
  }, [active]);
}
