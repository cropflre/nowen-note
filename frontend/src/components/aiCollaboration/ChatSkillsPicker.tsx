import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { collaborationScope } from "@/lib/aiCollaboration";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import PersonalSkillsEditor, { type PersonalSkill } from "./PersonalSkillsEditor";

export default function ChatSkillsPicker({ scope, onSelect }: { scope: string; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const [items, setItems] = useState<PersonalSkill[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const alive = useRef(false);
  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const result = await api.aiPrompts.list();
      if (alive.current && collaborationScope() === scope) setItems(result.items);
    } catch (cause) {
      if (alive.current && collaborationScope() === scope) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current && collaborationScope() === scope) setLoading(false);
    }
  }, [scope]);
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [load]);
  useEffect(() => {
    if (!open) return;
    const opener = trigger.current;
    dialog.current?.focus();
    const unregister = registerMobileBackHandler("modal", () => { setOpen(false); return true; });
    return () => { unregister(); if (opener?.isConnected) opener.focus(); };
  }, [open]);
  const change = (id: string) => {
    if (collaborationScope() !== scope) return;
    setSelected(id); onSelect(id);
  };
  return <><div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-xs">
    <label className="flex min-w-0 flex-1 items-center gap-2 text-tx-secondary">
      <span className="shrink-0">{t("aiCollaboration.chatSkill")}</span>
      <select aria-label={t("aiCollaboration.chatSkill")} value={selected} disabled={loading || !!error}
        onChange={event => change(event.target.value)} className="w-40 min-w-0 max-w-48 flex-1 rounded-lg border border-app-border bg-app-bg px-2 py-1 text-tx-primary">
        <option value="">{t("aiCollaboration.noChatSkill")}</option>
        {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <button ref={trigger} type="button" disabled={loading || !!error} onClick={() => setOpen(true)}
      aria-haspopup="dialog" aria-expanded={open} className="shrink-0 rounded-lg px-2 py-1 text-accent-primary hover:bg-accent-primary/10 disabled:opacity-40">{t("aiCollaboration.manageChatSkills")}</button>
    {loading && <span role="status">{t("common.loading")}</span>}
    {error && <div role="alert" className="break-words text-red-500">{error} <button onClick={() => void load()} className="underline">{t("aiCollaboration.retrySkills")}</button></div>}
  </div>
    {!loading && !error && createPortal(<div hidden={!open} className={`${open ? "flex" : "hidden"} fixed inset-0 z-[120] items-center justify-center bg-black/40 p-4`} onMouseDown={event => {
      if (event.target === event.currentTarget) setOpen(false);
    }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("aiCollaboration.manageSkills")} tabIndex={-1}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-app-border bg-app-surface text-tx-primary shadow-xl outline-none" onKeyDown={event => {
          if (event.key === "Escape") { event.stopPropagation(); setOpen(false); }
          if (event.key !== "Tab") return;
          const controls = dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)");
          const first = controls?.[0]; const last = controls?.[controls.length - 1];
          if (!first || !last) return;
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
        }}>
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-app-border px-5 py-4">
          <h2 className="text-sm font-semibold">{t("aiCollaboration.manageSkills")}</h2>
          <button type="button" aria-label={t("common.close")} onClick={() => setOpen(false)} className="shrink-0 rounded-lg p-1 text-tx-tertiary hover:bg-app-hover"><X size={18} /></button>
        </header>
        <div className="min-h-0 space-y-3 overflow-y-auto p-5">
          <p className="text-xs text-tx-tertiary">{t("aiCollaboration.chatSkillHint")}</p>
          <PersonalSkillsEditor embedded scope={scope} items={items} onChanged={next => {
            if (!alive.current || collaborationScope() !== scope) return;
            setItems(next);
            if (selected && !next.some(item => item.id === selected)) change("");
          }} />
        </div>
      </div>
    </div>, document.body)}
  </>;
}
