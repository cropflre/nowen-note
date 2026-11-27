import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowUpRight,
  BrainCircuit,
  Clock,
  Folder,
  LayoutGrid,
  List,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAppDate } from "@/lib/dateTime";
import type { KnowledgeTreeNode } from "@/lib/knowledgeTreeApi";
import { buildMindMapOverviewItems, getMindMapCreationLocations, type MindMapOverviewFilter } from "@/lib/mindMapOverview";
import { loadMobileKnowledgeTreeRecentEntries } from "@/lib/mobileKnowledgeTree";
import { MOTION_EASE, MOTION_SPRING, staggerDelay } from "@/lib/motion";
import type { MindMapListItem } from "@/types";
import { cn } from "@/lib/utils";

interface CardPalette {
  bannerBg: string;
  wellClass: string;
  nodePrimary: string;
  nodeSoft: string;
  lineStroke: string;
}

const CARD_PALETTES: CardPalette[] = [
  {
    bannerBg: "from-sky-500/12 via-indigo-500/8 to-transparent dark:from-sky-400/16 dark:via-indigo-400/10",
    wellClass: "bg-sky-500/12 text-sky-600 ring-1 ring-sky-500/20 dark:bg-sky-400/15 dark:text-sky-300",
    nodePrimary: "fill-sky-500 dark:fill-sky-300",
    nodeSoft: "fill-indigo-400/80 dark:fill-indigo-300/80",
    lineStroke: "stroke-sky-500/45 dark:stroke-sky-300/45",
  },
  {
    bannerBg: "from-violet-500/12 via-fuchsia-500/8 to-transparent dark:from-violet-400/16 dark:via-fuchsia-400/10",
    wellClass: "bg-violet-500/12 text-violet-600 ring-1 ring-violet-500/20 dark:bg-violet-400/15 dark:text-violet-300",
    nodePrimary: "fill-violet-500 dark:fill-violet-300",
    nodeSoft: "fill-fuchsia-400/80 dark:fill-fuchsia-300/80",
    lineStroke: "stroke-violet-500/45 dark:stroke-violet-300/45",
  },
  {
    bannerBg: "from-emerald-500/12 via-teal-500/8 to-transparent dark:from-emerald-400/16 dark:via-teal-400/10",
    wellClass: "bg-emerald-500/12 text-emerald-600 ring-1 ring-emerald-500/20 dark:bg-emerald-400/15 dark:text-emerald-300",
    nodePrimary: "fill-emerald-500 dark:fill-emerald-300",
    nodeSoft: "fill-teal-400/80 dark:fill-teal-300/80",
    lineStroke: "stroke-emerald-500/45 dark:stroke-emerald-300/45",
  },
  {
    bannerBg: "from-amber-500/12 via-orange-500/8 to-transparent dark:from-amber-400/16 dark:via-orange-400/10",
    wellClass: "bg-amber-500/14 text-amber-600 ring-1 ring-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300",
    nodePrimary: "fill-amber-500 dark:fill-amber-300",
    nodeSoft: "fill-orange-400/80 dark:fill-orange-300/80",
    lineStroke: "stroke-amber-500/45 dark:stroke-amber-300/45",
  },
  {
    bannerBg: "from-rose-500/12 via-pink-500/8 to-transparent dark:from-rose-400/16 dark:via-pink-400/10",
    wellClass: "bg-rose-500/12 text-rose-600 ring-1 ring-rose-500/20 dark:bg-rose-400/15 dark:text-rose-300",
    nodePrimary: "fill-rose-500 dark:fill-rose-300",
    nodeSoft: "fill-pink-400/80 dark:fill-pink-300/80",
    lineStroke: "stroke-rose-500/45 dark:stroke-rose-300/45",
  },
];

function pickPalette(seed: string): CardPalette {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return CARD_PALETTES[Math.abs(hash) % CARD_PALETTES.length];
}

/** 迷你思维枝桠插画：悬停时分支轻巧舒展，传递“灵感发散”的灵动感。 */
function MiniMindMapPreview({ palette }: { palette: CardPalette }) {
  return (
    <svg
      viewBox="0 0 240 84"
      className="h-full w-full"
      fill="none"
      aria-hidden="true"
    >
      {/* 柔和思维连线 */}
      <path
        d="M84 42 C110 42, 118 20, 148 20"
        className={cn(palette.lineStroke, "transition-all duration-300")}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M84 42 C114 42, 126 42, 158 42"
        className={cn(palette.lineStroke, "transition-all duration-300")}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M84 42 C110 42, 118 64, 146 64"
        className={cn(palette.lineStroke, "transition-all duration-300")}
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      {/* 左侧主干小胶囊 */}
      <rect
        x="26"
        y="30"
        width="60"
        height="24"
        rx="12"
        className="fill-app-elevated stroke-app-border transition-transform duration-300 group-hover:scale-[1.03]"
        strokeWidth="1.5"
      />
      <circle cx="40" cy="42" r="4.5" className={palette.nodePrimary} />
      <rect x="49" y="39.5" width="26" height="5" rx="2.5" className="fill-tx-tertiary/35" />

      {/* 右侧三个悬停轻舒展的子节点 */}
      <g className="transition-transform duration-300 ease-out group-hover:translate-x-1.5 group-hover:-translate-y-0.5">
        <rect x="146" y="11" width="66" height="18" rx="9" className="fill-app-elevated/95 stroke-app-border" strokeWidth="1.2" />
        <circle cx="157" cy="20" r="3.5" className={palette.nodeSoft} />
        <rect x="165" y="18" width="34" height="4" rx="2" className="fill-tx-tertiary/30" />
      </g>
      <g className="transition-transform duration-300 ease-out group-hover:translate-x-2">
        <rect x="156" y="33" width="58" height="18" rx="9" className="fill-app-elevated/95 stroke-app-border" strokeWidth="1.2" />
        <circle cx="167" cy="42" r="3.5" className={palette.nodePrimary} />
        <rect x="175" y="40" width="28" height="4" rx="2" className="fill-tx-tertiary/30" />
      </g>
      <g className="transition-transform duration-300 ease-out group-hover:translate-x-1.5 group-hover:translate-y-0.5">
        <rect x="144" y="55" width="62" height="18" rx="9" className="fill-app-elevated/95 stroke-app-border" strokeWidth="1.2" />
        <circle cx="155" cy="64" r="3.5" className={palette.nodeSoft} />
        <rect x="163" y="62" width="30" height="4" rx="2" className="fill-tx-tertiary/30" />
      </g>
    </svg>
  );
}

/** 俏皮拟人化「思维云朵」空状态插画：悬停微晃，点击开心弹跳吐出新点子。 */
function PlayfulMindCloud({ isFilteredEmpty, onBoop }: { isFilteredEmpty: boolean; onBoop: () => void }) {
  const [boops, setBoops] = useState(0);

  return (
    <motion.button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      onClick={() => {
        setBoops((n) => n + 1);
        onBoop();
      }}
      className="group relative mx-auto mb-5 flex h-32 w-32 cursor-pointer items-center justify-center rounded-full focus:outline-none"
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.94 }}
      animate={boops > 0 ? { y: [0, -10, 0], rotate: [0, -6, 6, 0] } : { y: [0, -4, 0] }}
      transition={boops > 0
        ? { duration: 0.45, ease: MOTION_EASE.enter }
        : { duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
    >
      <span className="pointer-events-none absolute inset-1.5 rounded-full bg-gradient-to-tr from-violet-400/20 via-sky-400/18 to-emerald-400/20 blur-xl" />

      <motion.span
        className="pointer-events-none absolute right-2 top-3 text-amber-400 dark:text-amber-300"
        animate={{ y: [0, -5, 0], rotate: [0, 18, 0], opacity: [0.7, 1, 0.7] }}
        transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
      >
        <Sparkles size={16} />
      </motion.span>
      <motion.span
        className="pointer-events-none absolute left-2 top-6 h-2.5 w-2.5 rounded-full bg-violet-400/55"
        animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0.95, 0.5] }}
        transition={{ duration: 2.3, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.span
        className="pointer-events-none absolute bottom-4 right-3 h-2 w-2 rounded-full bg-emerald-400/55"
        animate={{ y: [0, 4, 0], opacity: [0.45, 0.9, 0.45] }}
        transition={{ duration: 2.9, repeat: Infinity, ease: "easeInOut", delay: 0.4 }}
      />

      {isFilteredEmpty ? (
        <svg viewBox="0 0 96 96" className="relative h-24 w-24 drop-shadow-sm" fill="none">
          <circle cx="44" cy="44" r="24" className="fill-app-elevated stroke-violet-500/65 dark:stroke-violet-300/70" strokeWidth="3.2" />
          <path d="M62 62L78 78" className="stroke-violet-500/75 dark:stroke-violet-300/80" strokeWidth="5.2" strokeLinecap="round" />
          <circle cx="37" cy="41" r="2.6" className="fill-tx-primary" />
          <circle cx="51" cy="41" r="2.6" className="fill-tx-primary" />
          <path d="M39 51C41.5 48.5 46.5 48.5 49 51" className="stroke-tx-secondary" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="31" cy="46" r="2.2" className="fill-rose-400/50" />
          <circle cx="57" cy="46" r="2.2" className="fill-rose-400/50" />
        </svg>
      ) : (
        <svg viewBox="0 0 96 96" className="relative h-24 w-24 drop-shadow-sm" fill="none">
          {/* 顶部三条俏皮发散天线节点 */}
          <path d="M48 34V18" className="stroke-violet-500/65 dark:stroke-violet-300/70" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M35 39L22 27" className="stroke-sky-500/65 dark:stroke-sky-300/70" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M61 39L74 27" className="stroke-emerald-500/65 dark:stroke-emerald-300/70" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="48" cy="15" r="4.5" className="fill-violet-500 dark:fill-violet-300 transition-transform duration-300 group-hover:-translate-y-1" />
          <circle cx="19" cy="24" r="4" className="fill-sky-500 dark:fill-sky-300" />
          <circle cx="77" cy="24" r="4" className="fill-emerald-500 dark:fill-emerald-300" />
          {/* 圆润微笑中心气泡 */}
          <rect
            x="23"
            y="36"
            width="50"
            height="38"
            rx="19"
            className="fill-app-elevated stroke-violet-500/60 dark:stroke-violet-300/75"
            strokeWidth="2.6"
          />
          <circle cx="39" cy="53" r="2.8" className="fill-tx-primary" />
          <circle cx="57" cy="53" r="2.8" className="fill-tx-primary" />
          <path d="M43 60.5C45.3 63.5 50.7 63.5 53 60.5" className="stroke-violet-500 dark:stroke-violet-300" strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="33.5" cy="57.5" r="2.6" className="fill-rose-400/45" />
          <circle cx="62.5" cy="57.5" r="2.6" className="fill-rose-400/45" />
        </svg>
      )}
    </motion.button>
  );
}

export default function MindMapOverview({
  maps,
  treeNodes,
  loading,
  onOpen,
  onCreate,
  onToggleStar,
  onDelete,
  onContextMenu,
}: {
  maps: MindMapListItem[];
  treeNodes: KnowledgeTreeNode[];
  loading: boolean;
  onOpen: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onToggleStar: (id: string) => void;
  onDelete: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, map: MindMapListItem) => void;
}) {
  const { i18n } = useTranslation();
  const isZh = (i18n.resolvedLanguage || i18n.language || "zh").startsWith("zh");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MindMapOverviewFilter>("all");
  const [viewLayout, setViewLayout] = useState<"grid" | "list">("grid");
  const [parentId, setParentId] = useState<string | null>(null);
  const [boopHint, setBoopHint] = useState(false);
  const [recentEntries] = useState(() => loadMobileKnowledgeTreeRecentEntries());

  const locations = useMemo(() => getMindMapCreationLocations(treeNodes), [treeNodes]);
  const selectedParentId = parentId && locations.some((location) => location.id === parentId) ? parentId : null;
  const rows = useMemo(
    () => buildMindMapOverviewItems(maps, treeNodes, recentEntries, query, filter),
    [maps, treeNodes, recentEntries, query, filter],
  );

  const filterCounts = useMemo(() => ({
    all: maps.length,
    recent: buildMindMapOverviewItems(maps, treeNodes, recentEntries, "", "recent").length,
    starred: maps.filter((m) => m.starred).length,
  }), [maps, treeNodes, recentEntries]);

  const filterOptions: Array<{ value: MindMapOverviewFilter; label: string; icon: typeof Sparkles }> = [
    { value: "all", label: isZh ? "全部" : "All", icon: Sparkles },
    { value: "recent", label: isZh ? "最近使用" : "Recent", icon: Clock },
    { value: "starred", label: isZh ? "收藏" : "Favorites", icon: Star },
  ];

  const resetFilters = () => {
    setQuery("");
    setFilter("all");
  };

  return (
    <section
      className="relative h-full w-full overflow-y-auto bg-app-bg text-tx-primary"
      aria-label={isZh ? "全部脑图" : "All mind maps"}
    >
      {/* 柔和思维星图渐变氛围背景 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-60 bg-[radial-gradient(ellipse_65%_80%_at_15%_0%,rgba(139,92,246,0.12),transparent_70%),radial-gradient(ellipse_55%_75%_at_85%_0%,rgba(56,189,248,0.11),transparent_70%)] dark:bg-[radial-gradient(ellipse_65%_80%_at_15%_0%,rgba(139,92,246,0.16),transparent_70%),radial-gradient(ellipse_55%_75%_at_85%_0%,rgba(56,189,248,0.14),transparent_70%)]"
      />

      <div className="relative mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
        {/* 顶部灵动头栏 */}
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <motion.div
              whileHover={{ rotate: [-4, 6, -2, 0], scale: 1.07 }}
              transition={{ duration: 0.45 }}
              className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/18 via-indigo-500/14 to-sky-500/18 text-accent-primary shadow-sm ring-1 ring-accent-primary/20 dark:from-violet-400/22 dark:via-indigo-400/16 dark:to-sky-400/22"
            >
              <BrainCircuit size={23} />
              <span className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400/50 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500 dark:bg-violet-300" />
              </span>
            </motion.div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-xl font-semibold tracking-tight text-tx-primary">{isZh ? "全部脑图" : "All mind maps"}</h1>
                <motion.span
                  key={maps.length}
                  initial={{ scale: 0.85, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={MOTION_SPRING.snappy}
                  className="inline-flex items-center gap-1 rounded-full bg-accent-primary/12 px-2.5 py-0.5 text-xs font-medium tabular-nums text-accent-primary"
                >
                  <Sparkles size={11} aria-hidden="true" />
                  <span>{maps.length}</span>
                </motion.span>
              </div>
              <p className="mt-0.5 text-xs text-tx-secondary">
                {isZh
                  ? `共 ${maps.length} 张脑图 · 与笔记共用左侧目录，随时把灵感连成星图`
                  : `${maps.length} mind maps · Organized in the same tree as notes`}
              </p>
            </div>
          </div>

          {/* 轻盈创建胶囊 */}
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-app-border bg-app-elevated/80 p-1.5 shadow-xs backdrop-blur-md">
            <label
              className="flex items-center gap-1 pl-2 text-xs font-medium text-tx-secondary"
              htmlFor="mindmap-create-location"
            >
              <Folder size={13} className="text-amber-500 dark:text-amber-300" aria-hidden="true" />
              <span>{isZh ? "保存到" : "Save in"}</span>
            </label>
            <select
              id="mindmap-create-location"
              value={selectedParentId || ""}
              onChange={(event) => setParentId(event.target.value || null)}
              className="max-w-[210px] rounded-xl border border-app-border/80 bg-app-bg/90 px-2.5 py-1.5 text-xs font-medium text-tx-primary outline-none transition-colors focus:border-accent-primary/50"
            >
              <option value="">{isZh ? "当前空间根目录" : "Workspace root"}</option>
              {locations.map((location) => <option key={location.id} value={location.id}>{location.path}</option>)}
            </select>
            <motion.button
              type="button"
              whileHover={{ scale: 1.03, y: -1 }}
              whileTap={{ scale: 0.96 }}
              onClick={() => onCreate(selectedParentId)}
              className="group/new inline-flex items-center gap-1.5 rounded-xl bg-accent-primary px-3.5 py-1.5 text-sm font-medium text-tx-inverse shadow-sm transition-opacity hover:opacity-95"
            >
              <Plus size={16} className="transition-transform duration-200 group-hover/new:rotate-90" />
              <span>{isZh ? "新建脑图" : "New mind map"}</span>
            </motion.button>
          </div>
        </header>

        {/* 灵动搜索 + 滑动胶囊筛选 + 视图切换 */}
        <div className="mt-5 flex flex-col gap-3 rounded-2xl border border-app-border bg-app-elevated/75 p-3 shadow-xs backdrop-blur-md md:flex-row md:items-center md:justify-between md:px-4">
          <label className="group flex min-w-[200px] flex-1 items-center gap-2 rounded-xl border border-app-border bg-app-bg/85 px-3.5 py-2 text-tx-tertiary transition-all focus-within:border-accent-primary/50 focus-within:bg-app-elevated focus-within:ring-2 focus-within:ring-accent-primary/15">
            <Search size={15} className="shrink-0 transition-colors group-focus-within:text-accent-primary" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={isZh ? "搜索脑图或所在目录" : "Search mind maps or folders"}
              aria-label={isZh ? "搜索脑图" : "Search mind maps"}
              className="min-w-0 flex-1 bg-transparent text-sm text-tx-primary outline-none placeholder:text-tx-tertiary"
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

          <div className="flex flex-wrap items-center justify-between gap-2 md:justify-end">
            {/* 滑动胶囊筛选 */}
            <div
              className="inline-flex items-center gap-1 rounded-xl bg-app-bg/85 p-1 ring-1 ring-app-border/70"
              aria-label={isZh ? "脑图筛选" : "Mind map filter"}
            >
              {filterOptions.map(({ value, label, icon: FilterIcon }) => {
                const active = filter === value;
                const count = filterCounts[value];
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setFilter(value)}
                    aria-pressed={active}
                    className={cn(
                      "relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                      active ? "text-accent-primary" : "text-tx-secondary hover:text-tx-primary",
                    )}
                  >
                    {active && (
                      <motion.span
                        layoutId="mindmap-filter-pill"
                        transition={MOTION_SPRING.snappy}
                        className="absolute inset-0 rounded-lg bg-app-elevated shadow-xs ring-1 ring-accent-primary/20"
                      />
                    )}
                    <FilterIcon
                      size={12}
                      className={cn("relative z-10", value === "starred" && active && "fill-amber-400 text-amber-400")}
                      aria-hidden="true"
                    />
                    <span className="relative z-10">{label}</span>
                    {count > 0 && (
                      <span
                        className={cn(
                          "relative z-10 rounded-full px-1.5 text-[10px] tabular-nums",
                          active ? "bg-accent-primary/12 text-accent-primary" : "bg-app-hover text-tx-tertiary",
                        )}
                      >
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* 网格 / 列表切换 */}
            <div
              className="inline-flex items-center rounded-xl bg-app-bg/85 p-1 ring-1 ring-app-border/70"
              role="group"
              aria-label={isZh ? "切换视图" : "Switch view"}
            >
              <button
                type="button"
                onClick={() => setViewLayout("grid")}
                aria-pressed={viewLayout === "grid"}
                aria-label={isZh ? "卡片视图" : "Card view"}
                className={cn(
                  "rounded-lg p-1.5 transition-colors",
                  viewLayout === "grid" ? "bg-app-elevated text-accent-primary shadow-xs" : "text-tx-tertiary hover:text-tx-primary",
                )}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                onClick={() => setViewLayout("list")}
                aria-pressed={viewLayout === "list"}
                aria-label={isZh ? "列表视图" : "List view"}
                className={cn(
                  "rounded-lg p-1.5 transition-colors",
                  viewLayout === "list" ? "bg-app-elevated text-accent-primary shadow-xs" : "text-tx-tertiary hover:text-tx-primary",
                )}
              >
                <List size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* 主内容区 */}
        {loading ? (
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status">
            <span className="sr-only">{isZh ? "加载中…" : "Loading…"}</span>
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="overflow-hidden rounded-2xl border border-app-border/70 bg-app-elevated/60 animate-pulse"
              >
                <div className="h-24 bg-app-hover/60" />
                <div className="space-y-2 p-4">
                  <div className="h-4 w-2/3 rounded bg-app-hover" />
                  <div className="h-3 w-1/2 rounded bg-app-hover" />
                </div>
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: MOTION_EASE.enter }}
            className="mt-6 flex flex-col items-center justify-center rounded-3xl border border-dashed border-app-border/80 bg-app-elevated/40 px-6 py-16 text-center"
          >
            <PlayfulMindCloud
              isFilteredEmpty={maps.length > 0}
              onBoop={() => setBoopHint((prev) => !prev)}
            />
            <p className="text-base font-semibold text-tx-primary">
              {maps.length === 0
                ? (isZh ? "还没有脑图，可从左侧目录或这里新建" : "No mind maps yet. Create one here or in the tree.")
                : (isZh ? "没有匹配的脑图" : "No matching mind maps")}
            </p>
            <p className="mt-1.5 max-w-md text-xs leading-relaxed text-tx-secondary">
              {maps.length === 0
                ? boopHint
                  ? (isZh ? "叮！小云朵晃出了一颗新点子，快点击下方按钮画下来吧～" : "Ding! A fresh spark popped out — start mapping it now!")
                  : (isZh ? "从一个中心想法出发，自由长出分支，让复杂思路一秒变清晰。" : "Start with one central thought and watch your ideas branch out cleanly.")
                : (isZh ? "换个关键词或者回到「全部」看看，灵感可能正躲在别的目录里～" : "Try a different keyword or switch back to All.")}
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              {maps.length === 0 ? (
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.03, y: -1 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => onCreate(selectedParentId)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-tx-inverse shadow-sm"
                >
                  <Plus size={16} />
                  <span>{isZh ? "创建第一张脑图" : "Create first mind map"}</span>
                </motion.button>
              ) : (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-app-border bg-app-elevated px-3.5 py-1.5 text-xs font-medium text-tx-primary shadow-xs transition-all hover:border-accent-primary/40 hover:text-accent-primary"
                >
                  <RotateCcw size={13} />
                  <span>{isZh ? "查看全部脑图" : "Show all mind maps"}</span>
                </button>
              )}
            </div>
          </motion.div>
        ) : viewLayout === "grid" ? (
          <div className="mt-5 grid grid-cols-1 gap-4 pb-10 sm:grid-cols-2 lg:grid-cols-3">
            {rows.map(({ map, path }, index) => {
              const palette = pickPalette(map.id);
              return (
                <motion.article
                  key={map.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.24, delay: staggerDelay(index, 0.03, 9), ease: MOTION_EASE.enter }}
                  onContextMenu={(event) => onContextMenu(event, map)}
                  className="group relative flex flex-col overflow-hidden rounded-2xl border border-app-border bg-app-elevated/90 shadow-xs transition-all duration-250 hover:-translate-y-1 hover:border-accent-primary/35 hover:shadow-md"
                >
                  {/* 悬浮快捷操作 */}
                  <div className="absolute right-2.5 top-2.5 z-10 flex items-center gap-1">
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.85 }}
                      onClick={() => onToggleStar(map.id)}
                      aria-label={map.starred ? (isZh ? "取消收藏" : "Remove favorite") : (isZh ? "收藏" : "Favorite")}
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-lg border border-app-border/70 bg-app-elevated/90 backdrop-blur-sm transition-all hover:border-amber-400/50 hover:text-amber-500",
                        map.starred ? "text-amber-400 opacity-100" : "text-tx-tertiary opacity-80 group-hover:opacity-100",
                      )}
                    >
                      <Star size={14} className={map.starred ? "fill-amber-400 text-amber-400" : ""} />
                    </motion.button>
                    <motion.button
                      type="button"
                      whileTap={{ scale: 0.85 }}
                      onClick={() => {
                        if (window.confirm(isZh ? `将“${map.title}”移入回收站？` : `Move “${map.title}” to Trash?`)) {
                          onDelete(map.id);
                        }
                      }}
                      aria-label={isZh ? "删除脑图" : "Delete mind map"}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-app-border/70 bg-app-elevated/90 text-tx-tertiary opacity-0 backdrop-blur-sm transition-all hover:border-accent-danger/40 hover:bg-accent-danger/10 hover:text-accent-danger focus:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 size={14} />
                    </motion.button>
                  </div>

                  {/* 点击整卡打开画布 */}
                  <button
                    type="button"
                    onClick={() => onOpen(map.id)}
                    className="flex flex-1 flex-col text-left focus:outline-none"
                  >
                    {/* 顶部点阵微型思维画布 */}
                    <div
                      className="relative h-24 w-full overflow-hidden border-b border-app-border/60 px-2 py-2"
                      style={{
                        backgroundImage: "radial-gradient(circle, rgba(148, 163, 184, 0.28) 1px, transparent 1px)",
                        backgroundSize: "14px 14px",
                      }}
                    >
                      <div className={cn("pointer-events-none absolute inset-0 bg-gradient-to-br", palette.bannerBg)} />
                      <div className="relative h-full w-full">
                        <MiniMindMapPreview palette={palette} />
                      </div>
                    </div>

                    {/* 卡片文字内容 */}
                    <div className="flex flex-1 flex-col justify-between p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-transform duration-200 group-hover:scale-105 group-hover:-rotate-3", palette.wellClass)}>
                            <BrainCircuit size={14} />
                          </span>
                          <span className="truncate text-sm font-semibold text-tx-primary group-hover:text-accent-primary transition-colors">
                            {map.title}
                          </span>
                        </div>
                        <span className="mt-2.5 inline-flex max-w-full items-center gap-1 rounded-md bg-app-bg/80 px-2 py-0.5 text-[11px] text-tx-secondary ring-1 ring-app-border/60">
                          <Folder size={11} className="shrink-0 text-amber-500/80 dark:text-amber-300/80" />
                          <span className="truncate">{path}</span>
                        </span>
                      </div>

                      <div className="mt-4 flex items-center justify-between border-t border-app-border/50 pt-2.5 text-[11px] text-tx-tertiary">
                        <span className="tabular-nums">{formatAppDate(map.updatedAt)}</span>
                        <span className="inline-flex items-center gap-0.5 font-medium text-accent-primary opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100">
                          <span>{isZh ? "进入画布" : "Open"}</span>
                          <ArrowUpRight size={13} />
                        </span>
                      </div>
                    </div>
                  </button>
                </motion.article>
              );
            })}
          </div>
        ) : (
          <div className="mt-5 space-y-2.5 pb-10">
            {rows.map(({ map, path }, index) => {
              const palette = pickPalette(map.id);
              return (
                <motion.div
                  key={map.id}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: staggerDelay(index, 0.025, 10), ease: MOTION_EASE.enter }}
                  onContextMenu={(event) => onContextMenu(event, map)}
                  className="group flex items-center gap-2.5 rounded-2xl border border-app-border bg-app-elevated/90 px-3.5 py-3 shadow-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-accent-primary/35 hover:shadow-sm"
                >
                  <button type="button" onClick={() => onOpen(map.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105 group-hover:-rotate-3", palette.wellClass)}>
                      <BrainCircuit size={19} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-tx-primary transition-colors group-hover:text-accent-primary">{map.title}</span>
                      <span className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-xs text-tx-tertiary">
                        <Folder size={12} className="shrink-0 text-amber-500/80 dark:text-amber-300/80" />
                        <span className="truncate">{path}</span>
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-xs tabular-nums text-tx-tertiary sm:inline">{formatAppDate(map.updatedAt)}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleStar(map.id)}
                    aria-label={map.starred ? (isZh ? "取消收藏" : "Remove favorite") : (isZh ? "收藏" : "Favorite")}
                    className="rounded-xl p-2 text-tx-tertiary transition-colors hover:bg-app-hover hover:text-amber-500"
                  >
                    <Star size={16} className={map.starred ? "fill-amber-400 text-amber-400" : ""} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(isZh ? `将“${map.title}”移入回收站？` : `Move “${map.title}” to Trash?`)) {
                        onDelete(map.id);
                      }
                    }}
                    aria-label={isZh ? "删除脑图" : "Delete mind map"}
                    className="rounded-xl p-2 text-tx-tertiary transition-colors hover:bg-accent-danger/10 hover:text-accent-danger"
                  >
                    <Trash2 size={16} />
                  </button>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
