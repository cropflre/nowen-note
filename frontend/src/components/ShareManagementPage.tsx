import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Folder,
  KeyRound,
  Link2,
  Loader2,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
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
import { MOTION_EASE, MOTION_SPRING, staggerDelay } from "@/lib/motion";
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

interface ShareCardPalette {
  wellClass: string;
  accentBar: string;
  progressFill: string;
}

const SHARE_PALETTES: ShareCardPalette[] = [
  {
    wellClass: "bg-sky-500/12 text-sky-600 ring-1 ring-sky-500/20 dark:bg-sky-400/15 dark:text-sky-300",
    accentBar: "from-sky-400/75 via-cyan-400/65 to-indigo-400/75",
    progressFill: "bg-sky-500 dark:bg-sky-400",
  },
  {
    wellClass: "bg-violet-500/12 text-violet-600 ring-1 ring-violet-500/20 dark:bg-violet-400/15 dark:text-violet-300",
    accentBar: "from-violet-400/75 via-fuchsia-400/65 to-sky-400/75",
    progressFill: "bg-violet-500 dark:bg-violet-400",
  },
  {
    wellClass: "bg-emerald-500/12 text-emerald-600 ring-1 ring-emerald-500/20 dark:bg-emerald-400/15 dark:text-emerald-300",
    accentBar: "from-emerald-400/75 via-teal-400/65 to-cyan-400/75",
    progressFill: "bg-emerald-500 dark:bg-emerald-400",
  },
  {
    wellClass: "bg-amber-500/14 text-amber-600 ring-1 ring-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300",
    accentBar: "from-amber-400/80 via-orange-400/65 to-rose-400/70",
    progressFill: "bg-amber-500 dark:bg-amber-400",
  },
  {
    wellClass: "bg-rose-500/12 text-rose-600 ring-1 ring-rose-500/20 dark:bg-rose-400/15 dark:text-rose-300",
    accentBar: "from-rose-400/75 via-pink-400/65 to-violet-400/75",
    progressFill: "bg-rose-500 dark:bg-rose-400",
  },
];

function pickSharePalette(seed: string): ShareCardPalette {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return SHARE_PALETTES[Math.abs(hash) % SHARE_PALETTES.length];
}

function getStatusDotClass(status: "all" | ShareEffectiveStatus) {
  switch (status) {
    case "active":
      return "bg-emerald-500 dark:bg-emerald-400";
    case "disabled":
      return "bg-slate-400 dark:bg-slate-500";
    case "expired":
      return "bg-amber-500 dark:bg-amber-400";
    case "exhausted":
      return "bg-rose-500 dark:bg-rose-400";
    default:
      return "bg-sky-500 dark:bg-sky-400";
  }
}

function renderPermissionIcon(permission: SharePermission) {
  if (permission === "comment") return <MessageCircle size={17} />;
  if (permission === "edit" || permission === "edit_auth") return <Pencil size={16} />;
  return <Eye size={17} />;
}

function StatusBadge({ status }: { status: ShareEffectiveStatus }) {
  const meta = shareStatusMeta(status);
  const isActive = status === "active";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium shadow-xs",
        meta.className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        {isActive && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", getStatusDotClass(status))} />
      </span>
      {meta.label}
    </span>
  );
}

/** 俏皮拟人化「纸飞机传送门」空状态插画：悬停轻浮，点击翻转卖萌。 */
function PlayfulSharePortal({ onBoop }: { onBoop: () => void }) {
  const [boops, setBoops] = useState(0);

  return (
    <motion.button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={() => {
        setBoops((count) => count + 1);
        onBoop();
      }}
      className="group relative mx-auto mb-5 flex h-32 w-32 cursor-pointer items-center justify-center rounded-full focus:outline-none"
      whileHover={{ scale: 1.07 }}
      whileTap={{ scale: 0.93 }}
      animate={boops > 0 ? { y: [0, -12, 0], rotate: [0, -8, 8, 0] } : { y: [0, -4, 0] }}
      transition={boops > 0
        ? { duration: 0.45, ease: MOTION_EASE.enter }
        : { duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
    >
      <span className="pointer-events-none absolute inset-1.5 rounded-full bg-gradient-to-tr from-sky-400/22 via-cyan-400/18 to-violet-400/22 blur-xl" />

      <motion.span
        className="pointer-events-none absolute right-2 top-3 text-amber-400 dark:text-amber-300"
        animate={{ y: [0, -5, 0], rotate: [0, 16, 0], opacity: [0.65, 1, 0.65] }}
        transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
      >
        <Sparkles size={16} />
      </motion.span>
      <motion.span
        className="pointer-events-none absolute left-2 top-6 h-2.5 w-2.5 rounded-full bg-sky-400/60"
        animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0.95, 0.5] }}
        transition={{ duration: 2.3, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.span
        className="pointer-events-none absolute bottom-4 right-3 h-2 w-2 rounded-full bg-violet-400/60"
        animate={{ y: [0, 4, 0], opacity: [0.45, 0.9, 0.45] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut", delay: 0.35 }}
      />

      <svg viewBox="0 0 112 112" className="relative h-24 w-24 drop-shadow-sm" fill="none">
        {/* 传送门光环 */}
        <circle
          cx="56"
          cy="58"
          r="34"
          className="fill-sky-500/10 stroke-sky-400/45 dark:fill-sky-400/12 dark:stroke-sky-300/45"
          strokeWidth="2.5"
          strokeDasharray="6 5"
        />
        <circle
          cx="56"
          cy="58"
          r="26"
          className="fill-app-elevated stroke-sky-500/35 dark:stroke-sky-300/40"
          strokeWidth="2"
        />

        {/* 纸飞机小翼 */}
        <g className="origin-center transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-1 group-hover:rotate-6">
          <path
            d="M36 57L76 41L64 74L54 62L36 57Z"
            className="fill-sky-500/20 stroke-sky-600 dark:fill-sky-400/25 dark:stroke-sky-300"
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
          <path
            d="M76 41L54 62L55 71"
            className="stroke-sky-600 dark:stroke-sky-300"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>

        {/* 小微笑脸颊点缀 */}
        <circle cx="48" cy="79" r="2.2" className="fill-tx-primary/70" />
        <circle cx="64" cy="79" r="2.2" className="fill-tx-primary/70" />
        <path
          d="M52.5 81.5C54 83.5 58 83.5 59.5 81.5"
          className="stroke-tx-primary/70"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="43.5" cy="81" r="2.6" className="fill-rose-400/40" />
        <circle cx="68.5" cy="81" r="2.6" className="fill-rose-400/40" />
      </svg>
    </motion.button>
  );
}

const PORTAL_BOOP_LINES = [
  "啾～纸飞机已待命，去给笔记开个传送门吧 ✈️",
  "打开任意笔记点一下「分享」，这里就会亮起小光点 ✨",
  "好内容就该装进漂流瓶，发给懂它的人呀 💌",
];

function ShareActions({ item, copied, onCopy, onEdit, items }: {
  item: ShareManagementItem;
  copied: boolean;
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
        ? anchor.bottom + 6 : Math.max(8, anchor.top - menu.height - 6),
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
    <div className="share-actions flex shrink-0 items-center justify-end gap-1.5">
      <button
        type="button"
        aria-label="复制链接"
        title={copied ? "已复制链接" : "复制链接"}
        onClick={onCopy}
        className={cn("share-primary-action", copied && "is-copied")}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        <span className="share-action-label">{copied ? "已复制" : "复制链接"}</span>
      </button>
      <button
        type="button"
        aria-label="编辑分享"
        title="编辑分享"
        onClick={onEdit}
        className="share-primary-action"
      >
        <Pencil size={14} />
        <span className="share-action-label">设置</span>
      </button>
      <button
        ref={triggerRef}
        type="button"
        aria-label="更多分享操作"
        title="更多分享操作"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="share-more-action"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={`${item.noteTitle || "分享链接"}的更多操作`}
          style={position}
          className="fixed z-[100] w-56 max-w-[calc(100vw-16px)] max-h-[min(360px,calc(100dvh-16px))] overflow-y-auto rounded-2xl border border-app-border/80 bg-app-elevated/95 p-1.5 shadow-xl backdrop-blur-xl"
        >
          <div className="mb-1 rounded-xl bg-app-hover/60 px-3 py-2 text-xs text-tx-tertiary">
            <span>链接标识</span>
            <code className="mt-0.5 block truncate font-mono text-[11px] text-tx-secondary" title={item.shareToken}>
              {compactShareToken(item.shareToken)}
            </code>
          </div>
          {items.map((action) => (
            <button
              key={action.label}
              role="menuitem"
              type="button"
              onClick={() => { close(true); action.onClick(); }}
              className={cn(
                "flex h-9 w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
                action.danger
                  ? "text-accent-danger hover:bg-rose-500/10"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
              )}
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>,
        document.body,
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
    <motion.div
      role="dialog"
      aria-label="公开分享地址详情"
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.18, ease: MOTION_EASE.enter }}
      className={cn(
        "absolute z-40 mt-2 w-[min(368px,calc(100vw-2rem))] rounded-2xl border border-app-border/80 bg-app-elevated/95 p-4 text-left shadow-2xl backdrop-blur-xl",
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
          className="rounded-lg p-1 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
        >
          <X size={15} />
        </button>
      </div>

      <div className="mt-3 rounded-xl border border-app-border/60 bg-app-hover/55 p-3">
        <div className="flex items-center justify-between gap-3 text-[11px] text-tx-tertiary">
          <span>地址来源</span>
          <span className="font-medium text-tx-secondary">{getPublicWebOriginSourceLabel(publicOrigin.source)}</span>
        </div>
        <div className="mt-2 flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-xs text-tx-secondary">
            {publicOrigin.origin || "相对地址"}
          </code>
          {publicOrigin.origin && (
            <button
              type="button"
              aria-label="复制公开分享地址"
              title="复制公开分享地址"
              onClick={() => void copyOrigin()}
              className="shrink-0 rounded-lg p-1 text-tx-tertiary transition-colors hover:bg-app-surface hover:text-tx-primary"
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
              className="h-9 min-w-0 flex-1 rounded-xl text-xs"
            />
            <Button size="sm" disabled={saving} onClick={() => void saveOrigin()} className="h-9 shrink-0 rounded-xl">
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

      <p className="mt-3 border-t border-app-border/70 pt-3 text-[11px] leading-4 text-tx-tertiary">
        配置完成后，仍建议使用无痕窗口或未登录设备验证一次。
      </p>
    </motion.div>
  );

  if (variant === "banner") {
    return (
      <div ref={rootRef} className="relative">
        <motion.div
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: MOTION_EASE.enter }}
          className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-amber-400/35 bg-gradient-to-r from-amber-500/[0.09] via-orange-400/[0.06] to-amber-500/[0.09] px-3.5 py-2 text-xs text-amber-800 shadow-xs backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between dark:border-amber-400/25 dark:text-amber-200"
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 ring-1 ring-amber-500/25 dark:text-amber-300">
              <AlertTriangle size={15} />
            </span>
            <span className="share-origin-full font-medium leading-5">{copy.message}</span>
            <span className="share-origin-short font-medium leading-5" title={copy.message}>{copy.label}</span>
          </div>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className="ml-auto inline-flex h-8 shrink-0 items-center rounded-xl bg-amber-500/15 px-3 text-xs font-semibold text-amber-800 transition-all hover:bg-amber-500/25 active:scale-95 dark:bg-amber-400/15 dark:text-amber-200 dark:hover:bg-amber-400/25"
          >
            配置公开地址
          </button>
        </motion.div>
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
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-amber-400/35 bg-amber-500/[0.08] px-3 text-xs font-medium text-amber-700 transition-all hover:bg-amber-500/15 active:scale-95 dark:text-amber-200"
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [boopIndex, setBoopIndex] = useState<number | null>(null);
  const requestSequence = useRef(0);
  const copiedTimerRef = useRef<number | null>(null);
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
    return () => {
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

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
      setCopiedId(item.id);
      if (copiedTimerRef.current) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedId((current) => (current === item.id ? null : current));
      }, 1800);
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
    <ShareActions
      item={item}
      copied={copiedId === item.id}
      onCopy={() => void copyLink(item)}
      onEdit={() => setEditing(item)}
      items={[
        { label: "打开分享", icon: <ExternalLink size={15} />, onClick: () => { window.open(shareUrl(item), "_blank", "noopener,noreferrer"); } },
        { label: "打开原笔记", icon: <FileText size={15} />, onClick: () => void openNote(item) },
        { label: item.isActive ? "停用分享" : "启用分享", icon: item.isActive ? <PowerOff size={15} /> : <Power size={15} />, onClick: () => void toggleShare(item) },
        { label: "重置访问次数", icon: <RefreshCw size={15} />, onClick: () => void resetViews(item) },
        { label: "轮换链接", icon: <RotateCcw size={15} />, onClick: () => void rotateShare(item) },
        { label: "删除分享", icon: <Trash2 size={15} />, danger: true, onClick: () => void removeShare(item) },
      ]}
    />
  );

  const showLocalhostBanner = publicOrigin.risk === "localhost";
  const showHeaderRisk = publicOrigin.risk !== "none" && !showLocalhostBanner;

  const headerSubtitle = stats.total === 0
    ? "把得意之作装进分享传送门，一键分享给朋友或团队 ✨"
    : stats.active > 0
      ? `当前有 ${stats.active} 道传送门正在营业，随时加密、续期或收回 ✨`
      : "所有分享传送门都在休息中，随时可以一键重新开启 🎈";

  return (
    <div className="share-management relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-app-bg">
      {/* 柔和极光背景装饰 */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-72 overflow-hidden">
        <div className="absolute -top-24 left-1/4 h-64 w-80 rounded-full bg-sky-400/12 blur-3xl dark:bg-sky-500/12" />
        <div className="absolute -top-16 right-1/4 h-56 w-72 rounded-full bg-violet-400/10 blur-3xl dark:bg-violet-500/12" />
        <div className="absolute top-6 left-1/2 h-40 w-64 -translate-x-1/2 rounded-full bg-cyan-400/8 blur-3xl dark:bg-emerald-500/8" />
      </div>

      <div
        className="relative mx-auto w-full max-w-6xl space-y-4 px-4 py-5 sm:px-6 sm:py-6"
        style={{ paddingBottom: "max(24px, env(safe-area-inset-bottom))" }}
      >
        {/* 灵动头部 */}
        <motion.header
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, ease: MOTION_EASE.enter }}
          className="flex flex-wrap items-start justify-between gap-3 sm:items-center"
        >
          <div className="flex items-center gap-3.5">
            <motion.div
              whileHover={{ rotate: [0, -10, 10, -4, 0], scale: 1.07 }}
              whileTap={{ scale: 0.93 }}
              transition={{ duration: 0.45 }}
              className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 via-cyan-400/18 to-violet-500/20 text-sky-600 shadow-sm ring-1 ring-sky-500/20 dark:from-sky-400/25 dark:via-cyan-400/20 dark:to-violet-400/25 dark:text-sky-300 dark:ring-sky-400/30"
            >
              <Link2 size={22} />
              {stats.active > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full border-2 border-app-bg bg-emerald-500" />
                </span>
              )}
            </motion.div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-tx-primary">分享管理</h1>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/20 bg-sky-500/10 px-2.5 py-0.5 text-xs font-medium text-sky-700 tabular-nums dark:border-sky-400/25 dark:bg-sky-400/15 dark:text-sky-300">
                  共 {stats.total} 条
                </span>
              </div>
              <p className="mt-0.5 text-xs text-tx-secondary">{headerSubtitle}</p>
            </div>
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
            <motion.button
              type="button"
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.96 }}
              onClick={openCommentCenter}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-elevated/80 px-3 text-xs font-medium text-tx-secondary shadow-xs backdrop-blur-sm transition-colors hover:border-accent-primary/35 hover:bg-app-surface hover:text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              <MessageSquareText size={14} className="text-sky-500 dark:text-sky-400" />
              评论管理
            </motion.button>
            <motion.button
              type="button"
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => void load(true)}
              disabled={refreshing}
              className="group inline-flex h-9 items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-elevated/80 px-3 text-xs font-medium text-tx-secondary shadow-xs backdrop-blur-sm transition-colors hover:border-accent-primary/35 hover:bg-app-surface hover:text-tx-primary disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              {refreshing ? (
                <Loader2 size={14} className="animate-spin text-accent-primary" />
              ) : (
                <RefreshCw size={14} className="transition-transform duration-300 group-hover:rotate-180" />
              )}
              刷新
            </motion.button>
          </div>
        </motion.header>

        {showLocalhostBanner && (
          <PublicOriginRiskControl
            publicOrigin={publicOrigin}
            configuredOrigin={siteConfig.publicWebOrigin}
            updatePublicWebOrigin={updatePublicWebOrigin}
            variant="banner"
          />
        )}

        {/* 磨砂控制台：滑动状态胶囊 + 搜索与筛选 */}
        <motion.section
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0.04, ease: MOTION_EASE.enter }}
          className="overflow-hidden rounded-2xl border border-app-border/80 bg-app-elevated/75 shadow-sm backdrop-blur-md"
        >
          <div
            role="group"
            aria-label="按状态筛选"
            className="flex items-center gap-1 overflow-x-auto border-b border-app-border/70 bg-app-bg/35 p-1.5"
          >
            {statusTabs.map((tab) => {
              const active = status === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  aria-label={tab.label}
                  aria-pressed={active}
                  onClick={() => { setPage(1); setStatus(tab.key); }}
                  className={cn(
                    "relative flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
                    active ? "font-semibold text-tx-primary" : "text-tx-secondary hover:text-tx-primary",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="share-status-pill"
                      transition={MOTION_SPRING.snappy}
                      className="absolute inset-0 rounded-xl bg-app-surface shadow-xs ring-1 ring-app-border/80"
                    />
                  )}
                  <span className={cn("relative z-10 h-1.5 w-1.5 rounded-full", getStatusDotClass(tab.key))} />
                  <span className="relative z-10">{tab.label}</span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "relative z-10 rounded-full px-1.5 py-0.2 text-[11px] tabular-nums transition-colors",
                      active
                        ? "bg-accent-primary/12 text-accent-primary"
                        : "bg-app-hover/80 text-tx-tertiary",
                    )}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="share-management-toolbar flex flex-wrap items-center gap-2 p-2.5">
            <label className="share-search-field relative min-w-[180px] flex-1">
              <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-tx-tertiary" />
              <Input
                aria-label="搜索分享"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="搜索笔记标题或链接标识..."
                className="h-10 rounded-xl border-app-border/70 bg-app-surface/85 pl-9 pr-8 text-sm shadow-none transition-all focus-visible:border-accent-primary/50 focus-visible:bg-app-surface"
              />
              {searchDraft && (
                <button
                  type="button"
                  aria-label="清除搜索输入"
                  onClick={() => { setSearchDraft(""); setQuery(""); setPage(1); }}
                  className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                >
                  <X size={13} />
                </button>
              )}
            </label>

            <Button
              ref={filterButtonRef}
              size="sm"
              variant="ghost"
              className={cn(
                "share-filter-toggle h-10 gap-1.5 rounded-xl border px-3 transition-all",
                filtersOpen || activeFilterCount > 0
                  ? "border-accent-primary/35 bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/15"
                  : "border-app-border/70 bg-app-surface/75 text-tx-secondary hover:bg-app-surface hover:text-tx-primary",
              )}
              aria-label="筛选分享"
              aria-expanded={filtersOpen}
              aria-controls={filtersOpen ? filterId : undefined}
              onClick={() => setFiltersOpen((value) => !value)}
            >
              <SlidersHorizontal size={14} />
              筛选
              {activeFilterCount > 0 && (
                <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-primary px-1 text-[10px] font-semibold text-white">
                  {activeFilterCount}
                </span>
              )}
            </Button>

            <select
              aria-label="分享排序"
              value={`${sort}:${order}`}
              onChange={(event) => {
                const [field, direction] = event.target.value.split(":");
                setPage(1);
                setSort(field as SortKey);
                setOrder(direction as "asc" | "desc");
              }}
              className="h-10 max-w-full cursor-pointer rounded-xl border border-app-border/70 bg-app-surface/85 px-3 text-xs font-medium text-tx-secondary transition-colors hover:border-accent-primary/35 hover:text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              <option value="updatedAt:desc">最近更新 ↓</option>
              <option value="updatedAt:asc">最早更新 ↑</option>
              <option value="createdAt:desc">最新创建 ↓</option>
              <option value="createdAt:asc">最早创建 ↑</option>
              <option value="expiresAt:asc">即将到期 ↑</option>
              <option value="expiresAt:desc">最晚到期 ↓</option>
              <option value="noteTitle:asc">标题 A → Z</option>
              <option value="noteTitle:desc">标题 Z → A</option>
            </select>
          </div>

          {filtersOpen && (
            <div
              id={filterId}
              role="group"
              aria-label="分享筛选条件"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setFiltersOpen(false);
                  filterButtonRef.current?.focus();
                }
              }}
              className="flex flex-wrap items-end gap-3 border-t border-app-border/70 bg-app-bg/45 p-3"
            >
              <label className="min-w-[150px] flex-1 text-xs font-medium text-tx-secondary">
                权限
                <select
                  aria-label="按权限筛选"
                  value={permission}
                  onChange={(event) => { setPage(1); setPermission(event.target.value as typeof permission); }}
                  className="mt-1.5 block h-9 w-full cursor-pointer rounded-xl border border-app-border/80 bg-app-surface px-3 text-sm text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                >
                  <option value="all">全部权限</option>
                  <option value="view">仅查看</option>
                  <option value="comment">可评论</option>
                  <option value="edit">访客可编辑</option>
                  <option value="edit_auth">登录后可编辑</option>
                </select>
              </label>
              <label className="min-w-[150px] flex-1 text-xs font-medium text-tx-secondary">
                密码保护
                <select
                  aria-label="按密码筛选"
                  value={password}
                  onChange={(event) => { setPage(1); setPassword(event.target.value as PasswordFilter); }}
                  className="mt-1.5 block h-9 w-full cursor-pointer rounded-xl border border-app-border/80 bg-app-surface px-3 text-sm text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                >
                  <option value="all">全部密码状态</option>
                  <option value="yes">已设密码</option>
                  <option value="no">无密码</option>
                </select>
              </label>
              <Button
                size="sm"
                variant="ghost"
                className="h-9 rounded-xl px-3 text-xs"
                onClick={() => { setFiltersOpen(false); filterButtonRef.current?.focus(); }}
              >
                收起筛选
              </Button>
            </div>
          )}

          {hasFilters && (
            <div className="flex flex-wrap items-center gap-2 border-t border-app-border/70 bg-app-bg/25 px-3 py-2 text-xs">
              {searchDraft.trim() && (
                <button
                  type="button"
                  aria-label="清空搜索"
                  onClick={() => { setSearchDraft(""); setQuery(""); setPage(1); }}
                  className="share-filter-chip"
                >
                  <span className="max-w-48 truncate">搜索：{searchDraft.trim()}</span>
                  <X size={12} />
                </button>
              )}
              {status !== "all" && (
                <button
                  type="button"
                  aria-label="清除状态筛选"
                  onClick={() => { setStatus("all"); setPage(1); }}
                  className="share-filter-chip"
                >
                  {shareStatusMeta(status).label}
                  <X size={12} />
                </button>
              )}
              {permission !== "all" && (
                <button
                  type="button"
                  aria-label="移除权限筛选"
                  onClick={() => { setPermission("all"); setPage(1); }}
                  className="share-filter-chip"
                >
                  {sharePermissionLabel(permission)}
                  <X size={12} />
                </button>
              )}
              {password !== "all" && (
                <button
                  type="button"
                  aria-label="移除密码筛选"
                  onClick={() => { setPassword("all"); setPage(1); }}
                  className="share-filter-chip"
                >
                  {password === "yes" ? "已设密码" : "无密码"}
                  <X size={12} />
                </button>
              )}
              <button
                type="button"
                onClick={resetFilters}
                className="h-8 rounded-xl px-2.5 text-xs font-medium text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
              >
                清空筛选
              </button>
            </div>
          )}
        </motion.section>

        {/* 主内容区域 */}
        {loading ? (
          <div className="space-y-3" aria-label="正在加载分享链接">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="animate-pulse rounded-2xl border border-app-border/70 bg-app-elevated/70 p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-xl bg-app-hover/80" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-44 rounded-md bg-app-hover/90" />
                    <div className="h-3 w-28 rounded-md bg-app-hover/65" />
                  </div>
                  <div className="h-6 w-14 rounded-full bg-app-hover/80" />
                </div>
                <div className="mt-3 flex gap-2">
                  <div className="h-6 w-16 rounded-full bg-app-hover/70" />
                  <div className="h-6 w-16 rounded-full bg-app-hover/70" />
                  <div className="h-6 w-20 rounded-full bg-app-hover/70" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex min-h-64 flex-col items-center justify-center rounded-3xl border border-dashed border-rose-500/35 bg-rose-500/[0.05] px-6 py-10 text-center"
          >
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-500/12 text-rose-500">
              <AlertTriangle size={22} />
            </div>
            <p className="text-sm font-medium text-rose-700 dark:text-rose-300">{error}</p>
            <Button className="mt-4 rounded-xl" variant="outline" onClick={() => void load()}>
              <RefreshCw size={14} className="mr-1.5" />
              重试
            </Button>
          </motion.div>
        ) : !data?.items?.length ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: MOTION_EASE.enter }}
            className="flex min-h-72 flex-col items-center justify-center rounded-3xl border border-dashed border-app-border/80 bg-app-elevated/65 px-6 py-12 text-center backdrop-blur-sm"
          >
            <PlayfulSharePortal
              onBoop={() => setBoopIndex((prev) => (prev === null ? 0 : (prev + 1) % PORTAL_BOOP_LINES.length))}
            />
            <h2 className="text-base font-semibold text-tx-primary">还没有符合条件的分享链接</h2>
            <p className="mt-1.5 max-w-md text-xs leading-5 text-tx-secondary">
              {boopIndex !== null
                ? PORTAL_BOOP_LINES[boopIndex]
                : "打开任意笔记并点击“分享”，创建后的链接会统一显示在这里。"}
            </p>
            {hasFilters && (
              <Button
                variant="outline"
                size="sm"
                className="mt-4 rounded-xl"
                onClick={resetFilters}
              >
                <RotateCcw size={13} className="mr-1.5" />
                重置全部筛选
              </Button>
            )}
          </motion.div>
        ) : (
          <>
            {/* 宽容器桌面表格视图 */}
            <div className="share-management-table overflow-hidden rounded-2xl border border-app-border/80 bg-app-elevated/80 shadow-sm backdrop-blur-sm">
              <table className="w-full table-fixed text-left text-sm" aria-label="分享链接">
                <colgroup>
                  <col />
                  <col className="w-24" />
                  <col className="w-40" />
                  <col className="w-28" />
                  <col className="w-32" />
                  <col className="w-32" />
                </colgroup>
                <thead className="border-b border-app-border/75 bg-app-bg/50 text-xs text-tx-secondary">
                  <tr>
                    <th className="px-4 py-3 font-medium">笔记</th>
                    <th className="px-2 py-3 font-medium">状态</th>
                    <th className="px-3 py-3 font-medium">权限 / 保护</th>
                    <th className="px-2 py-3 font-medium">访问</th>
                    <th className="px-3 py-3 font-medium">到期</th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border/65">
                  {data.items.map((item, index) => {
                    const palette = pickSharePalette(item.id);
                    const locationLabel = `${item.workspaceName || "个人空间"}${item.notebookName ? ` / ${item.notebookName}` : ""}`;
                    const viewPercent = item.maxViews && item.maxViews > 0
                      ? Math.min(100, Math.round((item.viewCount / item.maxViews) * 100))
                      : null;

                    return (
                      <motion.tr
                        key={item.id}
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.22, delay: staggerDelay(index), ease: MOTION_EASE.enter }}
                        className="group h-[74px] transition-colors hover:bg-app-hover/45"
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-3 min-w-0">
                            <span
                              className={cn(
                                "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-105",
                                palette.wellClass,
                              )}
                            >
                              {renderPermissionIcon(item.permission)}
                            </span>
                            <div className="min-w-0 flex-1">
                              <button
                                title={item.noteTitle || "原笔记已删除"}
                                className="block max-w-full truncate rounded text-left font-semibold text-tx-primary transition-colors hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                                onClick={() => void openNote(item)}
                              >
                                {item.noteTitle || "原笔记已删除"}
                              </button>
                              <p
                                className="mt-0.5 flex items-center gap-1 truncate text-xs text-tx-tertiary"
                                title={locationLabel}
                              >
                                <Folder size={11} className="shrink-0 opacity-70" />
                                <span className="truncate">{locationLabel}</span>
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-2.5">
                          <StatusBadge status={item.effectiveStatus} />
                          {(item.noteMissing || item.noteIsTrashed) && (
                            <p className="mt-1 text-[11px] font-medium text-accent-danger">
                              {item.noteMissing ? "原笔记缺失" : "位于回收站"}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="truncate text-xs font-medium text-tx-secondary">
                            {sharePermissionLabel(item.permission)}
                          </p>
                          <p className={cn(
                            "mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                            item.hasPassword
                              ? "bg-amber-500/12 font-medium text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
                              : "bg-app-hover/80 text-tx-tertiary",
                          )}>
                            {item.hasPassword && <KeyRound size={11} />}
                            {item.hasPassword ? "已设密码" : "无密码"}
                          </p>
                        </td>
                        <td className="px-2 py-2.5 text-xs tabular-nums text-tx-secondary">
                          <div className="font-medium">
                            {item.viewCount} / {item.maxViews ?? "不限"}
                          </div>
                          {viewPercent !== null && (
                            <div className="mt-1.5 h-1.5 w-16 overflow-hidden rounded-full bg-app-hover">
                              <div
                                className={cn("h-full rounded-full transition-all duration-300", palette.progressFill)}
                                style={{ width: `${viewPercent}%` }}
                              />
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-xs tabular-nums text-tx-secondary">
                          <span className="inline-flex items-center gap-1">
                            <Clock size={12} className="text-tx-tertiary" />
                            <time dateTime={item.expiresAt || undefined}>{formatShareDate(item.expiresAt)}</time>
                          </span>
                        </td>
                        <td className="px-4 py-2.5">{renderActions(item)}</td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* 灵动卡片视图（标准侧边栏展开 / 紧凑容器） */}
            <div className="share-management-cards space-y-3">
              {data.items.map((item, index) => {
                const palette = pickSharePalette(item.id);
                const locationLabel = `${item.workspaceName || "个人空间"}${item.notebookName ? ` / ${item.notebookName}` : ""}`;
                const viewPercent = item.maxViews && item.maxViews > 0
                  ? Math.min(100, Math.round((item.viewCount / item.maxViews) * 100))
                  : null;

                return (
                  <motion.article
                    key={item.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24, delay: staggerDelay(index), ease: MOTION_EASE.enter }}
                    className="group relative overflow-hidden rounded-2xl border border-app-border/80 bg-app-elevated/85 p-4 shadow-xs backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-primary/35 hover:shadow-md"
                  >
                    {/* 顶部彩色微光边条 */}
                    <div
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r opacity-0 transition-opacity duration-200 group-hover:opacity-100",
                        palette.accentBar,
                      )}
                    />

                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-start gap-3">
                        <span
                          className={cn(
                            "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-105",
                            palette.wellClass,
                          )}
                        >
                          {renderPermissionIcon(item.permission)}
                        </span>
                        <div className="min-w-0">
                          <button
                            title={item.noteTitle || "原笔记已删除"}
                            className="block max-w-full truncate rounded text-left text-[15px] font-semibold text-tx-primary transition-colors hover:text-accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
                            onClick={() => void openNote(item)}
                          >
                            {item.noteTitle || "原笔记已删除"}
                          </button>
                          <p className="mt-1 flex items-center gap-1 truncate text-xs text-tx-tertiary">
                            <Folder size={12} className="shrink-0 opacity-75" />
                            <span className="truncate">{locationLabel}</span>
                          </p>
                        </div>
                      </div>
                      <StatusBadge status={item.effectiveStatus} />
                    </div>

                    {/* 信息胶囊行 */}
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                      <span className="inline-flex items-center gap-1 rounded-full bg-app-hover/80 px-2.5 py-1 font-medium text-tx-secondary">
                        <ShieldCheck size={12} className="text-sky-500 dark:text-sky-400" />
                        {sharePermissionLabel(item.permission)}
                      </span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full px-2.5 py-1",
                          item.hasPassword
                            ? "bg-amber-500/12 font-medium text-amber-700 dark:bg-amber-400/15 dark:text-amber-300"
                            : "bg-app-hover/70 text-tx-tertiary",
                        )}
                      >
                        {item.hasPassword && <KeyRound size={12} />}
                        {item.hasPassword ? "已设密码" : "无密码"}
                      </span>
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-app-hover/70 px-2.5 py-1 text-tx-secondary tabular-nums">
                        <Eye size={12} className="text-tx-tertiary" />
                        <span>访问 {item.viewCount} / {item.maxViews ?? "不限"}</span>
                        {viewPercent !== null && (
                          <span className="ml-0.5 inline-block h-1.5 w-10 overflow-hidden rounded-full bg-app-border/70">
                            <span
                              className={cn("block h-full rounded-full", palette.progressFill)}
                              style={{ width: `${viewPercent}%` }}
                            />
                          </span>
                        )}
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full bg-app-hover/60 px-2.5 py-1 text-tx-tertiary tabular-nums">
                        <Clock size={12} />
                        到期：{formatShareDate(item.expiresAt)}
                      </span>
                    </div>

                    {(item.noteMissing || item.noteIsTrashed) && (
                      <p className="mt-2.5 rounded-xl bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-accent-danger">
                        {item.noteMissing ? "原笔记已不存在，但仍可停用或删除此分享。" : "原笔记位于回收站中。"}
                      </p>
                    )}

                    {/* 卡片底栏：链接标识 + 快捷操作 */}
                    <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 border-t border-app-border/60 pt-3">
                      <code
                        title={item.shareToken}
                        className="inline-flex items-center gap-1 rounded-lg bg-app-bg/75 px-2 py-1 font-mono text-[11px] text-tx-tertiary"
                      >
                        <Link2 size={11} className="opacity-75" />
                        {compactShareToken(item.shareToken)}
                      </code>
                      {renderActions(item)}
                    </div>
                  </motion.article>
                );
              })}
            </div>
          </>
        )}

        {!loading && !error && (data?.total || 0) > 0 && (
          <footer className="flex flex-col gap-2 rounded-2xl border border-app-border/60 bg-app-elevated/55 px-4 py-2.5 text-xs text-tx-secondary sm:flex-row sm:items-center sm:justify-between">
            <span className="tabular-nums">
              共 {data?.total || 0} 条{pageCount > 1 && `，第 ${page} / ${pageCount} 页`}
            </span>
            {pageCount > 1 && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-xl px-3 text-xs"
                  disabled={page <= 1}
                  onClick={() => setPage((value) => Math.max(1, value - 1))}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-xl px-3 text-xs"
                  disabled={page >= pageCount}
                  onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
                >
                  下一页
                </Button>
              </div>
            )}
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
