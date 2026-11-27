import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion } from "framer-motion";
import {
  BrainCircuit,
  Check,
  FileText,
  Folder,
  Grid2X2,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useApp, useAppActions } from "@/store/AppContext";
import { getCurrentWorkspace } from "@/lib/api";
import { emitKnowledgeTreeRefresh } from "@/lib/workspaceRefreshBridge";
import { formatAppDateTime, parseServerTime } from "@/lib/dateTime";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";
import { MOTION_EASE, MOTION_SPRING, staggerDelay } from "@/lib/motion";
import { useTrash } from "./useTrash";
import { permanentSelection, type TrashResourceType } from "./trashTypes";

const RESOURCE_TYPES = ["all", "note", "notebook", "mindmap", "sheet"] as const;
type TrashFilter = (typeof RESOURCE_TYPES)[number];

const TYPE_META: Record<
  TrashResourceType,
  {
    icon: typeof FileText;
    wellClass: string;
    chipClass: string;
  }
> = {
  note: {
    icon: FileText,
    wellClass: "bg-sky-500/12 text-sky-600 ring-1 ring-sky-500/20 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/25",
    chipClass: "bg-sky-500/10 text-sky-700 dark:bg-sky-400/15 dark:text-sky-300",
  },
  notebook: {
    icon: Folder,
    wellClass: "bg-amber-500/14 text-amber-600 ring-1 ring-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/25",
    chipClass: "bg-amber-500/12 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  },
  mindmap: {
    icon: BrainCircuit,
    wellClass: "bg-violet-500/12 text-violet-600 ring-1 ring-violet-500/20 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-400/25",
    chipClass: "bg-violet-500/10 text-violet-700 dark:bg-violet-400/15 dark:text-violet-300",
  },
  sheet: {
    icon: Grid2X2,
    wellClass: "bg-emerald-500/12 text-emerald-600 ring-1 ring-emerald-500/20 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/25",
    chipClass: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
};

export default function TrashPage() {
  const { state } = useApp();
  const workspaceId = getCurrentWorkspace();
  return <TrashCenter key={workspaceId} workspaceId={workspaceId} refreshToken={state.notesRefreshToken} />;
}

/** 俏皮拟人小纸篓插画：悬停微晃掀盖，点击开心弹跳一次。 */
function PlayfulEmptyBin({ isSearchEmpty, onBoop }: { isSearchEmpty: boolean; onBoop: () => void }) {
  const [boops, setBoops] = useState(0);

  return (
    <motion.button
      type="button"
      onClick={() => {
        setBoops((n) => n + 1);
        onBoop();
      }}
      aria-hidden="true"
      tabIndex={-1}
      className="group relative mx-auto mb-5 flex h-32 w-32 cursor-pointer items-center justify-center rounded-full focus:outline-none"
      whileHover={{ scale: 1.05 }}
      whileTap={{ scale: 0.94 }}
      animate={boops > 0 ? { y: [0, -10, 0], rotate: [0, -6, 6, 0] } : { y: [0, -4, 0] }}
      transition={boops > 0
        ? { duration: 0.45, ease: MOTION_EASE.enter }
        : { duration: 3.6, repeat: Infinity, ease: "easeInOut" }}
    >
      {/* 柔和氛围光晕 */}
      <span className="pointer-events-none absolute inset-2 rounded-full bg-gradient-to-tr from-sky-400/20 via-violet-400/15 to-emerald-400/20 blur-xl transition-opacity duration-300 group-hover:opacity-100 dark:from-sky-400/15 dark:via-violet-500/15 dark:to-emerald-400/15" />

      {/* 飘浮的小闪星 */}
      <motion.span
        className="pointer-events-none absolute right-2 top-3 text-amber-400 dark:text-amber-300"
        animate={{ y: [0, -5, 0], rotate: [0, 15, 0], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut" }}
      >
        <Sparkles size={16} />
      </motion.span>
      <motion.span
        className="pointer-events-none absolute bottom-4 left-2 h-2.5 w-2.5 rounded-full bg-sky-400/50 dark:bg-sky-300/40"
        animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0.9, 0.5] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut", delay: 0.5 }}
      />
      <motion.span
        className="pointer-events-none absolute left-4 top-5 h-2 w-2 rounded-full bg-violet-400/50 dark:bg-violet-300/40"
        animate={{ y: [0, 4, 0], opacity: [0.4, 0.85, 0.4] }}
        transition={{ duration: 3.1, repeat: Infinity, ease: "easeInOut", delay: 0.2 }}
      />

      {isSearchEmpty ? (
        <svg viewBox="0 0 96 96" className="relative h-24 w-24 drop-shadow-sm" fill="none">
          <circle cx="44" cy="44" r="24" className="fill-app-elevated stroke-accent-primary/60" strokeWidth="3.5" />
          <path d="M62 62L78 78" className="stroke-accent-primary/70" strokeWidth="5.5" strokeLinecap="round" />
          <circle cx="37" cy="41" r="2.6" className="fill-tx-primary" />
          <circle cx="51" cy="41" r="2.6" className="fill-tx-primary" />
          <path d="M39 51C41.5 48.5 46.5 48.5 49 51" className="stroke-tx-secondary" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="31" cy="46" r="2.2" className="fill-rose-400/50" />
          <circle cx="57" cy="46" r="2.2" className="fill-rose-400/50" />
        </svg>
      ) : (
        <svg viewBox="0 0 96 96" className="relative h-24 w-24 drop-shadow-sm" fill="none">
          {/* 纸篓盖：悬停俏皮轻掀 */}
          <g className="origin-[30px_30px] transition-transform duration-300 ease-out group-hover:-rotate-12 group-hover:-translate-y-1">
            <rect x="22" y="25" width="52" height="8" rx="4" className="fill-sky-500/20 stroke-sky-500/70 dark:fill-sky-400/20 dark:stroke-sky-300/80" strokeWidth="2.5" />
            <path d="M39 25V21C39 18.8 40.8 17 43 17H53C55.2 17 57 18.8 57 21V25" className="stroke-sky-500/70 dark:stroke-sky-300/80" strokeWidth="2.5" strokeLinecap="round" />
          </g>
          {/* 纸篓身 */}
          <path
            d="M27 36H69L65.4 73.2C64.9 77.6 61.2 81 56.8 81H39.2C34.8 81 31.1 77.6 30.6 73.2L27 36Z"
            className="fill-app-elevated stroke-sky-500/60 dark:stroke-sky-300/70"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          {/* 俏皮笑脸 */}
          <circle cx="40" cy="54" r="2.8" className="fill-tx-primary" />
          <circle cx="56" cy="54" r="2.8" className="fill-tx-primary" />
          <path d="M43 61.5C45.3 64.5 50.7 64.5 53 61.5" className="stroke-sky-500 dark:stroke-sky-300" strokeWidth="2.6" strokeLinecap="round" />
          <circle cx="34.5" cy="58.5" r="2.6" className="fill-rose-400/45" />
          <circle cx="61.5" cy="58.5" r="2.6" className="fill-rose-400/45" />
        </svg>
      )}
    </motion.button>
  );
}

function TrashCenter({ workspaceId, refreshToken }: { workspaceId: string; refreshToken: number }) {
  const { t, i18n } = useTranslation();
  const isZh = (i18n.language || "zh").toLowerCase().startsWith("zh");
  const actions = useAppActions();
  const { state } = useApp();
  const trash = useTrash(workspaceId, refreshToken);
  const [filter, setFilter] = useState<TrashFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [boopHint, setBoopHint] = useState(false);

  const typeCounts = useMemo(() => {
    const counts: Record<TrashFilter, number> = { all: trash.items.length, note: 0, notebook: 0, mindmap: 0, sheet: 0 };
    for (const item of trash.items) {
      counts[item.resourceType] = (counts[item.resourceType] || 0) + 1;
    }
    return counts;
  }, [trash.items]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return trash.items.filter((item) => (filter === "all" || item.resourceType === filter)
      && (!needle || `${item.title} ${item.originalPath.join(" / ")}`.toLocaleLowerCase().includes(needle)));
  }, [trash.items, filter, query]);

  const selectedItems = useMemo(
    () => trash.items.filter((item) => selected.includes(item.id)),
    [trash.items, selected],
  );
  const disabled = trash.loading || trash.busy || trash.error !== null;
  const allVisibleSelected = visible.length > 0 && visible.every((item) => selected.includes(item.id));

  const operate = async (action: "restore" | "permanent" | "empty", ids: string[]) => {
    const targets = action === "empty"
      ? trash.items
      : action === "permanent"
        ? permanentSelection(trash.items, ids)
        : trash.items.filter((item) => ids.includes(item.id));
    if (action !== "restore") {
      if (!await confirm({
        title: t(action === "empty" ? "trashCenter.empty" : "trashCenter.permanent"),
        description: t("trashCenter.deleteConfirm", { count: targets.length }),
        confirmText: t("trashCenter.permanent"),
        danger: true,
      })) return;
    } else if (targets.some((item) => item.restoreIncludesAncestors || item.resourceType === "notebook")) {
      if (!await confirm({
        title: t("trashCenter.restore"),
        description: t("trashCenter.restoreConfirm"),
        confirmText: t("trashCenter.restore"),
      })) return;
    }
    try {
      const result = await trash.mutate(action, ids);
      if (getCurrentWorkspace() !== workspaceId) return;
      setSelected((current) => current.filter((id) => !result.succeededIds.includes(id)));
      if (result.failures.length) toast.warning(t("trashCenter.partial", { count: result.succeededIds.length, failed: result.failures.length }));
      else toast.success(t("trashCenter.success", { count: result.succeededIds.length }));
      if (state.activeNote && result.noteIds.includes(state.activeNote.id)) actions.setActiveNote(null);
      actions.refreshNotes();
      actions.refreshNotebooks();
      emitKnowledgeTreeRefresh("trash-lifecycle");
      window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "trash-lifecycle" } }));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t("trashCenter.operationFailed"));
      void trash.reload();
    }
  };

  const resetFilters = () => {
    setFilter("all");
    setQuery("");
  };

  const emptySubcopy = trash.items.length
    ? (isZh ? "换个关键词或切回「全部」分类看看，灵感也许正躲在旁边～" : "Try another keyword or switch back to All to spot it.")
    : boopHint
      ? (isZh ? "嘿嘿，纸篓里真的一张废纸也没有，安心去写新笔记吧！" : "Hehe, really spotless in here — go capture a fresh idea!")
      : (isZh ? "这里一尘不染，每一份删掉的灵感都会先在这里打个盹，随时可以捡回来。" : "Spotless in here. Deleted ideas take a short nap here before leaving for good.");

  return (
    <main
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-app-bg text-tx-primary"
      aria-label={t("sidebar.trash")}
    >
      {/* 柔和氛围渐变背景，暗色深邃、亮色清透 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-56 bg-[radial-gradient(ellipse_70%_80%_at_18%_0%,rgba(56,189,248,0.11),transparent_70%),radial-gradient(ellipse_60%_70%_at_82%_0%,rgba(167,139,250,0.10),transparent_70%)] dark:bg-[radial-gradient(ellipse_70%_80%_at_18%_0%,rgba(56,189,248,0.13),transparent_70%),radial-gradient(ellipse_60%_70%_at_82%_0%,rgba(139,92,246,0.12),transparent_70%)]"
      />

      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-5 md:px-8 md:py-7">
          {/* 顶部灵动头栏 */}
          <header className="flex flex-wrap items-center justify-between gap-4 pb-5">
            <div className="flex items-center gap-3.5">
              <motion.div
                whileHover={{ rotate: [-4, 6, -2, 0], scale: 1.06 }}
                transition={{ duration: 0.45 }}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/15 via-indigo-500/12 to-violet-500/15 text-accent-primary shadow-sm ring-1 ring-accent-primary/20 dark:from-sky-400/20 dark:via-indigo-400/15 dark:to-violet-400/20"
              >
                <Trash2 size={22} />
              </motion.div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-xl font-semibold tracking-tight text-tx-primary">{t("sidebar.trash")}</h1>
                  <motion.span
                    key={trash.items.length}
                    initial={{ scale: 0.85, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={MOTION_SPRING.snappy}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium tabular-nums ${
                      trash.items.length === 0
                        ? "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300"
                        : "bg-accent-primary/12 text-accent-primary"
                    }`}
                  >
                    {trash.items.length === 0 ? (
                      <>
                        <Sparkles size={12} aria-hidden="true" />
                        <span>{trash.items.length}</span>
                      </>
                    ) : (
                      <span>{trash.items.length}</span>
                    )}
                  </motion.span>
                </div>
                <p className="mt-0.5 text-xs text-tx-secondary">
                  {trash.items.length === 0
                    ? (isZh ? "干干净净，连一粒纸屑都没有" : "Clean and tidy, not a scrap in sight")
                    : (isZh ? "误删别慌，点一下就能把它们请回原来的位置" : "Deleted something by mistake? Bring it right back home in one click.")}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <motion.button
                type="button"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.95 }}
                disabled={trash.busy || trash.loading}
                onClick={() => void trash.reload()}
                aria-label={t("trashCenter.refresh")}
                className="group inline-flex h-9 w-9 items-center justify-center rounded-xl border border-app-border bg-app-elevated/80 text-tx-secondary shadow-xs backdrop-blur-sm transition-colors hover:border-accent-primary/35 hover:bg-app-hover hover:text-tx-primary disabled:cursor-not-allowed disabled:opacity-40"
              >
                <RefreshCw size={15} className={trash.loading ? "animate-spin" : "transition-transform duration-300 group-hover:rotate-90"} />
              </motion.button>
              <motion.button
                type="button"
                whileHover={disabled || !trash.items.length ? undefined : { scale: 1.02 }}
                whileTap={disabled || !trash.items.length ? undefined : { scale: 0.97 }}
                disabled={disabled || !trash.items.length}
                onClick={() => void operate("empty", [])}
                aria-label={t("trashCenter.empty")}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-xl border border-accent-danger/25 bg-accent-danger/5 px-3.5 text-sm font-medium text-accent-danger transition-colors hover:border-accent-danger/45 hover:bg-accent-danger/10 disabled:cursor-not-allowed disabled:border-app-border disabled:bg-transparent disabled:text-tx-tertiary disabled:opacity-45"
              >
                <Trash2 size={15} />
                <span>{t("trashCenter.empty")}</span>
              </motion.button>
            </div>
          </header>

          {/* 灵动控制胶囊卡：滑动分类 + 圆角搜索 + 批量操作 */}
          <section className="mb-5 space-y-3 rounded-2xl border border-app-border bg-app-elevated/75 p-3.5 shadow-xs backdrop-blur-md md:p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              {/* 滑动胶囊分类栏 */}
              <div
                className="inline-flex flex-wrap items-center gap-1 rounded-xl bg-app-bg/80 p-1 ring-1 ring-app-border/70"
                role="tablist"
                aria-label={t("trashCenter.types")}
              >
                {RESOURCE_TYPES.map((type) => {
                  const active = filter === type;
                  const count = typeCounts[type];
                  return (
                    <button
                      key={type}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-label={t(`trashCenter.${type}`)}
                      onClick={() => setFilter(type)}
                      className={`relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                        active ? "text-accent-primary" : "text-tx-secondary hover:text-tx-primary"
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId="trash-filter-pill"
                          transition={MOTION_SPRING.snappy}
                          className="absolute inset-0 rounded-lg bg-app-elevated shadow-xs ring-1 ring-accent-primary/20"
                        />
                      )}
                      <span className="relative z-10">{t(`trashCenter.${type}`)}</span>
                      {count > 0 && (
                        <span
                          className={`relative z-10 rounded-full px-1.5 py-0.2 text-[11px] tabular-nums ${
                            active ? "bg-accent-primary/12 text-accent-primary" : "bg-app-hover text-tx-tertiary"
                          }`}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* 圆润搜索框 */}
              <label className="group flex w-full items-center gap-2 rounded-xl border border-app-border bg-app-bg/80 px-3.5 py-2 text-tx-tertiary transition-all focus-within:border-accent-primary/50 focus-within:bg-app-elevated focus-within:ring-2 focus-within:ring-accent-primary/15 md:max-w-xs">
                <Search size={15} className="shrink-0 transition-colors group-focus-within:text-accent-primary" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t("trashCenter.search")}
                  aria-label={t("trashCenter.search")}
                  className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary placeholder:text-tx-tertiary outline-none"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label={isZh ? "清空搜索" : "Clear search"}
                    className="rounded-full p-0.5 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                  >
                    <X size={13} />
                  </button>
                )}
              </label>
            </div>

            {/* 全选与灵动批量操作条 */}
            <div className="flex min-h-[34px] flex-wrap items-center justify-between gap-2 border-t border-app-border/60 pt-2.5 text-sm">
              <label
                className={`inline-flex select-none items-center gap-2 text-xs font-medium ${
                  disabled || !visible.length ? "cursor-not-allowed text-tx-tertiary" : "cursor-pointer text-tx-secondary hover:text-tx-primary"
                }`}
              >
                <input
                  type="checkbox"
                  disabled={disabled || !visible.length}
                  checked={allVisibleSelected}
                  onChange={(event) => setSelected(
                    event.target.checked
                      ? [...new Set([...selected, ...visible.map((item) => item.id)])]
                      : selected.filter((id) => !visible.some((item) => item.id === id)),
                  )}
                  className="h-4 w-4 rounded accent-accent-primary"
                />
                <span>{t("trashCenter.selectAll")}</span>
              </label>

              <AnimatePresence mode="popLayout">
                {selectedItems.length > 0 && (
                  <motion.div
                    key="batch-bar"
                    initial={{ opacity: 0, y: -4, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.96 }}
                    transition={MOTION_SPRING.snappy}
                    className="flex flex-wrap items-center gap-2 rounded-xl bg-accent-primary/8 px-2.5 py-1 ring-1 ring-accent-primary/20"
                  >
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-primary">
                      <Check size={13} aria-hidden="true" />
                      {t("trashCenter.selected", { count: selectedItems.length })}
                    </span>
                    <button
                      type="button"
                      aria-label={t("trashCenter.restore")}
                      disabled={disabled || !selectedItems.every((item) => item.canRestore) || selectedItems.length > 500}
                      onClick={() => void operate("restore", selectedItems.map((item) => item.id))}
                      className="inline-flex items-center gap-1 rounded-lg bg-app-elevated px-2.5 py-1 text-xs font-medium text-tx-primary shadow-xs ring-1 ring-app-border transition-all hover:bg-emerald-500/10 hover:text-emerald-700 hover:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-emerald-300"
                    >
                      <RotateCcw size={13} />
                      <span>{t("trashCenter.restore")}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={t("trashCenter.permanent")}
                      disabled={disabled || !selectedItems.every((item) => item.canDeletePermanently) || selectedItems.length > 500}
                      onClick={() => void operate("permanent", selectedItems.map((item) => item.id))}
                      className="inline-flex items-center gap-1 rounded-lg bg-accent-danger/10 px-2.5 py-1 text-xs font-medium text-accent-danger transition-all hover:bg-accent-danger/18 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Trash2 size={13} />
                      <span>{t("trashCenter.permanent")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected([])}
                      aria-label={isZh ? "取消选择" : "Clear selection"}
                      className="rounded-lg p-1 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-tx-primary"
                    >
                      <X size={13} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </section>

          {/* 主内容区域 */}
          <div className="flex-1">
            {trash.error !== null ? (
              <motion.div
                role="alert"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="mx-auto my-8 max-w-md rounded-2xl border border-accent-danger/25 bg-accent-danger/5 p-6 text-center"
              >
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-danger/12 text-accent-danger">
                  <Trash2 size={22} />
                </div>
                <p className="font-medium text-accent-danger">{t("trashCenter.loadFailed")}</p>
                <p className="mt-1 text-sm text-tx-secondary">{trash.error}</p>
                <button
                  type="button"
                  aria-label={t("trashCenter.retry")}
                  onClick={() => void trash.reload()}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-app-border bg-app-elevated px-4 py-2 text-sm font-medium text-tx-primary shadow-xs transition-all hover:bg-app-hover"
                >
                  <RefreshCw size={14} />
                  <span>{t("trashCenter.retry")}</span>
                </button>
              </motion.div>
            ) : trash.loading ? (
              <div role="status" className="space-y-2.5 py-2">
                <p className="sr-only">{t("common.loading")}</p>
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="flex items-center gap-3.5 rounded-2xl border border-app-border/70 bg-app-elevated/60 px-4 py-3.5 animate-pulse"
                  >
                    <div className="h-4 w-4 rounded bg-app-hover" />
                    <div className="h-10 w-10 rounded-xl bg-app-hover" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-1/3 rounded bg-app-hover" />
                      <div className="h-3 w-1/2 rounded bg-app-hover" />
                    </div>
                  </div>
                ))}
              </div>
            ) : !visible.length ? (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, ease: MOTION_EASE.enter }}
                className="flex flex-col items-center justify-center rounded-3xl border border-dashed border-app-border/80 bg-app-elevated/40 px-6 py-14 text-center"
              >
                <PlayfulEmptyBin
                  isSearchEmpty={trash.items.length > 0}
                  onBoop={() => setBoopHint((prev) => !prev)}
                />
                <p className="text-base font-semibold text-tx-primary">
                  {t(trash.items.length ? "trashCenter.noMatches" : "trashCenter.emptyState")}
                </p>
                <p className="mt-1.5 max-w-md text-xs leading-relaxed text-tx-secondary">
                  {emptySubcopy}
                </p>
                {trash.items.length > 0 && (filter !== "all" || query.trim()) && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-xl border border-app-border bg-app-elevated px-3.5 py-1.5 text-xs font-medium text-tx-primary shadow-xs transition-all hover:border-accent-primary/40 hover:text-accent-primary"
                  >
                    <RotateCcw size={13} />
                    <span>{isZh ? "重置筛选条件" : "Reset filters"}</span>
                  </button>
                )}
              </motion.div>
            ) : (
              <ul className="space-y-2.5">
                {visible.map((item, index) => {
                  const meta = TYPE_META[item.resourceType];
                  const Icon = meta.icon;
                  const date = parseServerTime(item.deletedAt);
                  const failure = trash.result?.failures.find((entry) => entry.id === item.id);
                  const isChecked = selected.includes(item.id);
                  const typeLabel = item.resourceType === "note" && item.contentFormat === "markdown"
                    ? "Markdown"
                    : t(`trashCenter.${item.resourceType}`);
                  const locationText = item.originalPathHidden
                    ? t("trashCenter.hiddenPath")
                    : item.originalPath.join(" / ") || t("trashCenter.root");

                  return (
                    <motion.li
                      key={item.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.22, delay: staggerDelay(index, 0.025, 10), ease: MOTION_EASE.enter }}
                      className={`group flex min-w-0 flex-wrap items-center gap-3.5 rounded-2xl border px-3.5 py-3.5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm md:px-4 ${
                        isChecked
                          ? "border-accent-primary/45 bg-accent-primary/[0.04] shadow-xs"
                          : "border-app-border bg-app-elevated/90 hover:border-accent-primary/25"
                      }`}
                    >
                      <input
                        type="checkbox"
                        disabled={disabled}
                        aria-label={t("trashCenter.selectItem", { title: item.title })}
                        checked={isChecked}
                        onChange={(event) => setSelected(
                          event.target.checked
                            ? [...selected, item.id]
                            : selected.filter((id) => id !== item.id),
                        )}
                        className="h-4 w-4 shrink-0 rounded accent-accent-primary"
                      />

                      {/* 彩色马卡龙图标井 */}
                      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105 group-hover:-rotate-3 ${meta.wellClass}`}>
                        <Icon size={19} />
                      </div>

                      <div className="min-w-0 flex-1 basis-44">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="truncate font-medium text-tx-primary" title={item.title}>{item.title}</span>
                          <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium ${meta.chipClass}`}>
                            {typeLabel}
                          </span>
                          {item.isLocked && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-400/15 dark:text-amber-300">
                              <Lock size={11} aria-label={t("trashCenter.locked")} />
                              <span>{t("trashCenter.locked")}</span>
                            </span>
                          )}
                        </div>
                        <p className="mt-1 truncate text-xs text-tx-secondary" title={item.originalPath.join(" / ")}>
                          {t("trashCenter.originalPath")}：{locationText}
                        </p>
                        <p className="mt-0.5 text-[11px] tabular-nums text-tx-tertiary">
                          {t("trashCenter.deletedAt", {
                            date: date ? formatAppDateTime(date, undefined, undefined, i18n.language) : t("trashCenter.unknownDate"),
                          })}
                        </p>
                        {failure && (
                          <p role="alert" className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-accent-danger/10 px-2 py-0.5 text-xs text-accent-danger">
                            {failure.error}
                          </p>
                        )}
                      </div>

                      {/* 卡片操作按钮 */}
                      <div className="ml-auto flex flex-wrap items-center gap-2">
                        <motion.button
                          type="button"
                          whileTap={disabled || !item.canRestore ? undefined : { scale: 0.95 }}
                          disabled={disabled || !item.canRestore}
                          onClick={() => void operate("restore", [item.id])}
                          aria-label={t("trashCenter.restoreItem", { title: item.title })}
                          className="group/restore inline-flex items-center justify-center gap-1.5 rounded-xl border border-app-border bg-app-bg/70 px-3 py-1.5 text-xs font-medium text-tx-primary transition-all hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-emerald-300"
                        >
                          <RotateCcw size={14} className="transition-transform duration-300 group-hover/restore:-rotate-90" />
                          <span>{t("trashCenter.restore")}</span>
                        </motion.button>
                        <motion.button
                          type="button"
                          whileTap={disabled || !item.canDeletePermanently ? undefined : { scale: 0.95 }}
                          disabled={disabled || !item.canDeletePermanently}
                          onClick={() => void operate("permanent", [item.id])}
                          aria-label={t("trashCenter.deleteItem", { title: item.title })}
                          className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-app-border bg-app-bg/70 px-3 py-1.5 text-xs font-medium text-accent-danger transition-all hover:border-accent-danger/40 hover:bg-accent-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Trash2 size={14} />
                          <span>{t("trashCenter.permanent")}</span>
                        </motion.button>
                      </div>
                    </motion.li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* 底部温和安全提示胶囊 */}
          <footer className="mt-6 flex items-start gap-2 rounded-xl bg-app-elevated/50 px-3.5 py-2.5 text-xs text-tx-tertiary ring-1 ring-app-border/60">
            <ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent-primary/70" aria-hidden="true" />
            <p className="leading-relaxed">{t("trashCenter.protectedHint")}</p>
          </footer>
        </div>
      </div>
    </main>
  );
}
