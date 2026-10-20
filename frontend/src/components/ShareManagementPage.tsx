import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
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
  X,
  MoreHorizontal,
  SlidersHorizontal,
} from "lucide-react";
import { createPortal } from "react-dom";
import "./ShareManagementPage.css";
import ShareModal from "@/components/ShareModal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirm } from "@/components/ui/confirm";
import { useSiteSettings } from "@/hooks/useSiteSettings";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import {
  buildPublicWebUrl,
  getPublicWebOriginSourceLabel,
  resolvePublicWebOrigin,
  type PublicWebOriginResolution,
} from "@/lib/publicWebOrigin";
import {
  compactShareToken,
  formatShareDate,
  normalizeShareManagementResponse,
  sharePermissionLabel,
  shareStatusMeta,
} from "@/lib/shareManagement";
import { toast } from "@/lib/toast";
import { openCommentCenter } from "@/lib/noteCommentNavigation";
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

function ShareActions({ item, onCopy, onEdit, items }: {
  item: ShareManagementItem;
  onCopy: () => void;
  onEdit: () => void;
  items: { label: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const anchor = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(anchor.right - menu.width, window.innerWidth - menu.width - 8)),
      top: anchor.bottom + menu.height + 8 <= window.innerHeight
        ? anchor.bottom + 4 : Math.max(8, anchor.top - menu.height - 4),
    });
    menuRef.current.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close();
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close();
    };
    const resize = () => close();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(true); return; }
      if (event.key === "Tab") { close(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [close, open]);

  return (
    <div className="share-actions flex shrink-0 items-center justify-end gap-1">
      <button type="button" aria-label="复制链接" title="复制链接" onClick={onCopy} className="share-primary-action"><Copy size={15} /><span className="share-action-label">复制链接</span></button>
      <button type="button" aria-label="编辑分享" title="编辑分享" onClick={onEdit} className="share-primary-action"><Pencil size={15} /><span className="share-action-label">设置</span></button>
      <button ref={triggerRef} type="button" aria-label="更多分享操作" title="更多分享操作" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(value => !value)} className="share-more-action"><MoreHorizontal size={17} /></button>
      {open && createPortal(
        <div ref={menuRef} id={menuId} role="menu" aria-label={`${item.noteTitle || "分享链接"}的更多操作`} style={position} className="fixed z-[100] w-56 max-w-[calc(100vw-16px)] max-h-[min(360px,calc(100dvh-16px))] overflow-y-auto rounded-xl border border-app-border bg-app-elevated p-1 shadow-lg">
          <div className="border-b border-app-border px-3 py-2 text-xs text-tx-tertiary"><span>链接标识</span><code className="mt-1 block truncate" title={item.shareToken}>{compactShareToken(item.shareToken)}</code></div>
          {items.map(action => <button key={action.label} role="menuitem" type="button" onClick={() => { close(true); action.onClick(); }} className={cn("flex h-10 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-app-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary", action.danger ? "text-accent-danger" : "text-tx-secondary hover:text-tx-primary")}>
            {action.icon}{action.label}
          </button>)}
        </div>, document.body,
      )}
    </div>
  );
}

function getOriginRiskCopy(publicOrigin: PublicWebOriginResolution) {
  switch (publicOrigin.risk) {
    case "localhost":
      return {
        label: "分享地址仅本机可访问",
        message: "当前分享地址为 localhost，仅本机可访问。",
      };
    case "private-network":
      return {
        label: "分享地址可能仅限内网",
        message: "当前分享地址可能仅限局域网或 VPN 内访问，外部访客可能无法打开。",
      };
    case "protected-gateway":
      return {
        label: "分享地址可能需要登录",
        message: "当前分享地址可能经过登录网关，未登录访客可能无法打开。",
      };
    default:
      return {
        label: "公开地址待验证",
        message: "公开分享地址尚未验证，建议使用无痕窗口或未登录设备测试。",
      };
  }
}

function PublicOriginRiskControl({
  publicOrigin,
  configuredOrigin,
  updatePublicWebOrigin,
  variant,
}: {
  publicOrigin: PublicWebOriginResolution;
  configuredOrigin: string;
  updatePublicWebOrigin: (origin: string) => Promise<void>;
  variant: "banner" | "badge";
}) {
  const [open, setOpen] = useState(false);
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [originDraft, setOriginDraft] = useState(configuredOrigin);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const copy = getOriginRiskCopy(publicOrigin);

  useEffect(() => {
    let cancelled = false;
    api.getMe()
      .then((user) => {
        if (!cancelled) setCanManage(user.role === "admin");
      })
      .catch(() => {
        if (!cancelled) setCanManage(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setOriginDraft(configuredOrigin);
  }, [configuredOrigin]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown, { passive: true });
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const saveOrigin = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updatePublicWebOrigin(originDraft.trim());
      toast.success(originDraft.trim() ? "公开分享地址已保存" : "已恢复容器环境变量或当前访问域名");
      setOpen(false);
    } catch (error: any) {
      toast.error(error?.message || "公开分享地址保存失败");
    } finally {
      setSaving(false);
    }
  };

  const copyOrigin = async () => {
    if (!publicOrigin.origin) return;
    const ok = await copyText(publicOrigin.origin);
    if (ok) {
      toast.success("公开分享地址已复制");
    } else {
      toast.error("复制失败，请手动复制");
    }
  };

  const panel = open && (
    <div
      role="dialog"
      aria-label="公开分享地址详情"
      className={cn(
        "absolute z-40 mt-2 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-app-border bg-app-elevated p-4 text-left shadow-xl",
        variant === "banner" ? "left-0 sm:left-auto sm:right-0" : "right-0",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-tx-primary">{copy.label}</p>
          <p className="mt-1 text-xs leading-5 text-tx-secondary">{copy.message}</p>
        </div>
        <button
          type="button"
          aria-label="关闭公开地址详情"
          onClick={() => setOpen(false)}
          className="rounded-md p-1 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
        >
          <X size={15} />
        </button>
      </div>

      <div className="mt-3 rounded-lg bg-app-hover/60 p-3">
        <div className="flex items-center justify-between gap-3 text-[11px] text-tx-tertiary">
          <span>地址来源</span>
          <span>{getPublicWebOriginSourceLabel(publicOrigin.source)}</span>
        </div>
        <div className="mt-2 flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all text-xs text-tx-secondary">
            {publicOrigin.origin || "相对地址"}
          </code>
          {publicOrigin.origin && (
            <button
              type="button"
              aria-label="复制公开分享地址"
              title="复制公开分享地址"
              onClick={() => void copyOrigin()}
              className="shrink-0 rounded-md p-1 text-tx-tertiary transition-colors hover:bg-app-surface hover:text-tx-primary"
            >
              <Copy size={14} />
            </button>
          )}
        </div>
      </div>

      {canManage ? (
        <div className="mt-3">
          <label className="text-xs font-medium text-tx-secondary" htmlFor="share-public-origin">
            独立公开地址
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="share-public-origin"
              value={originDraft}
              onChange={(event) => setOriginDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveOrigin();
              }}
              placeholder="https://note.example.com"
              className="h-9 min-w-0 flex-1 text-xs"
            />
            <Button size="sm" disabled={saving} onClick={() => void saveOrigin()} className="h-9 shrink-0">
              {saving && <Loader2 size={13} className="mr-1 animate-spin" />}
              保存
            </Button>
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-tx-tertiary">
            留空后优先恢复容器 PUBLIC_WEB_ORIGIN；仍未配置时使用当前访问域名。
          </p>
        </div>
      ) : canManage === false ? (
        <p className="mt-3 text-xs leading-5 text-tx-tertiary">
          当前账号无权修改，请让管理员配置独立公开地址或 PUBLIC_WEB_ORIGIN。
        </p>
      ) : (
        <div className="mt-3 flex items-center text-xs text-tx-tertiary">
          <Loader2 size={13} className="mr-1.5 animate-spin" />
          正在检查配置权限…
        </div>
      )}

      <p className="mt-3 border-t border-app-border pt-3 text-[11px] leading-4 text-tx-tertiary">
        配置完成后，仍建议使用无痕窗口或未登录设备验证一次。
      </p>
    </div>
  );

  if (variant === "banner") {
    return (
      <div ref={rootRef} className="relative">
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/25 bg-amber-500/[0.07] px-3 py-1 text-xs text-amber-800 sm:flex-row sm:items-center sm:justify-between dark:text-amber-200">
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangle size={16} className="shrink-0" />
            <span className="share-origin-full leading-5">{copy.message}</span><span className="share-origin-short leading-5" title={copy.message}>{copy.label}</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="ml-auto h-10 shrink-0 sm:h-8 self-start rounded-md px-1.5 py-0.5 text-xs font-medium underline-offset-4 transition-colors hover:bg-amber-500/10 hover:underline sm:self-auto"
          >
            配置公开地址
          </button>
        </div>
        {panel}
      </div>
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/10 dark:text-amber-200"
      >
        <AlertTriangle size={14} />
        {copy.label}
      </button>
      {panel}
    </div>
  );
}

export default function ShareManagementPage() {
  const actions = useAppActions();
  const { siteConfig, updatePublicWebOrigin } = useSiteSettings();
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterId = useId();
  const filterButtonRef = useRef<HTMLButtonElement>(null);

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
  const statusTabs: { key: "all" | ShareEffectiveStatus; label: string; count: number }[] = [
    { key: "all", label: "全部", count: stats.total },
    { key: "active", label: "正常", count: stats.active },
    { key: "disabled", label: "已停用", count: stats.disabled },
    { key: "expired", label: "已过期", count: stats.expired },
    { key: "exhausted", label: "次数耗尽", count: stats.exhausted },
  ];
  const activeFilterCount = Number(permission !== "all") + Number(password !== "all");
  const hasFilters = Boolean(searchDraft.trim() || status !== "all" || activeFilterCount);
  const resetFilters = () => {
    setSearchDraft(""); setQuery(""); setStatus("all"); setPermission("all"); setPassword("all"); setPage(1);
  };

  const shareUrl = (item: ShareManagementItem) => buildPublicWebUrl(`/share/${item.shareToken}`, originOptions);

  const copyLink = async (item: ShareManagementItem) => {
    const ok = await copyText(shareUrl(item));
    if (ok) {
      toast.success("分享链接已复制");
    } else {
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
    <ShareActions item={item} onCopy={() => void copyLink(item)} onEdit={() => setEditing(item)} items={[
      { label: "打开分享", icon: <ExternalLink size={15} />, onClick: () => { window.open(shareUrl(item), "_blank", "noopener,noreferrer"); } },
      { label: "打开原笔记", icon: <FileText size={15} />, onClick: () => void openNote(item) },
      { label: item.isActive ? "停用分享" : "启用分享", icon: item.isActive ? <PowerOff size={15} /> : <Power size={15} />, onClick: () => void toggleShare(item) },
      { label: "重置访问次数", icon: <RefreshCw size={15} />, onClick: () => void resetViews(item) },
      { label: "轮换链接", icon: <RotateCcw size={15} />, onClick: () => void rotateShare(item) },
      { label: "删除分享", icon: <Trash2 size={15} />, danger: true, onClick: () => void removeShare(item) },
    ]} />
  );

  const showLocalhostBanner = publicOrigin.risk === "localhost";
  const showHeaderRisk = publicOrigin.risk !== "none" && !showLocalhostBanner;

  return (
    <div className="share-management min-h-0 min-w-0 flex-1 overflow-y-auto bg-app-bg">
      <div className="mx-auto w-full max-w-7xl space-y-3 px-4 py-4 sm:px-6" style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}>
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2"><Link2 size={20} className="text-accent-primary" /><h1 className="text-lg font-semibold text-tx-primary">分享管理</h1></div>
          </div>
          <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
            {showHeaderRisk && (
              <PublicOriginRiskControl
                publicOrigin={publicOrigin}
                configuredOrigin={siteConfig.publicWebOrigin}
                updatePublicWebOrigin={updatePublicWebOrigin}
                variant="badge"
              />
            )}
            <Button size="sm" variant="ghost" className="h-10" onClick={openCommentCenter}>评论管理</Button>
            <Button size="sm" variant="ghost" className="h-10" onClick={() => void load(true)} disabled={refreshing}>
              {refreshing ? <Loader2 size={15} className="mr-2 animate-spin" /> : <RefreshCw size={15} className="mr-2" />}
              刷新
            </Button>
          </div>
        </header>

        {showLocalhostBanner && (
          <PublicOriginRiskControl
            publicOrigin={publicOrigin}
            configuredOrigin={siteConfig.publicWebOrigin}
            updatePublicWebOrigin={updatePublicWebOrigin}
            variant="banner"
          />
        )}

        <section className="overflow-hidden rounded-xl border border-app-border bg-app-surface">
          <div role="group" aria-label="按状态筛选" className="flex items-center gap-1 overflow-x-auto border-b border-app-border px-2 py-1.5">
            {statusTabs.map(tab => <button key={tab.key} type="button" aria-label={tab.label} aria-pressed={status === tab.key} onClick={() => { setPage(1); setStatus(tab.key); }} className={cn("flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary", status === tab.key ? "bg-accent-primary/10 font-medium text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}>
              {tab.label}<span aria-hidden="true" className="text-xs tabular-nums opacity-70">{tab.count}</span>
            </button>)}
          </div>
          <div className="share-management-toolbar flex flex-wrap items-center gap-2 p-2">
            <label className="share-search-field relative min-w-[160px] flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-3 text-tx-tertiary" />
              <Input aria-label="搜索分享" value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="搜索笔记标题或链接标识" className="h-10 rounded-lg border-transparent bg-app-bg pl-9 text-sm" />
            </label>
            <Button ref={filterButtonRef} size="sm" variant="ghost" className="share-filter-toggle h-10 gap-1.5 rounded-lg" aria-label="筛选分享" aria-expanded={filtersOpen} aria-controls={filtersOpen ? filterId : undefined} onClick={() => setFiltersOpen(value => !value)}>
              <SlidersHorizontal size={15} />筛选{activeFilterCount > 0 && <span className="text-accent-primary">{activeFilterCount}</span>}
            </Button>
            <select aria-label="分享排序" value={`${sort}:${order}`} onChange={event => { const [field, direction] = event.target.value.split(":"); setPage(1); setSort(field as SortKey); setOrder(direction as "asc" | "desc"); }} className="h-10 max-w-full rounded-lg border border-app-border bg-app-bg px-2 text-xs text-tx-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
              <option value="updatedAt:desc">最近更新 ↓</option><option value="updatedAt:asc">最早更新 ↑</option>
              <option value="createdAt:desc">最新创建 ↓</option><option value="createdAt:asc">最早创建 ↑</option>
              <option value="expiresAt:asc">即将到期 ↑</option><option value="expiresAt:desc">最晚到期 ↓</option>
              <option value="noteTitle:asc">标题 A → Z</option><option value="noteTitle:desc">标题 Z → A</option>
            </select>
          </div>
          {filtersOpen && <div id={filterId} role="group" aria-label="分享筛选条件" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setFiltersOpen(false); filterButtonRef.current?.focus(); } }} className="flex flex-wrap items-end gap-3 border-t border-app-border bg-app-bg/50 p-3">
            <label className="min-w-[140px] flex-1 text-xs text-tx-secondary">权限
              <select aria-label="按权限筛选" value={permission} onChange={event => { setPage(1); setPermission(event.target.value as typeof permission); }} className="mt-1 block h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
                <option value="all">全部权限</option><option value="view">仅查看</option><option value="comment">可评论</option><option value="edit">访客可编辑</option><option value="edit_auth">登录后可编辑</option>
              </select>
            </label>
            <label className="min-w-[140px] flex-1 text-xs text-tx-secondary">密码保护
              <select aria-label="按密码筛选" value={password} onChange={event => { setPage(1); setPassword(event.target.value as PasswordFilter); }} className="mt-1 block h-10 w-full rounded-lg border border-app-border bg-app-surface px-3 text-sm text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">
                <option value="all">全部密码状态</option><option value="yes">已设密码</option><option value="no">无密码</option>
              </select>
            </label>
            <Button size="sm" variant="ghost" className="h-10" onClick={() => { setFiltersOpen(false); filterButtonRef.current?.focus(); }}>收起筛选</Button>
          </div>}
          {hasFilters && <div className="flex flex-wrap items-center gap-2 border-t border-app-border px-3 py-2 text-xs">
            {searchDraft.trim() && <button type="button" aria-label="清空搜索" onClick={() => { setSearchDraft(""); setQuery(""); setPage(1); }} className="share-filter-chip"><span className="max-w-48 truncate">搜索：{searchDraft.trim()}</span><X size={12} /></button>}
            {status !== "all" && <button type="button" aria-label="清除状态筛选" onClick={() => { setStatus("all"); setPage(1); }} className="share-filter-chip">{shareStatusMeta(status).label}<X size={12} /></button>}
            {permission !== "all" && <button type="button" aria-label="移除权限筛选" onClick={() => { setPermission("all"); setPage(1); }} className="share-filter-chip">{sharePermissionLabel(permission)}<X size={12} /></button>}
            {password !== "all" && <button type="button" aria-label="移除密码筛选" onClick={() => { setPassword("all"); setPage(1); }} className="share-filter-chip">{password === "yes" ? "已设密码" : "无密码"}<X size={12} /></button>}
            <button type="button" onClick={resetFilters} className="h-10 rounded-md px-2 text-tx-secondary hover:bg-app-hover hover:text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary">清空筛选</button>
          </div>}
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
            <div className="share-management-table overflow-hidden rounded-xl border border-app-border bg-app-surface">
              <table className="w-full table-fixed text-left text-sm" aria-label="分享链接">
                <colgroup><col /><col className="w-20" /><col className="w-36" /><col className="w-20" /><col className="w-32" /><col className="w-32" /></colgroup>
                <thead className="border-b border-app-border bg-app-hover/50 text-xs text-tx-secondary"><tr><th className="px-3 py-2.5 font-medium">笔记</th><th className="px-2 py-2.5 font-medium">状态</th><th className="px-3 py-2.5 font-medium">权限 / 保护</th><th className="px-2 py-2.5 font-medium">访问</th><th className="px-3 py-2.5 font-medium">到期</th><th className="px-3 py-2.5 text-right font-medium">操作</th></tr></thead>
                <tbody className="divide-y divide-app-border">
                  {data.items.map(item => (
                    <tr key={item.id} className="h-16 hover:bg-app-hover/40">
                      <td className="px-3 py-2"><button title={item.noteTitle || "原笔记已删除"} className="block max-w-full truncate rounded text-left font-medium text-tx-primary hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary" onClick={() => void openNote(item)}>{item.noteTitle || "原笔记已删除"}</button><p className="mt-1 truncate text-xs text-tx-tertiary" title={`${item.workspaceName || "个人空间"}${item.notebookName ? ` / ${item.notebookName}` : ""}`}>{item.workspaceName || "个人空间"}{item.notebookName ? ` / ${item.notebookName}` : ""}</p></td>
                      <td className="px-2 py-2"><StatusBadge status={item.effectiveStatus} />{(item.noteMissing || item.noteIsTrashed) && <p className="mt-1 text-xs text-accent-danger">{item.noteMissing ? "原笔记缺失" : "位于回收站"}</p>}</td>
                      <td className="px-3 py-2"><p className="truncate text-xs text-tx-secondary">{sharePermissionLabel(item.permission)}</p><p className="mt-1 flex items-center gap-1 text-xs text-tx-tertiary">{item.hasPassword && <KeyRound size={12} />}{item.hasPassword ? "已设密码" : "无密码"}</p></td>
                      <td className="px-2 py-2 text-xs tabular-nums text-tx-secondary">{item.viewCount} / {item.maxViews ?? "不限"}</td>
                      <td className="px-3 py-2 text-xs tabular-nums text-tx-secondary"><time dateTime={item.expiresAt || undefined}>{formatShareDate(item.expiresAt)}</time></td>
                      <td className="px-3 py-2">{renderActions(item)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="share-management-cards space-y-2">
              {data.items.map(item => (
                <article key={item.id} className="rounded-xl border border-app-border bg-app-surface p-3">
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><button title={item.noteTitle || "原笔记已删除"} className="block max-w-full truncate rounded text-left text-sm font-medium text-tx-primary hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary" onClick={() => void openNote(item)}>{item.noteTitle || "原笔记已删除"}</button><p className="mt-1 truncate text-xs text-tx-tertiary">{item.workspaceName || "个人空间"}{item.notebookName ? ` / ${item.notebookName}` : ""}</p></div><StatusBadge status={item.effectiveStatus} /></div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-tx-secondary"><span>{sharePermissionLabel(item.permission)}</span><span className="flex items-center gap-1">{item.hasPassword && <KeyRound size={12} />}{item.hasPassword ? "已设密码" : "无密码"}</span><span className="tabular-nums">访问 {item.viewCount} / {item.maxViews ?? "不限"}</span></div>
                  <p className="mt-1 text-xs text-tx-tertiary">到期：{formatShareDate(item.expiresAt)}</p>
                  {(item.noteMissing || item.noteIsTrashed) && <p className="mt-2 text-xs text-accent-danger">{item.noteMissing ? "原笔记已不存在，但仍可停用或删除此分享。" : "原笔记位于回收站中。"}</p>}
                  <div className="mt-2">{renderActions(item)}</div>
                </article>
              ))}
            </div>
          </>
        )}

        {!loading && !error && (data?.total || 0) > 0 && (
          <footer className="flex flex-col gap-2 text-sm text-tx-secondary sm:flex-row sm:items-center sm:justify-between">
            <span>共 {data?.total || 0} 条{pageCount > 1 && `，第 ${page} / ${pageCount} 页`}</span>
            {pageCount > 1 && <div className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</Button><Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))}>下一页</Button></div>}
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
