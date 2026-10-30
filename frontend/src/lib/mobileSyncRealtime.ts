import { realtime } from "./realtime";
import { isMobileSyncEnabled } from "./mobileSyncStatus";
import type { MobileSyncEngine } from "./mobileSyncEngine";

/** One notification transport; durable data always comes from Sync V2 Pull. */
export function installMobileSyncRealtime(engine: MobileSyncEngine): () => void {
  const wake = () => { if (isMobileSyncEnabled()) engine.requestSync(150); };
  const removeNotice = realtime.on("sync.changed", wake);
  const removeOpen = realtime.on("open", wake);
  const onVisible = () => { if (document.visibilityState === "visible") wake(); };
  document.addEventListener("visibilitychange", onVisible);
  const poll = setInterval(onVisible, 30_000);
  if (isMobileSyncEnabled()) realtime.connect();
  return () => {
    clearInterval(poll);
    removeNotice(); removeOpen();
    document.removeEventListener("visibilitychange", onVisible);
  };
}
