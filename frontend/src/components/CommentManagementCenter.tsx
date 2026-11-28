import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAppDateTime } from "@/lib/dateTime";
import { api, SERVER_URL_CHANGED_EVENT } from "@/lib/api";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import { useVisibleViewport } from "@/hooks/useVisibleViewport";
import { confirm } from "@/components/ui/confirm";
import { COMMENTS_CHANGED_EVENT, OPEN_COMMENT_CENTER_EVENT } from "@/lib/noteCommentNavigation";
import { NOTIFICATIONS_CHANGED_EVENT } from "@/lib/workspaceIssueNavigation";
import type { ManagedNoteComment, NoteCommentListResponse } from "@/types";

const buttonClass = "rounded-xl border border-app-border/85 bg-app-surface/85 px-3 py-2 text-xs font-medium text-tx-primary shadow-xs transition-all hover:border-indigo-400/40 hover:bg-app-hover active:scale-[0.98] disabled:opacity-50";
const PAGE_SIZE = 30;

export default function CommentManagementCenter({ onOpenComment }: { onOpenComment: (noteId: string, commentId: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("unresolved");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<NoteCommentListResponse>({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const viewport = useVisibleViewport(open);

  useEffect(() => {
    const show = () => { if (!isMobileLocalMode()) setOpen(true); };
    const reset = () => {
      epoch.current += 1; setOpen(false); setData({ items: [], total: 0 });
      setSearch(""); setQuery(""); setPage(0); setError(""); setLoading(false);
    };
    window.addEventListener(OPEN_COMMENT_CENTER_EVENT, show);
    window.addEventListener("nowen:token-changed", reset);
    window.addEventListener(SERVER_URL_CHANGED_EVENT, reset);
    return () => {
      epoch.current += 1;
      window.removeEventListener(OPEN_COMMENT_CENTER_EVENT, show);
      window.removeEventListener("nowen:token-changed", reset);
      window.removeEventListener(SERVER_URL_CHANGED_EVENT, reset);
    };
  }, []);

  useEffect(() => {
    const current = ++epoch.current;
    if (!open || isMobileLocalMode()) return;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true; setLoading(true);
      try {
        const result = await api.getManagedNoteComments(status, query, page * PAGE_SIZE, PAGE_SIZE);
        if (current !== epoch.current) return;
        if (!result.items.length && page > 0 && result.total <= page * PAGE_SIZE) setPage(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1));
        else setData(result);
        setError("");
      } catch (failure) { if (current === epoch.current) setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { inFlight = false; if (current === epoch.current) setLoading(false); }
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 45000);
    window.addEventListener("focus", load);
    window.addEventListener(COMMENTS_CHANGED_EVENT, load);
    return () => { epoch.current += 1; clearInterval(timer); window.removeEventListener("focus", load); window.removeEventListener(COMMENTS_CHANGED_EVENT, load); };
  }, [open, status, query, page, revision]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (!dialog.current?.contains(document.activeElement)) return;
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key !== "Tab") return;
      const elements = dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input, select");
      const first = elements[0]; const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [open]);

  const run = async (operation: (isCurrent: () => boolean) => Promise<boolean | void>, changed = true) => {
    const current = epoch.current;
    const isCurrent = () => current === epoch.current;
    setLoading(true); setError("");
    try {
      const result = await operation(isCurrent);
      if (!isCurrent() || result === false) return;
      if (changed) {
        setRevision((value) => value + 1);
        window.dispatchEvent(new Event(COMMENTS_CHANGED_EVENT));
        window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
      } else setOpen(false);
    } catch (failure) { if (isCurrent()) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (isCurrent()) setLoading(false); }
  };
  const remove = (item: ManagedNoteComment) => void run(async (isCurrent) => {
    if (!await confirm({ title: t("commentCenter.confirmDelete"), danger: true }) || !isCurrent()) return false;
    await api.deleteNoteComment(item.noteId, item.id);
  });

  if (!open) return null;
  return createPortal(<div className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-xs" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("commentCenter.title")} className="absolute right-0 flex w-full max-w-2xl flex-col overflow-hidden border-l border-app-border/80 bg-app-bg/95 text-tx-primary shadow-2xl backdrop-blur-2xl" style={{ top: viewport.top, height: viewport.height }}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-indigo-500/70 via-violet-500/70 to-sky-400/70" />
      <header className="flex shrink-0 items-center gap-2 border-b border-app-border/75 bg-app-surface/80 p-4 pt-[max(16px,env(safe-area-inset-top))] backdrop-blur-md">
        <div className="mr-auto"><h2 className="text-base font-semibold tracking-tight">{t("commentCenter.title")}</h2><p className="mt-0.5 text-xs text-tx-secondary">{t("commentCenter.description")}</p></div>
        <button ref={close} className={buttonClass} aria-label={t("commentCenter.close")} onClick={() => setOpen(false)}><X size={16} /></button>
      </header>
      <form className="flex shrink-0 flex-wrap gap-2 border-b border-app-border/75 bg-app-surface/55 p-3 backdrop-blur-sm" onSubmit={(event) => { event.preventDefault(); setPage(0); setQuery(search.trim()); }}>
        <select aria-label={t("commentCenter.status")} value={status} onChange={(event) => { setStatus(event.target.value); setPage(0); }} className={buttonClass}>
          {["all", "unresolved", "resolved"].map((value) => <option key={value} value={value}>{t(`commentCenter.${value}`)}</option>)}
        </select>
        <input className="min-w-0 flex-1 rounded-xl border border-app-border/85 bg-app-bg/90 px-3 py-2 text-sm outline-none transition-all focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20" maxLength={200} aria-label={t("commentCenter.search")} placeholder={t("commentCenter.search")} value={search} onChange={(event) => setSearch(event.target.value)} />
        <button type="submit" className={buttonClass} disabled={loading}>{t("commentCenter.searchButton")}</button>
        <button type="button" className={buttonClass} disabled={loading} onClick={() => setRevision((value) => value + 1)}>{t("issues.refresh")}</button>
      </form>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3.5">
        {error && <p role="alert" className="rounded-2xl border border-red-500/25 bg-red-500/8 p-3 text-sm text-accent-danger">{error}</p>}
        {loading && <p role="status" className="text-sm text-tx-secondary">{t("issues.loading")}</p>}
        {!loading && !error && !data.items.length && <p className="rounded-2xl border border-dashed border-app-border/80 bg-app-surface/55 py-10 text-center text-sm text-tx-tertiary">{t("commentCenter.empty")}</p>}
        {data.items.map((item) => <article key={item.id} className="space-y-2.5 rounded-2xl border border-app-border/80 bg-app-surface/85 p-4 shadow-sm backdrop-blur-md transition-all hover:border-indigo-500/30 hover:shadow-md">
          <div className="flex items-start justify-between gap-2">
            <h3 className="break-words text-sm font-semibold">{item.noteTitle}</h3>
            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${item.isResolved ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-amber-500/12 text-amber-700 dark:text-amber-300"}`}>{t(item.isResolved ? "commentCenter.resolved" : "commentCenter.unresolved")}</span>
          </div>
          <p className="text-xs tabular-nums text-tx-tertiary">{item.displayName || item.username || t("issues.unknown")} · {formatAppDateTime(item.createdAt)}{item.isGuest ? ` · ${t("commentCenter.guest")}` : ""}{item.parentId ? ` · ${t("issues.reply")}` : ""}</p>
          <p className="whitespace-pre-wrap break-words rounded-xl border border-app-border/60 bg-app-bg/60 px-3 py-2.5 text-sm leading-relaxed">{item.content}</p>
          <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
            <button className={buttonClass} disabled={loading} onClick={() => void run(() => onOpenComment(item.noteId, item.id), false)}>{t("commentCenter.open")}</button>
            <button className={buttonClass} disabled={loading} onClick={() => void run(async () => { await api.toggleCommentResolved(item.noteId, item.id); })}>{t(item.isResolved ? "commentCenter.reopen" : "commentCenter.resolve")}</button>
            <button className={`${buttonClass} border-red-300/60 bg-red-500/[0.05] text-accent-danger hover:bg-red-500/10`} disabled={loading} onClick={() => remove(item)}>{t("issues.delete")}</button>
          </div>
        </article>)}
      </div>
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-app-border/75 bg-app-surface/80 p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-md">
        <span className="text-xs tabular-nums text-tx-secondary">{t("commentCenter.total", { count: data.total })}</span>
        <div className="flex gap-2"><button className={buttonClass} disabled={loading || page === 0} onClick={() => setPage((value) => value - 1)}>{t("commentCenter.previous")}</button><button className={buttonClass} disabled={loading || (page + 1) * PAGE_SIZE >= data.total} onClick={() => setPage((value) => value + 1)}>{t("commentCenter.next")}</button></div>
      </footer>
    </div>
  </div>, document.body);
}
