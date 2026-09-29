import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleDot, CheckCircle2, Plus } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { api, getCurrentWorkspace, setCurrentWorkspace } from "@/lib/api";
import { openWorkspaceIssue, NOTIFICATIONS_CHANGED_EVENT } from "@/lib/workspaceIssueNavigation";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { useVisibleViewport } from "@/hooks/useVisibleViewport";
import { useAppActions } from "@/store/AppContext";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import type { IssueActivity, IssueListResponse, WorkspaceIssueDetail } from "@/types/workspaceIssues";

const buttonClass = "rounded-lg border border-app-border px-3 py-1.5 text-sm hover:bg-app-hover disabled:opacity-50";
const fieldClass = "w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary";
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

  return <div ref={root} data-testid="workspace-issues" className="flex min-h-0 flex-1 flex-col overflow-hidden bg-app-bg text-tx-primary" style={{ maxHeight }}>
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-app-border p-4">
      {issueId && <button className={buttonClass} onClick={() => openWorkspaceIssue(null)} aria-label={t("issues.back")}><ArrowLeft size={16} /></button>}
      <h1 className="mr-auto text-lg font-semibold">{t("issues.title")}</h1>
      <button className={buttonClass} disabled={loading || busy} onClick={() => setRevision((value) => value + 1)}>{t("issues.refresh")}</button>
      {!issueId && list?.canCreate && <button className={buttonClass} disabled={busy} onClick={() => showForm("create")}><Plus size={14} className="mr-1 inline" />{t("issues.create")}</button>}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-[calc(16px+env(safe-area-inset-bottom))]">
      <div className="mx-auto max-w-3xl space-y-4">
        {error && <div role="alert" className="rounded-lg border border-accent-danger/30 p-3 text-sm text-accent-danger">{error} <button className={buttonClass} onClick={() => setRevision((value) => value + 1)}>{t("issues.retry")}</button></div>}
        {local ? <p>{t("issues.local")}</p> : personal && !issueId ? <p>{t("issues.personal")}</p> : <>
          {loading && <p role="status" className="text-sm text-tx-tertiary">{t("issues.loading")}</p>}
          {form && <form className="space-y-3 rounded-xl border border-app-border p-4" onSubmit={(event) => {
            event.preventDefault();
            void run(async (isCurrent) => {
              if (form === "create") {
                const issue = await api.issues.create({ workspaceId, title, content, relatedNoteId: relatedNoteId || null });
                if (isCurrent() && getCurrentWorkspace() === workspaceId) openWorkspaceIssue(issue.id);
              } else if (issueId) await api.issues.update(issueId, { title, content, relatedNoteId: relatedNoteId || null });
            }, () => setForm(null));
          }}>
            <label className="block text-sm">{t("issues.heading")}<input className={fieldClass} maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} required autoFocus /></label>
            <label className="block text-sm">{t("issues.content")}<textarea className={fieldClass} rows={5} maxLength={100000} value={content} onChange={(event) => setContent(event.target.value)} /></label>
            <label className="block text-sm">{t("issues.relatedNote")}<select className={fieldClass} value={relatedNoteId} onChange={(event) => setRelatedNoteId(event.target.value)}>
              <option value="">{t("issues.noNote")}</option>
              {detail?.relatedNote && !notes.some((note) => note.id === detail.relatedNoteId) && <option value={detail.relatedNote.id}>{detail.relatedNote.title}</option>}
              {notes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
            </select></label>
            <button className={buttonClass} disabled={busy || !title.trim()} type="submit">{t(form === "create" ? "issues.submit" : "issues.save")}</button>
            <button className={`${buttonClass} ml-2`} type="button" disabled={busy} onClick={() => setForm(null)}>{t("issues.cancel")}</button>
          </form>}
          {!issueId && <>
            <div className="flex gap-2" aria-label={t("issues.title")}>{["all", "open", "closed"].map((value) => <button key={value} aria-pressed={filter === value} className={`${buttonClass} ${filter === value ? "bg-app-hover text-accent-primary" : ""}`} onClick={() => { generation.current += 1; setFilter(value); }}>{t(`issues.${value}`)}</button>)}</div>
            {list?.items.length === 0 && <p className="py-8 text-center text-tx-tertiary">{t("issues.empty")}</p>}
            {list?.items.map((issue) => <button key={issue.id} className="flex w-full gap-3 rounded-xl border border-app-border p-4 text-left hover:bg-app-hover" onClick={() => openWorkspaceIssue(issue.id)}>
              {issue.status === "open" ? <CircleDot size={19} className="mt-1 shrink-0 text-accent-primary" /> : <CheckCircle2 size={19} className="mt-1 shrink-0 text-tx-tertiary" />}
              <div className="min-w-0"><h2 className="break-words font-medium">{issue.title}</h2><p className="mt-1 text-xs text-tx-tertiary">#{issue.number} · {issue.authorName || t("issues.unknown")} · {t("issues.comments", { count: issue.commentCount })} · {new Date(issue.updatedAt).toLocaleString()}</p></div>
            </button>)}
            {list && list.items.length < list.total && <button className={buttonClass} disabled={busy} onClick={() => void more()}>{t("issues.more")}</button>}
          </>}
          {issueId && detail?.id === issueId && <>
            <article className="space-y-4 rounded-xl border border-app-border p-4">
              <h2 className="break-words text-xl font-semibold">{detail.title} <span className="font-normal text-tx-tertiary">#{detail.number}</span></h2>
              <p className="text-sm text-tx-secondary">{t(`issues.${detail.status}`)} · {detail.authorName || t("issues.unknown")} · {new Date(detail.createdAt).toLocaleString()}</p>
              <Content text={detail.content} />
              {detail.relatedNote && <button className={buttonClass} disabled={busy} onClick={() => void run(async (isCurrent) => {
                const note = await api.getNote(detail.relatedNote!.id);
                if (!isCurrent() || getCurrentWorkspace() !== detail.workspaceId) return;
                pushAppPathState("/");
                actions.setActiveNote(note);
                actions.setViewMode("all");
                actions.setMobileView("editor");
              })}>{t("issues.relatedNote")}: {detail.relatedNote.title}</button>}
              <div className="flex flex-wrap gap-2">
                {detail.canEdit && <button className={buttonClass} disabled={busy} onClick={() => showForm("edit")}>{t("issues.edit")}</button>}
                {detail.canChangeStatus && <button className={buttonClass} disabled={busy} onClick={() => void run(() => api.issues.update(issueId, { status: detail.status === "open" ? "closed" : "open" }))}>{t(detail.status === "open" ? "issues.close" : "issues.reopen")}</button>}
              </div>
            </article>
            <h3 className="text-sm font-medium">{t("issues.comments", { count: detail.commentCount })}</h3>
            {activity.items.map((item) => item.type !== "comment" ? <p key={item.id} className="border-l-2 border-app-border pl-3 text-sm text-tx-tertiary">{item.authorName || t("issues.unknown")} {t(item.type === "closed" ? "issues.closedEvent" : "issues.reopenedEvent")} · {new Date(item.createdAt).toLocaleString()}</p> : <article key={item.id} className="space-y-3 rounded-xl border border-app-border p-4">
              <p className="text-xs text-tx-tertiary">{item.authorName || t("issues.unknown")} · {new Date(item.createdAt).toLocaleString()} {item.updatedAt !== item.createdAt && `· ${t("issues.edited")}`}</p>
              {editingComment === item.id ? <form onSubmit={(event) => { event.preventDefault(); void run(() => api.issues.editComment(issueId, item.id, commentDraft), () => setEditingComment(null)); }}>
                <textarea className={fieldClass} rows={3} maxLength={20000} value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} aria-label={t("issues.reply")} />
                <button className={buttonClass} disabled={busy || !commentDraft.trim()}>{t("issues.save")}</button> <button className={buttonClass} type="button" disabled={busy} onClick={() => setEditingComment(null)}>{t("issues.cancel")}</button>
              </form> : <Content text={item.content} />}
              {item.canEdit && editingComment !== item.id && <div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => { setEditingComment(item.id); setCommentDraft(item.content); }}>{t("issues.edit")}</button><button className={buttonClass} disabled={busy} onClick={() => { if (window.confirm(t("issues.confirmDelete"))) void run(() => api.issues.deleteComment(issueId, item.id)); }}>{t("issues.delete")}</button></div>}
            </article>)}
            {activity.items.length < activity.total && <button className={buttonClass} disabled={busy} onClick={() => void more()}>{t("issues.more")}</button>}
            {detail.canComment ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void run(() => api.issues.comment(issueId, reply), () => setReply("")); }}>
              <textarea className={fieldClass} rows={4} maxLength={20000} value={reply} onChange={(event) => setReply(event.target.value)} aria-label={t("issues.reply")} placeholder={t("issues.replyPlaceholder")} />
              <button className={buttonClass} disabled={busy || !reply.trim()} type="submit">{t("issues.send")}</button>
            </form> : <p className="text-sm text-tx-tertiary">{t("issues.readOnly")}</p>}
          </>}
        </>}
      </div>
    </div>
  </div>;
}
