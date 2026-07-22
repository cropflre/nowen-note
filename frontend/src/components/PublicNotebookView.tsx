import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  FileText,
  Globe2,
  KeyRound,
  ListTree,
  Loader2,
  LockKeyhole,
  MessageCircle,
  Search,
  Send,
  ShieldCheck,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import TiptapEditor from "@/components/TiptapEditor";
import type { Note } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  notebookPublicationApi,
  type PublicComment,
  type PublicNotebookIndexItem,
  type PublicNotebookInfo,
  type PublicNotebookNode,
  type PublicNoteContent,
  type PublicNoteSummary,
} from "@/lib/notebookPublicationApi";

interface PublicNotebookViewProps {
  token?: string;
}

interface OutlineItem {
  id: string;
  level: number;
  text: string;
}

function publicationAccessKey(token: string): string {
  return `nowen-public-notebook:${token}`;
}

function hasLoginToken(): boolean {
  try {
    return !!localStorage.getItem("nowen-token");
  } catch {
    return false;
  }
}

function PublicNotebookIndex() {
  const [items, setItems] = useState<PublicNotebookIndexItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    notebookPublicationApi.getPublicIndex()
      .then(setItems)
      .catch((err: any) => setError(err?.message || "公共空间加载失败"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen overflow-y-auto bg-app-bg text-tx-primary">
      <header className="sticky top-0 z-10 border-b border-app-border bg-app-surface/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
              <Globe2 size={20} />
            </div>
            <div>
              <h1 className="text-base font-semibold">公共空间</h1>
              <p className="text-xs text-tx-tertiary">无需登录即可浏览明确发布的知识库</p>
            </div>
          </div>
          {hasLoginToken() && (
            <Button variant="outline" onClick={() => window.location.assign("/")}>返回工作台</Button>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">
        {loading ? (
          <div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-tx-secondary">
            <Loader2 size={17} className="animate-spin" /> 正在加载公共空间
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-300/50 bg-red-500/5 p-6 text-sm text-red-600 dark:text-red-300">{error}</div>
        ) : items.length === 0 ? (
          <div className="flex min-h-[45vh] flex-col items-center justify-center rounded-2xl border border-dashed border-app-border bg-app-surface/40 text-center">
            <Globe2 size={34} className="mb-3 text-tx-tertiary" />
            <h2 className="font-medium">暂时没有公开知识库</h2>
            <p className="mt-1 text-sm text-tx-tertiary">只有管理员明确发布的目录才会显示在这里。</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <button
                key={item.token}
                type="button"
                onClick={() => window.location.assign(`/public/${item.token}`)}
                className="group rounded-2xl border border-app-border bg-app-surface p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-accent-primary/40 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-app-hover text-xl">{item.icon || "📚"}</div>
                  <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] font-medium text-emerald-600 dark:text-emerald-300">公开发布</span>
                </div>
                <h2 className="mt-4 truncate text-base font-semibold group-hover:text-accent-primary">{item.name}</h2>
                <p className="mt-1 text-xs text-tx-tertiary">
                  由 {item.ownerDisplayName || item.ownerUsername} 发布 · {Number(item.noteCount || 0)} 篇笔记
                </p>
                <div className="mt-4 flex items-center justify-between text-xs text-tx-secondary">
                  <span>{item.permission === "write" ? "登录后可编辑" : item.permission === "comment" ? "可评论" : "只读"}</span>
                  <ChevronRight size={14} className="transition-transform group-hover:translate-x-1" />
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default function PublicNotebookView({ token }: PublicNotebookViewProps) {
  return token ? <PublicNotebookReader token={token} /> : <PublicNotebookIndex />;
}

function PublicNotebookReader({ token }: { token: string }) {
  const [info, setInfo] = useState<PublicNotebookInfo | null>(null);
  const [notebooks, setNotebooks] = useState<PublicNotebookNode[]>([]);
  const [notes, setNotes] = useState<PublicNoteSummary[]>([]);
  const [activeNoteId, setActiveNoteId] = useState("");
  const [activeNote, setActiveNote] = useState<PublicNoteContent | null>(null);
  const [accessToken, setAccessToken] = useState(() => {
    try { return sessionStorage.getItem(publicationAccessKey(token)) || ""; } catch { return ""; }
  });
  const [secret, setSecret] = useState("");
  const [needsSecret, setNeedsSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [noteLoading, setNoteLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [comments, setComments] = useState<PublicComment[]>([]);
  const [nickname, setNickname] = useState(() => {
    try { return localStorage.getItem("nowen-public-nickname") || ""; } catch { return ""; }
  });
  const [commentText, setCommentText] = useState("");
  const [commentWebsite, setCommentWebsite] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [joining, setJoining] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const loadTree = useCallback(async (nextInfo: PublicNotebookInfo, nextAccessToken: string) => {
    try {
      const tree = await notebookPublicationApi.getPublicTree(token, nextAccessToken || undefined);
      setNotebooks(tree.notebooks);
      setNotes(tree.notes);
      setNeedsSecret(false);
      setActiveNoteId((current) => current && tree.notes.some((note) => note.id === current) ? current : tree.notes[0]?.id || "");
    } catch (err: any) {
      if (err?.status === 401 && nextInfo.needSecret) {
        setNeedsSecret(true);
        return;
      }
      throw err;
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    notebookPublicationApi.getPublicInfo(token)
      .then(async (nextInfo) => {
        if (cancelled) return;
        setInfo(nextInfo);
        await loadTree(nextInfo, accessToken);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.message || "公共知识库不可用");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, accessToken, loadTree]);

  useEffect(() => {
    if (!activeNoteId || needsSecret) {
      setActiveNote(null);
      setComments([]);
      return;
    }
    let cancelled = false;
    setNoteLoading(true);
    Promise.all([
      notebookPublicationApi.getPublicNote(token, activeNoteId, accessToken || undefined),
      notebookPublicationApi.getComments(token, activeNoteId, accessToken || undefined).catch(() => []),
    ])
      .then(([note, nextComments]) => {
        if (cancelled) return;
        setActiveNote(note);
        setComments(nextComments);
      })
      .catch((err: any) => {
        if (!cancelled) toast.error(err?.message || "笔记加载失败");
      })
      .finally(() => {
        if (!cancelled) setNoteLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, activeNoteId, accessToken, needsSecret]);

  useEffect(() => {
    const host = contentRef.current;
    if (!host || !activeNote) {
      setOutline([]);
      return;
    }
    const timer = window.setTimeout(() => {
      const headings = Array.from(host.querySelectorAll<HTMLHeadingElement>("h1,h2,h3,h4,h5,h6"));
      setOutline(headings.map((heading, index) => {
        const id = heading.id || `public-heading-${index}`;
        heading.id = id;
        return { id, level: Number(heading.tagName.slice(1)) || 1, text: heading.textContent?.trim() || "未命名标题" };
      }));
    }, 80);
    return () => window.clearTimeout(timer);
  }, [activeNote]);

  const filteredNotes = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword
      ? notes.filter((note) => `${note.title} ${note.contentText || ""}`.toLowerCase().includes(keyword))
      : notes;
  }, [notes, query]);

  const notesByNotebook = useMemo(() => {
    const grouped = new Map<string, PublicNoteSummary[]>();
    for (const note of filteredNotes) {
      const list = grouped.get(note.notebookId) || [];
      list.push(note);
      grouped.set(note.notebookId, list);
    }
    return grouped;
  }, [filteredNotes]);

  const fakeNote = useMemo<Note | null>(() => {
    if (!activeNote) return null;
    return {
      id: activeNote.id,
      userId: "public",
      notebookId: activeNote.notebookId,
      workspaceId: null,
      title: activeNote.title || "",
      content: activeNote.content || "{}",
      contentText: activeNote.contentText || "",
      isPinned: 0,
      isFavorite: 0,
      isLocked: 1,
      isArchived: 0,
      isTrashed: 0,
      trashedAt: null,
      sortOrder: 0,
      version: activeNote.version || 0,
      createdAt: activeNote.updatedAt,
      updatedAt: activeNote.updatedAt,
      contentFormat: activeNote.contentFormat || "tiptap-json",
      tags: [],
    } as Note;
  }, [activeNote]);

  const verifySecret = async () => {
    if (!info || !secret.trim()) return;
    try {
      const result = await notebookPublicationApi.verifyPublicSecret(token, secret.trim());
      setAccessToken(result.accessToken);
      try { sessionStorage.setItem(publicationAccessKey(token), result.accessToken); } catch { /* ignore */ }
      setSecret("");
      await loadTree(info, result.accessToken);
    } catch (err: any) {
      toast.error(err?.message || "验证失败");
    }
  };

  const submitComment = async () => {
    if (!activeNote || !nickname.trim() || !commentText.trim()) return;
    setCommenting(true);
    try {
      const created = await notebookPublicationApi.addComment(
        token,
        activeNote.id,
        { nickname: nickname.trim(), content: commentText.trim(), _hp: commentWebsite },
        accessToken || undefined,
      );
      setComments((current) => [...current, created]);
      setCommentText("");
      try { localStorage.setItem("nowen-public-nickname", nickname.trim()); } catch { /* ignore */ }
    } catch (err: any) {
      toast.error(err?.message || "评论失败");
    } finally {
      setCommenting(false);
    }
  };

  const join = async () => {
    if (!hasLoginToken()) {
      window.location.assign(`/login?redirect=${encodeURIComponent(`/public/${token}`)}`);
      return;
    }
    setJoining(true);
    try {
      await notebookPublicationApi.joinPublication(token, accessToken || undefined);
      toast.success(info?.permission === "write" && info.allowEdit ? "已加入，可在工作台编辑" : "已加入到共享笔记本");
      window.location.assign("/");
    } catch (err: any) {
      toast.error(err?.message || "加入失败");
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center gap-2 bg-app-bg text-sm text-tx-secondary"><Loader2 size={17} className="animate-spin" />正在加载知识库</div>;
  }

  if (error || !info) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app-bg px-5 text-tx-primary">
        <div className="max-w-md rounded-2xl border border-app-border bg-app-surface p-6 text-center">
          <LockKeyhole size={30} className="mx-auto mb-3 text-tx-tertiary" />
          <h1 className="font-semibold">无法访问公共知识库</h1>
          <p className="mt-2 text-sm text-tx-secondary">{error || "发布不存在或已被撤销"}</p>
          <Button variant="outline" className="mt-5" onClick={() => window.location.assign("/public")}>返回公共空间</Button>
        </div>
      </div>
    );
  }

  if (needsSecret) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-app-bg px-4 text-tx-primary">
        <div className="w-full max-w-sm rounded-2xl border border-app-border bg-app-surface p-6 shadow-xl">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-primary/10 text-accent-primary">
            {info.accessMode === "code" ? <KeyRound size={22} /> : <LockKeyhole size={22} />}
          </div>
          <h1 className="mt-4 text-center text-lg font-semibold">{info.icon || "📚"} {info.name}</h1>
          <p className="mt-1 text-center text-sm text-tx-tertiary">请输入{info.secretLabel || "访问凭证"}后浏览目录和正文</p>
          <Input
            type={info.accessMode === "password" ? "password" : "text"}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void verifySecret(); }}
            placeholder={info.accessMode === "code" ? "输入访问码" : "输入访问密码"}
            className="mt-5"
            autoFocus
          />
          <Button className="mt-3 w-full" onClick={verifySecret} disabled={!secret.trim()}>验证并进入</Button>
          <button className="mt-4 w-full text-center text-xs text-tx-tertiary hover:text-accent-primary" onClick={() => window.location.assign("/public")}>返回公共空间</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-0 bg-app-bg text-tx-primary">
      <aside className="hidden w-[280px] shrink-0 flex-col border-r border-app-border bg-app-surface md:flex">
        <div className="border-b border-app-border p-4">
          <button className="flex min-w-0 items-center gap-3 text-left" onClick={() => window.location.assign("/public")}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-app-hover text-xl">{info.icon || "📚"}</div>
            <div className="min-w-0"><div className="truncate text-sm font-semibold">{info.name}</div><div className="truncate text-[11px] text-tx-tertiary">{info.ownerDisplayName || info.ownerUsername} 的公共知识库</div></div>
          </button>
          <div className="relative mt-4">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-tx-tertiary" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已发布内容" className="h-9 pl-9 text-xs" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {notebooks.map((notebook) => {
            const childNotes = notesByNotebook.get(notebook.id) || [];
            if (query.trim() && childNotes.length === 0) return null;
            return (
              <div key={notebook.id} className="mb-1">
                <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-tx-secondary" style={{ paddingLeft: `${8 + notebook.depth * 14}px` }}><span>{notebook.icon || "📁"}</span><span className="truncate">{notebook.name}</span></div>
                {childNotes.map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() => setActiveNoteId(note.id)}
                    className={cn("mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-xs transition", activeNoteId === note.id ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary")}
                    style={{ paddingLeft: `${22 + notebook.depth * 14}px` }}
                  ><FileText size={13} className="shrink-0" /><span className="truncate">{note.title || "无标题笔记"}</span></button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="border-t border-app-border p-3">
          <Button variant="outline" className="w-full" onClick={join} disabled={joining}>
            {joining ? <Loader2 size={14} className="mr-1 animate-spin" /> : <UserPlus size={14} className="mr-1" />}
            {info.permission === "write" && info.allowEdit ? "登录并加入编辑" : "加入共享笔记本"}
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 border-b border-app-border bg-app-surface/90 px-4 py-3 backdrop-blur-xl md:hidden">
          <div className="flex items-center justify-between gap-3">
            <button className="flex min-w-0 items-center gap-2" onClick={() => window.location.assign("/public")}><BookOpen size={17} className="text-accent-primary" /><span className="truncate text-sm font-semibold">{info.name}</span></button>
            <Button size="sm" variant="outline" onClick={join}><UserPlus size={13} className="mr-1" />加入</Button>
          </div>
          <select className="mt-3 h-9 w-full rounded-lg border border-app-border bg-app-bg px-3 text-xs" value={activeNoteId} onChange={(event) => setActiveNoteId(event.target.value)}>
            {filteredNotes.map((note) => <option key={note.id} value={note.id}>{note.title || "无标题笔记"}</option>)}
          </select>
        </header>

        <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-8 px-5 py-8 lg:grid-cols-[minmax(0,1fr)_220px]">
          <article className="min-w-0">
            {noteLoading ? (
              <div className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-tx-secondary"><Loader2 size={16} className="animate-spin" />正在加载笔记</div>
            ) : !activeNote ? (
              <div className="flex min-h-[50vh] flex-col items-center justify-center text-center text-tx-tertiary"><FileText size={32} className="mb-3" /><p className="text-sm">这个目录暂时没有可公开浏览的笔记</p></div>
            ) : (
              <>
                <div className="mb-7 border-b border-app-border pb-5">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-tx-tertiary">
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-600 dark:text-emerald-300"><ShieldCheck size={11} />已发布</span>
                    <span>更新于 {new Date(activeNote.updatedAt).toLocaleString("zh-CN")}</span>
                    {!activeNote.allowDownload && <span>· 未开放附件下载</span>}
                  </div>
                  <h1 className="text-3xl font-bold leading-tight">{activeNote.title || "无标题笔记"}</h1>
                </div>
                <div ref={contentRef} className="public-notebook-content min-h-[240px]">
                  {activeNote.contentFormat === "md" ? (
                    <MarkdownPreview markdown={activeNote.content} compact className="p-0" />
                  ) : fakeNote ? (
                    <TiptapEditor
                      note={fakeNote}
                      editable={false}
                      onUpdate={() => undefined}
                      isGuest
                      presentationMode
                    />
                  ) : null}
                </div>

                {(activeNote.allowComment || info.permission !== "read") && (
                  <section className="mt-12 border-t border-app-border pt-7">
                    <h2 className="flex items-center gap-2 text-sm font-semibold"><MessageCircle size={16} className="text-accent-primary" />评论 {comments.length > 0 ? `(${comments.length})` : ""}</h2>
                    <div className="mt-4 space-y-3">
                      {comments.map((comment) => (
                        <div key={comment.id} className="rounded-xl border border-app-border bg-app-surface p-3">
                          <div className="flex items-center justify-between gap-3 text-xs"><span className="font-medium">{comment.nickname}</span><span className="text-tx-tertiary">{new Date(comment.createdAt).toLocaleString("zh-CN")}</span></div>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-tx-secondary">{comment.content}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-[160px_1fr_auto]">
                      <Input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="你的昵称" maxLength={32} />
                      <input
                        type="text"
                        value={commentWebsite}
                        onChange={(event) => setCommentWebsite(event.target.value)}
                        tabIndex={-1}
                        autoComplete="off"
                        aria-hidden="true"
                        className="absolute -left-[10000px] h-px w-px opacity-0"
                        name="website"
                      />
                      <Input value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="写下评论…" maxLength={1000} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitComment(); } }} />
                      <Button onClick={submitComment} disabled={commenting || !nickname.trim() || !commentText.trim()}>{commenting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}</Button>
                    </div>
                  </section>
                )}
              </>
            )}
          </article>

          <aside className="hidden lg:block">
            <div className="sticky top-8 rounded-xl border border-app-border bg-app-surface p-3">
              <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-tx-secondary"><ListTree size={14} />本页大纲</div>
              {outline.length === 0 ? <p className="px-1 py-2 text-xs text-tx-tertiary">当前笔记没有标题层级</p> : (
                <div className="space-y-0.5">
                  {outline.map((item) => <button key={item.id} type="button" onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })} className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-tx-secondary hover:bg-app-hover hover:text-tx-primary" style={{ paddingLeft: `${8 + (item.level - 1) * 10}px` }}>{item.text}</button>)}
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
