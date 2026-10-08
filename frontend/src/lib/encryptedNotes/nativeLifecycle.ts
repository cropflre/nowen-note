import { Capacitor, registerPlugin } from "@capacitor/core";
import { EncryptedContentError } from "./envelope";

const windowGuard = registerPlugin<{ acquire(options: { token: string }): Promise<void>; release(options: { token: string }): Promise<void> }>("EncryptedContentGuard");

/** Await this lease before making decrypted content visible on Android. */
export async function acquireNativeEncryptedWindow(): Promise<() => Promise<void>> {
  if (Capacitor.getPlatform() !== "android") return async () => {};
  const token = crypto.randomUUID();
  try { await windowGuard.acquire({ token }); } catch { throw new EncryptedContentError("unavailable"); }
  let released = false;
  return async () => {
    if (released) return;
    await windowGuard.release({ token }); released = true;
  };
}

/** Subscription disposal also handles an asynchronous addListener/getState racing unmount. */
export function onNativeEncryptedLifecycle(background: () => void, foreground: () => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};
  let disposed = false;
  let remove: (() => Promise<void>) | undefined;
  void (async () => {
    const { App } = await import("@capacitor/app");
    if (disposed) return;
    const listener = await App.addListener("appStateChange", ({ isActive }) => {
      if (!disposed) { if (isActive) foreground(); else background(); }
    });
    if (disposed) { await listener.remove(); return; }
    remove = () => listener.remove();
    const state = await App.getState();
    if (!disposed) { if (state.isActive) foreground(); else background(); }
  })().catch(() => { if (!disposed) background(); });
  return () => { disposed = true; void remove?.().catch(() => {}); };
}
