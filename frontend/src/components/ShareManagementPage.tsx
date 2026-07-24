import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  FileText,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import ShareModal from "@/components/ShareModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/components/ui/confirm";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { api } from "@/lib/api";
import {
  buildPublicWebUrl,
  getPublicWebOriginSourceLabel,
  resolvePublicWebOrigin,
} from "@/lib/publicWebOrigin";
import {
  compactShareToken,
  formatShareDate,
  normalizeShareManagementResponse,
  sharePermissionLabel,
  shareStatusMeta,
} from "@/lib/shareManagement";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAppActions } from "@/store/AppContext";
import type {
  ShareEffectiveStatus,
  ShareManagementItem,
  ShareManagementResponse,
  SharePermission,
} from "@/types";

const PAGE_SIZE = 20;

type PasswordFilter = "all" | "yes" | "no";
type SortKey = "updatedAt" | "createdAt" | "expiresAt" | "noteTitle";

function StatusBadge({ status }: { status: ShareEffectiveStatus }) {
  const meta = shareStatusMeta(status);
  return <span className={cn("inline-flex rounded-full border px-2 py-0.5 text-xs font-medium", meta.className)}>{meta.label}</span>;
}

function IconAction({ label, onClick, danger = false, children }: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-lg border border-app-border bg-app-surface transition-colors hover:bg-app-hover",
        danger ? "text-rose-600 dark:text-rose-300" : "text-tx-secondary hover:text-tx-primary",
      )}
    >
      {children}
    </button>
  );
}

export default function ShareManagementPage() {
  const actions = useAppActions();
  const { siteConfig } = useSiteSettings();
  const [data, setData] = useState<ShareManagementResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | ShareEffectiveStatus>("all");
  const [permission, setPermission] = useState<"all" | SharePermission>("all");
  const [password, setPassword] = useState<PasswordFilter>("all");
  const [sort, setSort] = useState<SortKey>("updatedAt");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<ShareManagementItem | null>(null);
  const requestSequence = useRef(0);

  const publicOrigin = resolvePublicWebOrigin({
    runtimeOrigin: siteConfig.publicWebOrigin,
    runtimeSource: siteConfig.publicWebOriginSource,
  });
  const originOptions = {
    runtimeOrigin: siteConfig.publicWebOrigin,
    runtimeSource: siteConfig.publicWebOriginSource,
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setQuery(searchDraft.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  const load = useCallback(async (silent = false) => {
    const sequence = ++requestSequence.current;
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const response = await api.getShareManagement({
        q: query || undefined,
        status: status === "all" ? undefined : status,
        permission: permission === "all" ? undefined : permission,
        hasPassword: password === "all" ? undefined : password === "yes",
        sort,
        order,
        page,
        pageSize: PAGE_SIZE,
      });
      if (sequence === requestSequence.current) {
        setData(normalizeShareManagementResponse(response, page, PAGE_SIZE));
      }
    } catch (loadError: any) {
      if (sequence === requestSequence.current) {
        setError(loadError?.message || "加载分享列表失败");
      }
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [order, page, password, permission, query, sort, status]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const onWorkspaceChanged = () => {
      setPage(1);
      void load(true);
    };
    window.addEventListener("nowen:workspace-changed", onWorkspaceChanged);
    return () => window.removeEventListener("nowen:workspace-changed", onWorkspaceChanged);
  }, [load]);

  const pageCount = Math.max(1, Math.ceil((data?.total || 0) / PAGE_SIZE));
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const stats = data?.stats || { total: 0, active: 0, disabled: 0, expired: 0, exhausted: 0 };
  const statCards = useMemo(() => [
    { label: "分享总数", value: stats.total, className: "text-tx-primary" },
    { label: "当前启用", value: stats.active, className: "text-emerald-600 dark:text-emerald-300" },
    { label: "已停用", value: stats.disabled, className: "text-zinc-600 dark:text-zinc-300" },
    { label: "需要处理", value: stats.expired + stats.exhausted, className: "text-amber-600 dark:text-amber-300" },
  ], [stats]);

  const shareUrl = (item: ShareManagementItem) => buildPublicWebUrl(`/share/${item.shareToken}`, originOptions);

  const copyLink = async (item: ShareManagementItem) => {
    try {
      await navigator.clipboard.writeText(shareUrl(item));
      toast.success("分享链接已复制");
    } catch {
      toast.error("复制失败，请手动复制");
    }
  };

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    try {
      await action();
      toast.success(success);
      await load(true);
    } catch (mutationError: any) {
      toast.error(mutationError?.message || "操作失败");
    }
  };

  const toggleShare = async (item: ShareManagementItem) => {
    const active = Boolean(item.isActive);
    if (active) {
      const accepted = await confirm({
        title: "停用分享链接？",
        description: "访客将立即无法访问正文、评论和附件，但分享记录仍会保留。",
        danger: true,
      });
      if (!accepted) return;
    }
    await mutate(
      () => api.updateShare(item.id, { isActive: active ? 0 : 1 }),
      active ? "分享已停用" : "分享已启用",
    );
  };

  const rotateShare = async (item: ShareManagementItem) => {
    const accepted = await confirm({
      title: "轮换分享链接？",
      description: "旧链接和已签发的密码访问令牌会立即失效，访问会话数同时清零。",
      danger: true,
    });
    if (!accepted) return;
    await mutate(() => api.updateShare(item.id, { rotateToken: true }), "已生成新的分享链接");
  };

  const resetViews = async (item: ShareManagementItem) => {
    const accepted = await confirm({
      title: "重置访问会话数？",
      description: "当前访问会话数将清零，访客可重新占用访问名额。",
    });
    if (!accepted) return;
    await mutate(() => api.updateShare(item.id, { resetViews: true }), "访问会话数已重置");
  };

  const removeShare = async (item: ShareManagementItem) => {
    const accepted = await confirm({
      title: "删除分享链接？",
      description: "链接、评论访问和附件签名将立即失效，此操作不可撤销。",
      danger: true,
    });
    if (!accepted) return;
    await mutate(() => api.deleteShare(item.id), "分享已删除");
  };

  const openNote = async (item: ShareManagementItem) => {
    if (item.noteMissing || item.noteIsTrashed) {
      toast.warning(item.noteMissing ? "原笔记已不存在" : "原笔记位于回收站中");
      return;
    }
    try {
      const note = await api.getNote(item.noteId);
      actions.setActiveNote(note);
      actions.setViewMode("all");
      actions.setMobileView("editor");
    } catch (openError: any) {
      toast.error(openError?.message || "无法打开原笔记");
    }
  };

  const renderActions = (item: ShareManagementItem) => (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <IconAction label="复制链接" onClick={() => void copyLink(item)}><Copy size={14} /></IconAction>
      <IconAction label="打开分享" onClick={() => window.open(shareUrl(item), "_blank", "noopener,noreferrer")}><ExternalLink size={14} /></IconAction>
      <IconAction label="打开原笔记" onClick={() => void openNote(item)}><FileText size={14} /></IconAction>
      <IconAction label="编辑分享" onClick={() => setEditing(item)}><Pencil size={14} /></IconAction>
      <IconAction label={item.isActive ? "停用分享" : "启用分享"} onClick={() => void toggleShare(item)}>
        {item.isActive ? <PowerOff size={14} /> : <Power size={14} />}
      </IconAction>
      <IconAction label="重置访问次数" onClick={() => void resetViews(item)}><RefreshCw size={14} /></IconAction>
      <IconAction label="轮换链接" onClick={() => void rotateShare(item)}><RotateCcw size={14} /></IconAction>
      <IconAction label="删除分享" danger onClick={() => void removeShare(item)}><Trash2 size={14} /></IconAction>
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-app-bg">
      <div className="mx-auto w-full max-w-[1500px] space-y-5 px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2"><Link2 size={22} className="text-accent-primary" /><h1 className="text-xl font-semibold text-tx-primary">分享管理</h1></div>
            <p className="mt-1 text-sm text-tx-secondary">集中查看、修改、停用和清理当前账号可管理的分享链接。</p>
          </div>
          <Button variant="outline" onClick={() => void load(true)} disabled={refreshing}>
            {refreshing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <RefreshCw size={15} className="mr-2" />}
            刷新
          </Button>
        </header>

        {publicOrigin.requiresAnonymousCheck && (
          <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle size={17} className="mt-0.5 shrink-0" />
            <div>
              <p>当前公开分享地址可能依赖内网、VPN 或登录网关，请用无痕窗口或未登录设备验证。</p>
              <p className="mt-1 break-all text-xs opacity-80">地址来源：{getPublicWebOriginSourceLabel(publicOrigin.source)} · {publicOrigin.origin || "相对地址"}</p>
            </div>
          </div>
        )}

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {statCards.map((card) => (
            <div key={card.label} className="rounded-xl border border-app-border bg-app-surface px-4 py-3 shadow-sm">
              <p className="text-xs text-tx-tertiary">{card.label}</p>
              <p className={cn("mt-1 text-2xl font-semibold", card.className)}>{card.value}</p>
            </div>
          ))}
        </section>

        <section className="rounded-xl border border-app-border bg-app-surface p-3 shadow-sm">
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.5fr)_repeat(5,minmax(130px,1fr))]">
            <label className="relative block">
              <Search size={15} className="pointer-events-none absolute left-3 top-2.5 text-tx-tertiary" />
              <Input aria-label="搜索分享" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="搜索笔记标题或 Token" className="h-9 pl-9" />
            </label>
            <select aria-label="按状态筛选" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as typeof status); }} className="h-9 rounded-lg border border-app-border bg-app-bg px-3 text-sm">
              <option value="all">全部状态</option><option value="active">正常</option><option value="disabled">已停用</option><option value="expired">已过期</option><option value="exhausted">次数耗尽</option>
            </select>
            <select aria-label="按权限筛选" value={permission} onChange={(event) => { setPage(1); setPermission(event.target.value as typeof permission); }} className="h-9 rounded-lg border border-app-border bg-app-bg px-3 text-sm">
              <option value="all">全部权限</option><option value="view">仅查看</option><option value="comment">可评论</option><option value="edit">访客可编辑</option><option value="edit_auth">登录后可编辑</option>
            </select>
            <select aria-label="按密码筛选" value={password} onChange={(event) => { setPage(1); setPassword(event.target.value as PasswordFilter); }} className="h-9 rounded-lg border border-app-border bg-app-bg px-3 text-sm">
              <option value="all">全部密码状态</option><option value="yes">已设密码</option><option value="no">无密码</option>
            </select>
            <select aria-label="排序字段" value={sort} onChange={(event) => { setPage(1); setSort(event.target.value as SortKey); }} className="h-9 rounded-lg border border-app-border bg-app-bg px-3 text-sm">
              <option value="updatedAt">按更新时间</option><option value="createdAt">按创建时间</option><option value="expiresAt">按过期时间</option><option value="noteTitle">按笔记标题</option>
            </select>
            <select aria-label="排序方向" value={order} onChange={(event) => { setPage(1); setOrder(event.target.value as "asc" | "desc"); }} className="h-9 rounded-lg border border-app-border bg-app-bg px-3 text-sm">
              <option value="desc">降序</option><option value="asc">升序</option>
            </select>
          </div>
        </section>

        {loading ? (
          <div className="flex min-h-64 items-center justify-center text-sm text-tx-secondary"><Loader2 size={18} className="mr-2 animate-spin" />正在加载分享链接…</div>
        ) : error ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-rose-500/30 bg-rose-500/5 px-6 text-center">
            <p className="text-sm text-rose-700 dark:text-rose-300">{error}</p><Button className="mt-3" variant="outline" onClick={() => void load()}>重试</Button>
          </div>
        ) : !data?.items?.length ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed border-app-border bg-app-surface px-6 text-center">
            <Link2 size={30} className="text-tx-tertiary" /><h2 className="mt-3 font-medium text-tx-primary">还没有符合条件的分享链接</h2><p className="mt-1 text-sm text-tx-secondary">打开任意笔记并点击“分享”，创建后的链接会统一显示在这里。</p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-sm lg:block">
              <table className="w-full table-fixed text-left text-sm">
                <thead className="bg-app-hover/70 text-xs text-tx-secondary"><tr><th className="w-[24%] px-4 py-3">笔记 / 链接</th><th className="w-[10%] px-3 py-3">状态</th><th className="w-[12%] px-3 py-3">权限</th><th className="w-[13%] px-3 py-3">安全</th><th className="w-[13%] px-3 py-3">访问</th><th className="w-[14%] px-3 py-3">过期时间</th><th className="w-[14%] px-4 py-3 text-right">操作</th></tr></thead>
                <tbody className="divide-y divide-app-border">
                  {data.items.map((item) => (
                    <tr key={item.id} className="align-top hover:bg-app-hover/40">
                      <td className="px-4 py-3"><button className="max-w-full truncate font-medium text-tx-primary hover:text-accent-primary" onClick={() => void openNote(item)}>{item.noteTitle || "原笔记已删除"}</button><p className="mt-1 font-mono text-xs text-tx-tertiary" title={item.shareToken}>{compactShareToken(item.shareToken)}</p><p className="mt-1 truncate text-xs text-tx-tertiary">{item.workspaceName || "个人空间"}{item.notebookName ? ` / ${item.notebookName}` : ""}</p></td>
                      <td className="px-3 py-3"><StatusBadge status={item.effectiveStatus} />{(item.noteMissing || item.noteIsTrashed) && <p className="mt-2 text-xs text-rose-600">{item.noteMissing ? "原笔记缺失" : "位于回收站"}</p>}</td>
                      <td className="px-3 py-3 text-tx-secondary">{sharePermissionLabel(item.permission)}</td>
                      <td className="px-3 py-3 text-tx-secondary"><span className="inline-flex items-center gap-1">{item.hasPassword ? <><KeyRound size={14} />已设密码</> : "无密码"}</span></td>
                      <td className="px-3 py-3 text-tx-secondary">{item.viewCount} / {item.maxViews ?? "不限"}</td>
                      <td className="px-3 py-3 text-xs text-tx-secondary">{formatShareDate(item.expiresAt)}</td>
                      <td className="px-4 py-3">{renderActions(item)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-3 lg:hidden">
              {data.items.map((item) => (
                <article key={item.id} className="rounded-xl border border-app-border bg-app-surface p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><button className="max-w-full truncate text-left font-medium text-tx-primary" onClick={() => void openNote(item)}>{item.noteTitle || "原笔记已删除"}</button><p className="mt-1 font-mono text-xs text-tx-tertiary">{compactShareToken(item.shareToken)}</p></div><StatusBadge status={item.effectiveStatus} /></div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs"><div><dt className="text-tx-tertiary">权限</dt><dd className="mt-0.5 text-tx-secondary">{sharePermissionLabel(item.permission)}</dd></div><div><dt className="text-tx-tertiary">访问会话</dt><dd className="mt-0.5 text-tx-secondary">{item.viewCount} / {item.maxViews ?? "不限"}</dd></div><div><dt className="text-tx-tertiary">密码</dt><dd className="mt-0.5 text-tx-secondary">{item.hasPassword ? "已设置" : "未设置"}</dd></div><div><dt className="text-tx-tertiary">过期时间</dt><dd className="mt-0.5 text-tx-secondary">{formatShareDate(item.expiresAt)}</dd></div></dl>
                  {(item.noteMissing || item.noteIsTrashed) && <p className="mt-3 text-xs text-rose-600">{item.noteMissing ? "原笔记已不存在，但仍可停用或删除此分享。" : "原笔记位于回收站中。"}</p>}
                  <div className="mt-4 border-t border-app-border pt-3">{renderActions(item)}</div>
                </article>
              ))}
            </div>
          </>
        )}

        {!loading && !error && (data?.total || 0) > 0 && (
          <footer className="flex flex-col gap-2 text-sm text-tx-secondary sm:flex-row sm:items-center sm:justify-between">
            <span>共 {data?.total || 0} 条，第 {page} / {pageCount} 页</span>
            <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button><Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</Button></div>
          </footer>
        )}
      </div>

      {editing && (
        <ShareModal
          noteId={editing.noteId}
          noteTitle={editing.noteTitle || "原笔记已删除"}
          initialShareId={editing.id}
          onClose={() => { setEditing(null); void load(true); }}
        />
      )}
    </div>
  );
}
