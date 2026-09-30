import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, SERVER_URL_CHANGED_EVENT } from "@/lib/api";
import { openCommentCenter } from "@/lib/noteCommentNavigation";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import { useVisibleViewport } from "@/hooks/useVisibleViewport";
import { NOTIFICATIONS_CHANGED_EVENT, OPEN_NOTIFICATIONS_EVENT } from "@/lib/workspaceIssueNavigation";
import type { NotificationListResponse, WorkspaceNotification } from "@/types/workspaceIssues";

const buttonClass = "rounded-lg border border-app-border px-3 py-1.5 text-sm hover:bg-app-hover disabled:opacity-50";

export default function NotificationCenter({ onUnreadChange, onOpenIssue, onOpenComment }: {
  onUnreadChange: (count: number) => void;
  onOpenIssue: (issueId: string, workspaceId: string) => void;
  onOpenComment?: (noteId: string, commentId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [data, setData] = useState<NotificationListResponse>({ items: [], total: 0, unreadCount: 0 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const paging = useRef(false);
  const dataRef = useRef(data);
  dataRef.current = data;
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const viewport = useVisibleViewport(open);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_NOTIFICATIONS_EVENT, show);
    return () => window.removeEventListener(OPEN_NOTIFICATIONS_EVENT, show);
  }, []);

  useEffect(() => {
    const current = ++epoch.current;
    let inFlight = false;
    const load = async (refreshList: boolean | Event = true) => {
      if (isMobileLocalMode() || inFlight || paging.current) return;
      inFlight = true;
      const countOnly = !open || (refreshList === false && dataRef.current.items.length > 30);
      if (!countOnly) setLoading(true);
      try {
        const result = await api.notifications.list(unreadOnly, 0, countOnly ? 1 : 30);
        if (epoch.current !== current) return;
        onUnreadChange(result.unreadCount);
        if (countOnly && open) setData((previous) => ({ ...previous, unreadCount: result.unreadCount, total: result.total }));
        else setData(result);
        setError("");
      } catch (err) {
        if (epoch.current === current) setError(err instanceof Error ? err.message : String(err));
      } finally { inFlight = false; if (epoch.current === current && !countOnly) setLoading(false); }
    };
    const serverChanged = () => {
      epoch.current += 1;
      setData({ items: [], total: 0, unreadCount: 0 });
      setLoading(false); paging.current = false;
      onUnreadChange(0);
      setRevision((value) => value + 1);
    };
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(false); }, 45000);
    window.addEventListener("focus", load);
    window.addEventListener(NOTIFICATIONS_CHANGED_EVENT, load);
    window.addEventListener(SERVER_URL_CHANGED_EVENT, serverChanged);
    window.addEventListener("nowen:token-changed", serverChanged);
    window.addEventListener("nowen:workspace-changed", load);
    return () => {
      epoch.current += 1;
      clearInterval(timer);
      window.removeEventListener("focus", load);
      window.removeEventListener(NOTIFICATIONS_CHANGED_EVENT, load);
      window.removeEventListener(SERVER_URL_CHANGED_EVENT, serverChanged);
      window.removeEventListener("nowen:token-changed", serverChanged);
      window.removeEventListener("nowen:workspace-changed", load);
    };
  }, [open, unreadOnly, revision, onUnreadChange]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key !== "Tab") return;
      const elements = dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [open]);

  const run = async (operation: () => Promise<unknown>, after?: () => void | Promise<void>) => {
    const current = epoch.current;
    setLoading(true);
    setError("");
    try {
      await operation();
      if (current !== epoch.current) return;
      await after?.();
      if (current !== epoch.current) return;
      setRevision((value) => value + 1);
    } catch (err) { if (current === epoch.current) setError(err instanceof Error ? err.message : String(err)); }
    finally { if (current === epoch.current) setLoading(false); }
  };
  const openNotification = (notification: WorkspaceNotification) => void run(() => api.notifications.read(notification.id), async () => {
    if (notification.resourceType === "note_comment") {
      if (!notification.noteId || !onOpenComment) throw new Error(t("commentCenter.unavailable"));
      await onOpenComment(notification.noteId, notification.commentId || notification.resourceId);
    } else onOpenIssue(notification.resourceId, notification.workspaceId!);
    setOpen(false);
  });

  if (!open) return null;
  return createPortal(<div className="fixed inset-0 z-[100] bg-black/30" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={t("notificationCenter.title")} className="absolute right-0 flex w-full max-w-md flex-col overflow-hidden border-l border-app-border bg-app-bg text-tx-primary shadow-xl" style={{ top: viewport.top, height: viewport.height }}>
      <header className="flex shrink-0 items-center gap-2 border-b border-app-border p-4 pt-[max(16px,env(safe-area-inset-top))]">
        <h2 className="mr-auto font-semibold">{t("notificationCenter.title")} {data.unreadCount > 0 && <span className="text-sm text-accent-primary">{data.unreadCount}</span>}</h2>
        <button ref={close} className={buttonClass} aria-label={t("notificationCenter.close")} onClick={() => setOpen(false)}><X size={16} /></button>
      </header>
      <div className="flex shrink-0 flex-wrap gap-2 border-b border-app-border p-3">
        <button className={buttonClass} disabled={loading} aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>{t("notificationCenter.all")}</button>
        <button className={buttonClass} disabled={loading} aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>{t("notificationCenter.unread")}</button>
        <button className={buttonClass} disabled={loading} onClick={() => setRevision((value) => value + 1)}>{t("issues.refresh")}</button>
        <button className={buttonClass} onClick={() => { setOpen(false); openCommentCenter(); }}>{t("commentCenter.title")}</button>
        <button className={buttonClass} disabled={loading || data.unreadCount === 0} onClick={() => void run(() => api.notifications.readAll())}>{t("notificationCenter.readAll")}</button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-3 pb-[calc(16px+env(safe-area-inset-bottom))]">
        {error && <div role="alert" className="text-sm text-accent-danger">{error} <button className={buttonClass} onClick={() => setRevision((value) => value + 1)}>{t("issues.retry")}</button></div>}
        {data.items.length === 0 && !error && <p className="py-8 text-center text-sm text-tx-tertiary">{t("notificationCenter.empty")}</p>}
        {data.items.map((notification) => <button key={notification.id} className={`w-full rounded-lg border border-app-border p-3 text-left hover:bg-app-hover ${notification.readAt ? "text-tx-secondary" : "bg-accent-primary/5"}`} disabled={loading} onClick={() => openNotification(notification)}>
          <p className="text-xs text-tx-tertiary">{notification.workspaceName || t("commentCenter.personal")} · {new Date(notification.createdAt).toLocaleString()}{!notification.readAt && <span className="ml-2 text-accent-primary">●</span>}</p>
          <p className="mt-1 text-sm">{notification.actorName || t("issues.unknown")} {t(`notificationCenter.${notification.type}`)}</p>
          <p className="break-words text-sm font-medium">{notification.title}</p>
          {notification.body && <p className="mt-1 line-clamp-2 break-words text-xs text-tx-tertiary">{notification.body}</p>}
        </button>)}
        {data.items.length < data.total && <button className={buttonClass} disabled={loading} onClick={async () => {
          const current = epoch.current;
          setLoading(true);
          paging.current = true;
          try {
            const result = await api.notifications.list(unreadOnly, data.items.length);
            if (epoch.current === current) setData((previous) => ({ ...result, items: [...previous.items, ...result.items] }));
          } catch (err) { if (current === epoch.current) setError(err instanceof Error ? err.message : String(err)); }
          finally { paging.current = false; setLoading(false); }
        }}>{t("issues.more")}</button>}
      </div>
    </div>
  </div>, document.body);
}
