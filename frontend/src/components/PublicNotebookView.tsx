import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  BrainCircuit,
  ChevronRight,
  FileSpreadsheet,
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
  Table2,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAppDateTime } from "@/lib/dateTime";
import { Input } from "@/components/ui/input";
import PublicKnowledgeResourceRenderer from "@/components/PublicKnowledgeResourceRenderer";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { navigateToAppPath } from "@/lib/appPathNavigation";
import {
  notebookPublicationApi,
  type PublicComment,
  type PublicKnowledgeResourceContent,
  type PublicKnowledgeResourceSummary,
  type PublicNotebookIndexItem,
  type PublicNotebookInfo,
  type PublicNotebookNode,
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

function ResourceIcon({ type }: { type: PublicKnowledgeResourceSummary["resourceType"] }) {
  if (type === "mindmap") return <BrainCircuit size={13} className="shrink-0" />;
  if (type === "sheet") return <Table2 size={13} className="shrink-0" />;
  if (type === "excel") return <FileSpreadsheet size={13} className="shrink-0 text-emerald-600" />;
  return <FileText size={13} className="shrink-0" />;
}

function resourceLabel(type: PublicKnowledgeResourceSummary["resourceType"]): string {
  if (type === "mindmap") return "思维导图";
  if (type === "sheet") return "轻量表格";
  if (type === "excel") return "Excel 表格";
  return "文档";
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
    <div className="relative min-h-screen overflow-y-auto bg-gradient-to-br from-slate-50 via-app-bg to-indigo-50/40 text-tx-primary dark:from-[#070a12] dark:via-app-bg dark:to-[#0d1324]">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-36 left-1/4 h-80 w-80 rounded-full bg-indigo-400/12 blur-3xl dark:bg-indigo-500/18" />
        <div className="absolute -bottom-32 right-1/5 h-80 w-80 rounded-full bg-sky-400/12 blur-3xl dark:bg-cyan-500/14" />
      </div>

      <header className="sticky top-0 z-10 border-b border-app-border/75 bg-app-surface/80 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/18 via-sky-500/14 to-violet-500/18 text-accent-primary ring-1 ring-inset ring-accent-primary/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_3px_0_rgba(15,23,42,0.06)]">
              <Globe2 size={21} />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight">公共空间</h1>
              <p className="text-xs text-tx-tertiary">无需登录即可浏览明确发布的知识库</p>
            </div>
          </div>
          {hasLoginToken() && (
            <Button variant="outline" className="rounded-xl border-app-border/80 bg-app-surface/85 shadow-sm hover:-translate-y-[1px] hover:border-accent-primary/40 hover:text-accent-primary" onClick={() => navigateToAppPath("/")}>返回工作台</Button>
          )}
        </div>
      </header>

      <main className="relative mx-auto max-w-6xl px-5 py-8">
        {loading ? (
          <div className="flex min-h-[40vh] items-center justify-center gap-2 text-sm text-tx-secondary">
            <Loader2 size={17} className="animate-spin text-accent-primary" /> 正在加载公共空间
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-rose-400/35 bg-rose-500/8 p-6 text-sm text-rose-600 dark:text-rose-300">{error}</div>
        ) : items.length === 0 ? (
          <div className="flex min-h-[45vh] flex-col items-center justify-center rounded-[28px] border border-dashed border-app-border/80 bg-app-surface/60 px-6 py-12 text-center backdrop-blur-md">
            <span className="mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/12 text-indigo-500 ring-1 ring-indigo-500/20 dark:text-indigo-300">
              <Globe2 size={28} />
            </span>
            <h2 className="text-base font-semibold">暂时没有公开知识库</h2>
            <p className="mt-1.5 text-sm text-tx-tertiary">只有管理员明确发布的目录才会显示在这里。</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <button
                key={item.token}
                type="button"
                onClick={() => navigateToAppPath(`/public/${item.token}`)}
                className="group relative overflow-hidden rounded-[22px] border border-app-border/75 bg-app-surface/85 p-5 text-left shadow-[0_10px_30px_-18px_rgba(15,23,42,0.16)] backdrop-blur-md transition-all duration-200 hover:-translate-y-1 hover:border-accent-primary/40 hover:shadow-[0_18px_40px_-18px_rgba(99,102,241,0.28)] active:translate-y-0 dark:shadow-[0_14px_34px_-18px_rgba(0,0,0,0.6)]"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/12 via-sky-500/10 to-violet-500/12 text-2xl ring-1 ring-inset ring-app-border/70 transition-transform duration-200 group-hover:scale-105 group-hover:-rotate-3">{item.icon || "📚"}</div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2.5 py-1 text-[10px] font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                    公开发布
                  </span>
                </div>
                <h2 className="mt-4 truncate text-base font-bold tracking-tight transition-colors group-hover:text-accent-primary">{item.name}</h2>
                <p className="mt-1 text-xs text-tx-tertiary">
                  由 {item.ownerDisplayName || item.ownerUsername} 发布 · 多类型知识内容
                </p>
                <div className="mt-4 flex items-center justify-between border-t border-app-border/55 pt-3 text-xs text-tx-secondary">
                  <span className="font-medium">{item.permission === "write" ? "登录后可编辑" : item.permission === "comment" ? "可评论" : "只读"}</span>
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-app-hover/80 text-tx-tertiary transition-all group-hover:translate-x-0.5 group-hover:bg-accent-primary/12 group-hover:text-accent-primary">
                    <ChevronRight size={14} />
                  </span>
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
  const [resources, setResources] = useState<PublicKnowledgeResourceSummary[]>([]);
  const [activeNodeId, setActiveNodeId] = useState("");
  const [activeResource, setActiveResource] = useState<PublicKnowledgeResourceContent | null>(null);
  const [accessToken, setAccessToken] = useState(() => {
    try { return sessionStorage.getItem(publicationAccessKey(token)) || ""; } catch { return ""; }
  });
  const [secret, setSecret] = useState("");
  const [needsSecret, setNeedsSecret] = useState(false);
  const [loading, setLoading] = useState(true);
  const [resourceLoading, setResourceLoading] = useState(false);
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
      const unified = tree.resources && tree.resources.length > 0
        ? tree.resources.filter((resource) => resource.resourceType !== "notebook")
        : tree.notes.map((note) => ({
            nodeId: `note:${note.id}`,
            parentNodeId: `notebook:${note.notebookId}`,
            resourceType: "note" as const,
            resourceId: note.id,
            notebookId: note.notebookId,
            title: note.title,
            contentText: note.contentText || "",
            contentFormat: note.contentFormat || null,
            updatedAt: note.updatedAt,
            sortOrder: 0,
            depth: 1,
          }));
      setNotebooks(tree.notebooks);
      setResources(unified);
      setNeedsSecret(false);
      setActiveNodeId((current) => current && unified.some((resource) => resource.nodeId === current)
        ? current
        : unified[0]?.nodeId || "");
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
    if (!activeNodeId || needsSecret) {
      setActiveResource(null);
      setComments([]);
      return;
    }
    let cancelled = false;
    setResourceLoading(true);
    notebookPublicationApi.getPublicResource(token, activeNodeId, accessToken || undefined)
      .then(async (resource) => {
        if (cancelled) return;
        setActiveResource(resource);
        const canComment = resource.resourceType !== "mindmap"
          && info
          && (info.allowComment || info.permission !== "read");
        const nextComments = canComment
          ? await notebookPublicationApi.getComments(token, resource.resourceId, accessToken || undefined).catch(() => [])
          : [];
        if (!cancelled) setComments(nextComments);
      })
      .catch((err: any) => {
        if (!cancelled) {
          setActiveResource(null);
          setComments([]);
          toast.error(err?.message || "内容加载失败");
        }
      })
      .finally(() => {
        if (!cancelled) setResourceLoading(false);
      });
    return () => { cancelled = true; };
  }, [token, activeNodeId, accessToken, needsSecret, info]);

  useEffect(() => {
    const host = contentRef.current;
    if (!host || !activeResource || activeResource.resourceType !== "note") {
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
  }, [activeResource]);

  const filteredResources = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword
      ? resources.filter((resource) =>
          `${resource.title} ${resource.contentText || ""}`.toLowerCase().includes(keyword))
      : resources;
  }, [resources, query]);

  const resourcesByNotebook = useMemo(() => {
    const grouped = new Map<string, PublicKnowledgeResourceSummary[]>();
    for (const resource of filteredResources) {
      if (!resource.notebookId) continue;
      const list = grouped.get(resource.notebookId) || [];
      list.push(resource);
      grouped.set(resource.notebookId, list);
    }
    return grouped;
  }, [filteredResources]);

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
    if (!activeResource || activeResource.resourceType === "mindmap" || !nickname.trim() || !commentText.trim()) return;
    setCommenting(true);
    try {
      const created = await notebookPublicationApi.addComment(
        token,
        activeResource.resourceId,
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
      navigateToAppPath("/");
    } catch (err: any) {
      toast.error(err?.message || "加入失败");
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2.5 bg-gradient-to-br from-slate-50 via-app-bg to-indigo-50/40 text-sm text-tx-secondary dark:from-[#070a12] dark:via-app-bg dark:to-[#0d1324]">
        <Loader2 size={18} className="animate-spin text-accent-primary" />正在加载知识库
      </div>
    );
  }

  if (error || !info) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-slate-50 via-indigo-50/40 to-sky-50/50 px-5 text-tx-primary dark:from-[#070a12] dark:via-[#0b1020] dark:to-[#0a1322]">
        <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-white/75 bg-white/85 p-7 text-center shadow-[0_24px_64px_-20px_rgba(15,23,42,0.16)] backdrop-blur-2xl dark:border-white/[0.09] dark:bg-zinc-900/78">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-rose-500/50 to-transparent" />
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-500/12 text-rose-500 ring-1 ring-inset ring-rose-500/20">
            <LockKeyhole size={26} />
          </div>
          <h1 className="text-base font-bold tracking-tight">无法访问公共知识库</h1>
          <p className="mt-2 text-sm text-tx-secondary">{error || "发布不存在或已被撤销"}</p>
          <Button variant="outline" className="mt-5 rounded-xl" onClick={() => navigateToAppPath("/public")}>返回公共空间</Button>
        </div>
      </div>
    );
  }

  if (needsSecret) {
    return (
      <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-slate-50 via-indigo-50/40 to-sky-50/50 px-4 text-tx-primary dark:from-[#070a12] dark:via-[#0b1020] dark:to-[#0a1322]">
        <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
          <div className="absolute -top-36 -left-24 h-96 w-96 rounded-full bg-indigo-400/16 blur-3xl dark:bg-indigo-500/22" />
          <div className="absolute -bottom-36 -right-24 h-96 w-96 rounded-full bg-amber-400/12 blur-3xl dark:bg-violet-500/16" />
        </div>
        <div className="relative w-full max-w-sm overflow-hidden rounded-[28px] border border-white/75 bg-white/85 p-7 shadow-[0_24px_64px_-20px_rgba(15,23,42,0.16)] backdrop-blur-2xl dark:border-white/[0.09] dark:bg-zinc-900/78 dark:shadow-[0_28px_72px_-16px_rgba(0,0,0,0.68)]">
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-indigo-500/60 to-transparent" />
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/18 to-sky-500/15 text-accent-primary ring-1 ring-inset ring-accent-primary/25 shadow-sm">
            {info.accessMode === "code" ? <KeyRound size={24} /> : <LockKeyhole size={24} />}
          </div>
          <h1 className="mt-4 text-center text-lg font-bold tracking-tight">{info.icon || "📚"} {info.name}</h1>
          <p className="mt-1.5 text-center text-sm text-tx-tertiary">请输入{info.secretLabel || "访问凭证"}后浏览目录和正文</p>
          <Input
            type={info.accessMode === "password" ? "password" : "text"}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void verifySecret(); }}
            placeholder={info.accessMode === "code" ? "输入访问码" : "输入访问密码"}
            className="mt-5 rounded-xl"
            autoFocus
          />
          <Button className="mt-3 w-full rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/25 hover:from-indigo-500 hover:to-violet-500" onClick={verifySecret} disabled={!secret.trim()}>验证并进入</Button>
          <button className="mt-4 w-full text-center text-xs font-medium text-tx-tertiary transition-colors hover:text-accent-primary" onClick={() => navigateToAppPath("/public")}>返回公共空间</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen min-h-0 bg-gradient-to-br from-slate-50 via-app-bg to-indigo-50/35 text-tx-primary dark:from-[#070a12] dark:via-app-bg dark:to-[#0d1324]">
      <aside className="hidden w-[288px] shrink-0 flex-col border-r border-app-border/75 bg-app-surface/82 backdrop-blur-xl md:flex">
        <div className="border-b border-app-border/70 p-4">
          <button className="group flex min-w-0 items-center gap-3 text-left" onClick={() => navigateToAppPath("/public")}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/14 to-sky-500/12 text-xl ring-1 ring-inset ring-app-border/70 transition-transform group-hover:scale-105">{info.icon || "📚"}</div>
            <div className="min-w-0"><div className="truncate text-sm font-bold tracking-tight group-hover:text-accent-primary">{info.name}</div><div className="truncate text-[11px] text-tx-tertiary">{info.ownerDisplayName || info.ownerUsername} 的公共知识库</div></div>
          </button>
          <div className="relative mt-4">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-tx-tertiary" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索笔记、脑图和表格" className="h-9 rounded-xl pl-9 text-xs" />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2.5">
          {notebooks.map((notebook) => {
            const children = resourcesByNotebook.get(notebook.id) || [];
            if (query.trim() && children.length === 0) return null;
            return (
              <div key={notebook.id} className="mb-1.5">
                <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-semibold text-tx-secondary" style={{ paddingLeft: `${8 + notebook.depth * 14}px` }}><span>{notebook.icon || "📁"}</span><span className="truncate">{notebook.name}</span></div>
                {children.map((resource) => (
                  <button
                    key={resource.nodeId}
                    type="button"
                    onClick={() => setActiveNodeId(resource.nodeId)}
                    className={cn("mb-0.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-all", activeNodeId === resource.nodeId ? "bg-gradient-to-r from-indigo-500/14 to-violet-500/8 font-semibold text-accent-primary ring-1 ring-inset ring-accent-primary/20" : "text-tx-secondary hover:bg-app-hover/80 hover:text-tx-primary")}
                    style={{ paddingLeft: `${22 + notebook.depth * 14}px` }}
                    title={resourceLabel(resource.resourceType)}
                  >
                    <ResourceIcon type={resource.resourceType} />
                    <span className="truncate">{resource.title || "无标题内容"}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
        <div className="border-t border-app-border/70 p-3">
          <Button variant="outline" className="w-full rounded-xl border-app-border/80 bg-app-surface/90 shadow-sm hover:-translate-y-[1px] hover:border-accent-primary/40 hover:text-accent-primary" onClick={join} disabled={joining}>
            {joining ? <Loader2 size={14} className="mr-1 animate-spin" /> : <UserPlus size={14} className="mr-1" />}
            {info.permission === "write" && info.allowEdit ? "登录并加入编辑" : "加入共享笔记本"}
          </Button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 border-b border-app-border/75 bg-app-surface/85 px-4 py-3 backdrop-blur-2xl md:hidden">
          <div className="flex items-center justify-between gap-3">
            <button className="flex min-w-0 items-center gap-2" onClick={() => navigateToAppPath("/public")}><BookOpen size={17} className="text-accent-primary" /><span className="truncate text-sm font-bold">{info.name}</span></button>
            <Button size="sm" variant="outline" className="rounded-xl" onClick={join}><UserPlus size={13} className="mr-1" />加入</Button>
          </div>
          <select className="mt-3 h-9 w-full rounded-xl border border-app-border/80 bg-app-bg/90 px-3 text-xs" value={activeNodeId} onChange={(event) => setActiveNodeId(event.target.value)}>
            {filteredResources.map((resource) => <option key={resource.nodeId} value={resource.nodeId}>[{resourceLabel(resource.resourceType)}] {resource.title || "无标题内容"}</option>)}
          </select>
        </header>

        <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-6 px-4 py-6 sm:px-6 sm:py-8 lg:grid-cols-[minmax(0,1fr)_232px]">
          <article className="min-w-0 rounded-[24px] border border-app-border/75 bg-app-surface/88 p-5 shadow-[0_14px_40px_-24px_rgba(15,23,42,0.16)] backdrop-blur-md sm:p-9 dark:shadow-[0_20px_52px_-24px_rgba(0,0,0,0.65)]">
            {resourceLoading ? (
              <div className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-tx-secondary"><Loader2 size={16} className="animate-spin text-accent-primary" />正在加载内容</div>
            ) : !activeResource ? (
              <div className="flex min-h-[50vh] flex-col items-center justify-center text-center text-tx-tertiary"><FileText size={32} className="mb-3" /><p className="text-sm">这个目录暂时没有可公开浏览的内容</p></div>
            ) : (
              <>
                <div className="mb-7 border-b border-app-border/70 pb-5">
                  <div className="mb-2.5 flex flex-wrap items-center gap-2 text-[11px] text-tx-tertiary">
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2.5 py-0.5 font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-300"><ShieldCheck size={11} />已发布</span>
                    <span className="rounded-full bg-app-hover/80 px-2 py-0.5 font-medium text-tx-secondary">{resourceLabel(activeResource.resourceType)}</span>
                    <span>更新于 {formatAppDateTime(activeResource.updatedAt, undefined, undefined, "zh-CN")}</span>
                    {!activeResource.allowDownload && activeResource.resourceType === "note" && <span>· 未开放附件下载</span>}
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">{activeResource.title || "无标题内容"}</h1>
                </div>
                <div ref={contentRef} className="public-notebook-content min-h-[240px]">
                  <PublicKnowledgeResourceRenderer resource={activeResource} />
                </div>

                {activeResource.resourceType !== "mindmap" && (activeResource.allowComment || info.permission !== "read") && (
                  <section className="mt-12 border-t border-app-border/70 pt-7">
                    <h2 className="flex items-center gap-2 text-sm font-bold"><MessageCircle size={16} className="text-accent-primary" />评论 {comments.length > 0 ? `(${comments.length})` : ""}</h2>
                    <div className="mt-4 space-y-3">
                      {comments.map((comment) => (
                        <div key={comment.id} className="rounded-2xl border border-app-border/70 bg-app-bg/70 p-3.5 shadow-sm">
                          <div className="flex items-center justify-between gap-3 text-xs"><span className="font-semibold text-tx-primary">{comment.nickname}</span><span className="font-mono text-[11px] text-tx-tertiary">{formatAppDateTime(comment.createdAt, undefined, undefined, "zh-CN")}</span></div>
                          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-tx-secondary">{comment.content}</p>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-[160px_1fr_auto]">
                      <Input value={nickname} onChange={(event) => setNickname(event.target.value)} placeholder="你的昵称" maxLength={32} className="rounded-xl" />
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
                      <Input value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="写下评论…" maxLength={1000} className="rounded-xl" onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitComment(); } }} />
                      <Button className="rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 text-white shadow-sm hover:from-indigo-500 hover:to-violet-500" onClick={submitComment} disabled={commenting || !nickname.trim() || !commentText.trim()}>{commenting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}</Button>
                    </div>
                  </section>
                )}
              </>
            )}
          </article>

          <aside className="hidden lg:block">
            <div className="sticky top-8 rounded-2xl border border-app-border/75 bg-app-surface/85 p-3.5 shadow-sm backdrop-blur-md">
              <div className="mb-2.5 flex items-center gap-2 px-1 text-xs font-bold text-tx-secondary"><ListTree size={14} className="text-accent-primary" />本页大纲</div>
              {outline.length === 0 ? <p className="px-1 py-2 text-xs text-tx-tertiary">{activeResource?.resourceType === "note" ? "当前文档没有标题层级" : "当前资源使用专属只读视图"}</p> : (
                <div className="space-y-0.5">
                  {outline.map((item) => <button key={item.id} type="button" onClick={() => document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" })} className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-xs text-tx-secondary transition-colors hover:bg-app-hover hover:text-accent-primary" style={{ paddingLeft: `${8 + (item.level - 1) * 10}px` }}>{item.text}</button>)}
                </div>
              )}
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}
