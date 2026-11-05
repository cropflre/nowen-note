import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { OPEN_AI_MEMORY } from "@/lib/aiMemory";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
const Hub = lazy(() => import("./AIMemoryHub"));
function Dialog({ scope, tab, close }: { scope: string; tab: "archive" | "memories" | "connections"; close: () => void }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    element.current?.focus();
    const unregister = registerMobileBackHandler("modal", () => { close(); return true; });
    return () => { unregister(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-0 sm:p-4" data-swipe-blocker="ai-memory">
    <div ref={element} tabIndex={-1} role="dialog" aria-modal="true" aria-label="AI Memory Hub" className="flex h-[100dvh] min-h-0 w-full max-w-4xl flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text-primary)] shadow-xl outline-none sm:h-[min(90dvh,900px)] sm:rounded-2xl sm:border sm:border-[var(--color-border)]" onKeyDown={event => {
      if (event.key === "Escape") { event.stopPropagation(); close(); }
      if (event.key !== "Tab") return;
      const focusable = [...(element.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),summary,a[href],[tabindex="0"]') || [])].filter(item => item.getClientRects().length > 0);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === element.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element.current)) { event.preventDefault(); first.focus(); }
    }}><Suspense fallback={null}><Hub scope={scope} initialTab={tab} onClose={close}/></Suspense></div>
  </div>;
}
export default function AIMemoryCenter() {
  const [dialog, setDialog] = useState<{ scope: string; tab: "archive" | "memories" | "connections" } | null>(null);
  useEffect(() => {
    const open = (event: Event) => { const tab = (event as CustomEvent).detail?.tab; setDialog({ scope: getOfflineQueueStorageKey(), tab: ["archive", "memories", "connections"].includes(tab) ? tab : "archive" }); };
    const changed = () => setDialog(previous => previous?.scope === getOfflineQueueStorageKey() ? previous : null);
    const events = ["nowen:token-changed", "nowen:server-url-changed", "storage"];
    window.addEventListener(OPEN_AI_MEMORY, open); events.forEach(event => window.addEventListener(event, changed));
    return () => { window.removeEventListener(OPEN_AI_MEMORY, open); events.forEach(event => window.removeEventListener(event, changed)); };
  }, []);
  return dialog ? createPortal(<Dialog key={`${dialog.scope}:${dialog.tab}`} scope={dialog.scope} tab={dialog.tab} close={() => setDialog(null)}/>, document.body) : null;
}
