import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Paperclip, Mic } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function VoiceInsertMenu({ onUpload, onRecord, recordDisabled, iconSize = 16 }: { onUpload: () => void; onRecord: () => void; recordDisabled?: boolean; iconSize?: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const below = anchor.bottom + 4;
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - menu.width - 8)),
      top: Math.max(8, Math.min(
        below + menu.height <= window.innerHeight - 8 ? below : anchor.top - menu.height - 4,
        window.innerHeight - menu.height - 8,
      )),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (menuRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        triggerRef.current?.focus();
      }
    };
    const closeOnOutsideScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      close();
    };
    window.addEventListener("pointerdown", closeOutside, true);
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", closeOnOutsideScroll, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, true);
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnOutsideScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return <span className="relative inline-flex shrink-0">
    <button ref={triggerRef} type="button" aria-label={t("tiptap.uploadAndInsertAttachment")} aria-haspopup="menu" aria-expanded={open} className="flex h-8 w-8 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover" onClick={() => setOpen(!open)}><Paperclip size={iconSize} /></button>
    {open && createPortal(<span ref={menuRef} role="menu" style={position} className="fixed z-[320] w-44 max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto rounded-xl border border-app-border bg-app-surface p-1 shadow-xl"><button role="menuitem" type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-app-hover" onClick={() => { setOpen(false); onUpload(); }}><Paperclip size={14} />{t("tiptap.uploadAndInsertAttachment")}</button><button role="menuitem" type="button" disabled={recordDisabled} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-app-hover disabled:opacity-50" onClick={() => { setOpen(false); onRecord(); }}><Mic size={14} />{t("voice.record")}</button></span>, document.body)}
  </span>;
}
