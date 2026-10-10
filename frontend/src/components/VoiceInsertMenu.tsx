import { useState } from "react";
import { Paperclip, Mic } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function VoiceInsertMenu({ onUpload, onRecord, recordDisabled, iconSize = 16 }: { onUpload: () => void; onRecord: () => void; recordDisabled?: boolean; iconSize?: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <span className="relative inline-flex shrink-0" onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
    <button type="button" aria-label={t("tiptap.uploadAndInsertAttachment")} aria-expanded={open} className="flex h-8 w-8 items-center justify-center rounded-md text-tx-secondary hover:bg-app-hover" onClick={() => setOpen(!open)}><Paperclip size={iconSize} /></button>
    {open && <><button type="button" aria-label={t("voice.close")} className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} /><span role="menu" className="absolute left-0 top-full z-50 mt-1 min-w-44 rounded-xl border border-app-border bg-app-surface p-1 shadow-xl"><button role="menuitem" type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-app-hover" onClick={() => { setOpen(false); onUpload(); }}><Paperclip size={14} />{t("tiptap.uploadAndInsertAttachment")}</button><button role="menuitem" type="button" disabled={recordDisabled} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-app-hover disabled:opacity-50" onClick={() => { setOpen(false); onRecord(); }}><Mic size={14} />{t("voice.record")}</button></span></>}
  </span>;
}
