import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";

export default function AIChatMobileSettings({ open, onClose, trigger, children }: {
  open: boolean; onClose: () => void; trigger: RefObject<HTMLButtonElement | null>; children: ReactNode;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const opener = trigger.current;
    dialog.current?.focus();
    const unregister = registerMobileBackHandler("modal", () => { close.current(); return true; });
    return () => { unregister(); if (opener?.isConnected) opener.focus(); };
  }, [open, trigger]);
  return createPortal(<div hidden={!open} className={`${open ? "flex" : "hidden"} fixed inset-0 z-[110] items-end justify-center bg-black/40 p-3`} onMouseDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("aiCollaboration.chatSettings")} tabIndex={-1}
      className="flex max-h-[85dvh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface text-tx-primary shadow-xl outline-none" onKeyDown={event => {
        if (!event.currentTarget.contains(event.target as Node)) return;
        if (event.key === "Escape") { event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)");
        const first = controls?.[0], last = controls?.[controls.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
      }}>
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-app-border px-4 py-3">
        <h2 className="text-sm font-semibold">{t("aiCollaboration.chatSettings")}</h2>
        <button type="button" aria-label={t("common.close")} onClick={onClose} className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover"><X size={18} /></button>
      </header>
      <div className="min-h-0 space-y-3 overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
    </div>
  </div>, document.body);
}
