import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleDot, CheckCircle2, FileText, MessageSquare, Plus, RefreshCw, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import { formatAppDateTime } from "@/lib/dateTime";
import { openWorkspaceIssue, NOTIFICATIONS_CHANGED_EVENT } from "@/lib/workspaceIssueNavigation";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { useVisibleViewport } from "@/hooks/useVisibleViewport";
import { useAppActions } from "@/store/AppContext";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import type { IssueActivity, IssueListResponse, WorkspaceIssueDetail } from "@/types/workspaceIssues";

const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface/85 px-3 py-1.5 text-sm font-medium text-tx-primary shadow-sm backdrop-blur-sm transition-all duration-150 hover:-translate-y-[1px] hover:border-accent-primary/40 hover:bg-app-hover active:translate-y-[0.5px] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";
const primaryButtonClass = "inline-flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 px-3.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-indigo-500/25 transition-all duration-150 hover:-translate-y-[1px] hover:from-indigo-500 hover:to-violet-500 hover:shadow-md hover:shadow-indigo-500/30 active:translate-y-[0.5px] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";
const fieldClass = "mt-1.5 w-full rounded-xl border border-app-border/80 bg-app-bg/80 px-3.5 py-2.5 text-sm text-tx-primary placeholder:text-tx-tertiary shadow-inner shadow-black/[0.02] transition-all focus:border-accent-primary/60 focus:outline-none focus:ring-4 focus:ring-accent-primary/12";
const bentoCardClass = "rounded-2xl border border-app-border/75 bg-app-surface/85 shadow-[0_8px_28px_-16px_rgba(15,23,42,0.14)] backdrop-blur-md dark:shadow-[0_12px_32px_-16px_rgba(0,0,0,0.55)]";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function Content({ text }: { text: string }) {
  return <div className="max-w-none break-words text-sm leading-relaxed [&_p]:my-2 [&_h1]:text-xl [&_h2]:text-lg [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-app-hover [&_pre]:p-3 [&_a]:text-accent-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-app-border [&_blockquote]:pl-3 [&_table]:block [&_table]:overflow-x-auto">
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, href, title }) => <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text}</ReactMarkdown>
  </div>;
}

export default function WorkspaceIssues({ issueId }: { issueId: string | null }) {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [workspaceId, setWorkspaceId] = useState(getCurrentWorkspace);
  const [filter, setFilter] = useState("open");
  const [list, setList] = useState<IssueListResponse | null>(null);
  const [detail, setDetail] = useState<WorkspaceIssueDetail | null>(null);
  const [activity, setActivity] = useState<{ items: IssueActivity[]; total: number }>({ items: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [form, setForm] = useState<"create" | "edit" | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [relatedNoteId, setRelatedNoteId] = useState("");
  const [notes, setNotes] = useState<{ id: string; title: string }[]>([]);
  const [reply, setReply] = useState("");
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const viewport = useVisibleViewport(true);
  const local = isMobileLocalMode();

  useEffect(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLTextAreaElement && root.current?.contains(focused)) {
      focused.scrollIntoView?.({ block: "nearest" });
    }
  }, [viewport.height, viewport.top]);
  const personal = workspaceId === "personal";

  useEffect(() => {
    const change = () => {
      generation.current += 1;
      setWorkspaceId(getCurrentWorkspace());
      setList(null);
      setForm(null);
      setReply("");
      setEditingComment(null);
      setError("");
    };
    window.addEventListener("nowen:workspace-changed", change);
    return () => { generation.current += 1; window.removeEventListener("nowen:workspace-changed", change); };
  }, []);

  useEffect(() => {
    if (local || (personal && !issueId)) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    if (issueId) {
      Promise.all([api.issues.get(issueId), api.issues.activity(issueId)]).then(([issue, events]) => {
        if (cancelled) return;
        if (getCurrentWorkspace() !== issue.workspaceId) {
          setCurrentWorkspace(issue.workspaceId);
          window.dispatchEvent(new CustomEvent("nowen:workspace-changed", { detail: { workspaceId: issue.workspaceId, preserveIssueRoute: true } }));
        }
        setDetail(issue);
        setActivity(events);
      }).catch((err) => { if (!cancelled) { setDetail(null); setError(errorMessage(err)); } })
        .finally(() => { if (!cancelled) setLoading(false); });
    } else {
      setList(null);
      api.issues.list(workspaceId, filter).then((result) => { if (!cancelled) setList(result); })
        .catch((err) => { if (!cancelled) setError(errorMessage(err)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }
    return () => { cancelled = true; };
  }, [issueId, workspaceId, filter, revision, local, personal]);

  useEffect(() => {
    if (!form) return;
    let cancelled = false;
    api.getNotes().then((items) => { if (!cancelled) setNotes(items); }).catch(() => { if (!cancelled) setNotes([]); });
    return () => { cancelled = true; };
  }, [form, workspaceId]);

  const run = useCallback(async (operation: (isCurrent: () => boolean) => Promise<unknown>, after?: () => void, refresh = true) => {
    const currentGeneration = generation.current;
    setBusy(true);
    setError("");
    try {
      await operation(() => currentGeneration === generation.current);
      if (currentGeneration !== generation.current) return;
      after?.();
      if (refresh) setRevision((value) => value + 1);
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
    } catch (err) { if (currentGeneration === generation.current) setError(errorMessage(err)); }
    finally { setBusy(false); }
  }, []);

  const showForm = (mode: "create" | "edit") => {
    setForm(mode);
    setTitle(mode === "edit" ? detail?.title ?? "" : "");
    setContent(mode === "edit" ? detail?.content ?? "" : "");
    setRelatedNoteId(mode === "edit" ? detail?.relatedNoteId ?? "" : "");
  };
  const more = () => run(async (isCurrent) => {
    if (issueId) {
      const result = await api.issues.activity(issueId, activity.items.length);
      if (isCurrent()) setActivity((previous) => ({ ...result, items: [...previous.items, ...result.items] }));
    } else if (list) {
      const result = await api.issues.list(workspaceId, filter, list.items.length);
      if (isCurrent()) setList((previous) => ({ ...result, items: [...(previous?.items ?? []), ...result.items] }));
    }
  }, undefined, false);

  // 原生键盘不缩短 WebView 时，当前议题区域也要使用实际可见底边。
  const top = root.current?.getBoundingClientRect().top ?? 0;
  const maxHeight = Math.max(0, viewport.top + viewport.height - top);

  return <div ref={root} data-testid="workspace-issues" className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-br from-app-bg via-app-bg to-indigo-500/[0.03] text-tx-primary dark:to-indigo-500/[0.06]" style={{ maxHeight }}>
    <div className="pointer-events-none absolute -top-24 right-8 h-56 w-56 rounded-full bg-indigo-500/8 blur-3xl dark:bg-indigo-500/14" aria-hidden="true" />
    <header className="relative z-10 flex shrink-0 flex-wrap items-center gap-2.5 border-b border-app-border/75 bg-app-surface/80 px-5 py-3.5 backdrop-blur-xl">
      {issueId && <button className={buttonClass} onClick={() => openWorkspaceIssue(null)} aria-label={t("issues.back")}><ArrowLeft size={16} /></button>}
      <div className="mr-auto flex items-center gap-3">
        <span aria-hidden="true" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/16 via-sky-500/12 to-violet-500/18 text-indigo-600 ring-1 ring-inset ring-indigo-500/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_2px_0_rgba(15,23,42,0.06)] dark:text-indigo-300 dark:ring-indigo-400/25">
          <CircleDot size={18} />
        </span>
        <div className="min-w-0">
          <h1 className="text-base font-bold tracking-tight text-tx-primary">{t("issues.title")}</h1>
        </div>
      </div>
      <button className={buttonClass} disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden="true" />{t("issues.refresh")}</button>
      {!issueId && list?.canCreate && <button className={primaryButtonClass} disabled={busy} onClick={() => showForm("create")}><Plus size={14} aria-hidden="true" />{t("issues.create")}</button>}
    </header>
    <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6 pb-[calc(20px+env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-3xl space-y-4">
        {error && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-rose-500/25 bg-rose-500/[0.07] px-4 py-3 text-sm text-rose-600 dark:border-rose-400/25 dark:bg-rose-500/12 dark:text-rose-300"><span>{error}</span><button className={buttonClass} onClick={() => setRevision((value) => value + 1)}>{t("issues.retry")}</button></div>}
        {local ? (
          <div className={`${bentoCardClass} flex flex-col items-center px-6 py-12 text-center`}>
            <span aria-hidden="true" className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/12 text-indigo-500 ring-1 ring-indigo-500/20 dark:text-indigo-300"><Sparkles size={22} /></span>
            <p className="text-sm text-tx-secondary">{t("issues.local")}</p>
          </div>
        ) : personal && !issueId ? (
          <div className={`${bentoCardClass} flex flex-col items-center px-6 py-12 text-center`}>
            <span aria-hidden="true" className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/12 text-sky-600 ring-1 ring-sky-500/20 dark:text-sky-300"><CircleDot size={22} /></span>
            <p className="text-sm text-tx-secondary">{t("issues.personal")}</p>
          </div>
        ) : <>
          {loading && <p role="status" className="inline-flex items-center gap-2 rounded-full border border-app-border/70 bg-app-surface/80 px-3.5 py-1.5 text-xs font-medium text-tx-secondary backdrop-blur-sm">{t("issues.loading")}</p>}
          {form && <form className={`${bentoCardClass} space-y-4 p-5`} onSubmit={(event) => {
            event.preventDefault();
            void run(async (isCurrent) => {
              if (form === "create") {
                const issue = await api.issues.create({ workspaceId, title, content, relatedNoteId: relatedNoteId || null });
                if (isCurrent() && getCurrentWorkspace() === workspaceId) openWorkspaceIssue(issue.id);
              } else if (issueId) await api.issues.update(issueId, { title, content, relatedNoteId: relatedNoteId || null });
            }, () => setForm(null));
          }}>
            <label className="block text-xs font-semibold text-tx-secondary">{t("issues.heading")}<input className={fieldClass} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></label>
            <label className="block text-xs font-semibold text-tx-secondary">{t("issues.content")}<textarea className={fieldClass} rows={5} maxLength={100000} value={content} onChange={(event) => setContent(event.target.value)} /></label>
            <label className="block text-xs font-semibold text-tx-secondary">{t("issues.relatedNote")}<select className={fieldClass} value={relatedNoteId} onChange={(event) => setRelatedNoteId(event.target.value)}>
              <option value="">{t("issues.noNote")}</option>
              {detail?.relatedNote && !notes.some((note) => note.id === detail.relatedNoteId) && <option value={detail.relatedNote.id}>{detail.relatedNote.title}</option>}
              {notes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
            </select></label>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button className={primaryButtonClass} disabled={busy || !title.trim()} type="submit">{t(form === "create" ? "issues.submit" : "issues.save")}</button>
              <button className={buttonClass} type="button" disabled={busy} onClick={() => setForm(null)}>{t("issues.cancel")}</button>
            </div>
          </form>}
          {!issueId && <>
            <div className="inline-flex items-center gap-1 rounded-2xl border border-app-border/75 bg-app-surface/80 p-1 shadow-sm backdrop-blur-md" aria-label={t("issues.title")}>
              {["all", "open", "closed"].map((value) => (
                <button
                  key={value}
                  aria-pressed={filter === value}
                  className={`rounded-xl px-3.5 py-1.5 text-xs font-semibold transition-all duration-150 ${filter === value ? "bg-app-elevated text-accent-primary shadow-[0_2px_0_rgba(15,23,42,0.06),0_6px_14px_-4px_rgba(99,102,241,0.22)] ring-1 ring-accent-primary/20 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]" : "text-tx-secondary hover:bg-app-hover/70 hover:text-tx-primary"}`}
                  onClick={() => { generation.current += 1; setFilter(value); }}
                >
                  {t(`issues.${value}`)}
                </button>
              ))}
            </div>
            {list?.items.length === 0 && (
              <div className={`${bentoCardClass} flex flex-col items-center px-6 py-12 text-center`}>
                <span aria-hidden="true" className="mb-3 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/14 to-sky-500/14 text-indigo-500 ring-1 ring-indigo-500/20 dark:text-indigo-300"><MessageSquare size={22} /></span>
                <p className="text-sm text-tx-tertiary">{t("issues.empty")}</p>
              </div>
            )}
            <div className="space-y-2.5">
              {list?.items.map((issue) => (
                <button
                  key={issue.id}
                  className={`${bentoCardClass} group flex w-full items-start gap-3.5 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-primary/35 hover:shadow-md active:translate-y-0`}
                  onClick={() => openWorkspaceIssue(issue.id)}
                >
                  <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset ${issue.status === "open" ? "bg-emerald-500/12 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300" : "bg-violet-500/12 text-violet-600 ring-violet-500/20 dark:text-violet-300"}`}>
                    {issue.status === "open" ? <CircleDot size={16} /> : <CheckCircle2 size={16} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="break-words text-[15px] font-semibold text-tx-primary transition-colors group-hover:text-accent-primary">{issue.title}</h2>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-tx-tertiary">
                      <span className="font-mono text-[11px] font-medium text-tx-secondary">#{issue.number}</span>
                      <span>·</span>
                      <span>{issue.authorName || t("issues.unknown")}</span>
                      <span>·</span>
                      <span>{t("issues.comments", { count: issue.commentCount })}</span>
                      <span>·</span>
                      <span>{formatAppDateTime(issue.updatedAt)}</span>
                    </p>
                  </div>
                </button>
              ))}
            </div>
            {list && list.items.length < list.total && <div className="pt-1 text-center"><button className={buttonClass} disabled={busy} onClick={() => void more()}>{t("issues.more")}</button></div>}
          </>}
          {issueId && detail?.id === issueId && <>
            <article className={`${bentoCardClass} space-y-4 p-5 sm:p-6`}>
              <div className="space-y-2 border-b border-app-border/60 pb-4">
                <h2 className="break-words text-xl font-bold tracking-tight text-tx-primary">
                  {detail.title} <span className="font-mono text-base font-normal text-tx-tertiary">#{detail.number}</span>
                </h2>
                <p className="flex flex-wrap items-center gap-2 text-xs text-tx-secondary">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-semibold ring-1 ring-inset ${detail.status === "open" ? "bg-emerald-500/12 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300" : "bg-violet-500/12 text-violet-700 ring-violet-500/25 dark:text-violet-300"}`}>
                    {detail.status === "open" ? <CircleDot size={12} aria-hidden="true" /> : <CheckCircle2 size={12} aria-hidden="true" />}
                    {t(`issues.${detail.status}`)}
                  </span>
                  <span>·</span>
                  <span className="font-medium text-tx-primary">{detail.authorName || t("issues.unknown")}</span>
                  <span>·</span>
                  <span className="text-tx-tertiary">{formatAppDateTime(detail.createdAt)}</span>
                </p>
              </div>
              <Content text={detail.content} />
              {detail.relatedNote && (
                <div className="pt-1">
                  <button className={buttonClass} disabled={busy} onClick={() => void run(async (isCurrent) => {
                    const note = await api.getNote(detail.relatedNote!.id);
                    if (!isCurrent() || getCurrentWorkspace() !== detail.workspaceId) return;
                    pushAppPathState("/");
                    actions.setActiveNote(note);
                    actions.setViewMode("all");
                    actions.setMobileView("editor");
                  })}><FileText size={14} className="text-accent-primary" aria-hidden="true" />{t("issues.relatedNote")}: {detail.relatedNote.title}</button>
                </div>
              )}
              {(detail.canEdit || detail.canChangeStatus) && (
                <div className="flex flex-wrap gap-2 border-t border-app-border/60 pt-3">
                  {detail.canEdit && <button className={buttonClass} disabled={busy} onClick={() => showForm("edit")}>{t("issues.edit")}</button>}
                  {detail.canChangeStatus && <button className={buttonClass} disabled={busy} onClick={() => void run(() => api.issues.update(issueId, { status: detail.status === "open" ? "closed" : "open" }))}>{t(detail.status === "open" ? "issues.close" : "issues.reopen")}</button>}
                </div>
              )}
            </article>
            <div className="flex items-center gap-2 pt-2">
              <MessageSquare size={15} className="text-accent-primary" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-tx-primary">{t("issues.comments", { count: detail.commentCount })}</h3>
            </div>
            <div className="space-y-3">
              {activity.items.map((item) => item.type !== "comment" ? (
                <p key={item.id} className="ml-3 flex items-center gap-2 border-l-2 border-accent-primary/30 py-1 pl-3.5 text-xs text-tx-tertiary">
                  <span className="font-medium text-tx-secondary">{item.authorName || t("issues.unknown")}</span>
                  <span>{t(item.type === "closed" ? "issues.closedEvent" : "issues.reopenedEvent")}</span>
                  <span>·</span>
                  <span>{formatAppDateTime(item.createdAt)}</span>
                </p>
              ) : (
                <article key={item.id} className={`${bentoCardClass} space-y-3 p-4 sm:p-5`}>
                  <p className="flex flex-wrap items-center gap-1.5 border-b border-app-border/50 pb-2.5 text-xs text-tx-tertiary">
                    <span className="font-semibold text-tx-primary">{item.authorName || t("issues.unknown")}</span>
                    <span>·</span>
                    <span>{formatAppDateTime(item.createdAt)}</span>
                    {item.updatedAt !== item.createdAt && <span className="rounded-full bg-app-hover px-2 py-0.5 text-[11px]">{t("issues.edited")}</span>}
                  </p>
                  {editingComment === item.id ? (
                    <form className="space-y-2.5" onSubmit={(event) => { event.preventDefault(); void run(() => api.issues.editComment(issueId, item.id, commentDraft), () => setEditingComment(null)); }}>
                      <textarea className={fieldClass} rows={3} maxLength={20000} value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} aria-label={t("issues.reply")} />
                      <div className="flex gap-2">
                        <button className={primaryButtonClass} disabled={busy || !commentDraft.trim()}>{t("issues.save")}</button>
                        <button className={buttonClass} type="button" disabled={busy} onClick={() => setEditingComment(null)}>{t("issues.cancel")}</button>
                      </div>
                    </form>
                  ) : <Content text={item.content} />}
                  {item.canEdit && editingComment !== item.id && (
                    <div className="flex gap-2 pt-1">
                      <button className={buttonClass} disabled={busy} onClick={() => { setEditingComment(item.id); setCommentDraft(item.content); }}>{t("issues.edit")}</button>
                      <button className={buttonClass} disabled={busy} onClick={() => { if (window.confirm(t("issues.confirmDelete"))) void run(() => api.issues.deleteComment(issueId, item.id)); }}>{t("issues.delete")}</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
            {activity.items.length < activity.total && <div className="text-center"><button className={buttonClass} disabled={busy} onClick={() => void more()}>{t("issues.more")}</button></div>}
            {detail.canComment ? (
              <form className={`${bentoCardClass} space-y-3 p-4 sm:p-5`} onSubmit={(event) => { event.preventDefault(); void run(() => api.issues.comment(issueId, reply), () => setReply("")); }}>
                <textarea className={fieldClass} rows={4} maxLength={20000} value={reply} onChange={(event) => setReply(event.target.value)} aria-label={t("issues.reply")} placeholder={t("issues.replyPlaceholder")} />
                <div className="flex justify-end">
                  <button className={primaryButtonClass} disabled={busy || !reply.trim()} type="submit">{t("issues.send")}</button>
                </div>
              </form>
            ) : <p className="rounded-xl border border-app-border/70 bg-app-surface/60 px-4 py-3 text-sm text-tx-tertiary">{t("issues.readOnly")}</p>}
          </>}
        </>}
      </div>
    </div>
  </div>;
}
