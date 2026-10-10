/**
 * TokenUsageStats · 令牌使用统计概览
 * ---------------------------------------------------------------------------
 * 在 TokenManagement 顶部展示一张"过去 N 天的调用统计"卡片，由 3 部分组成：
 *
 *   1. 主指标：总调用次数 + 环比变化（绿涨红跌 + 百分比）
 *   2. 柱状图：手写零依赖 SVG，逐日柱形 + hover tooltip
 *   3. Top 令牌：按调用量降序的 mini bar list
 *
 * 设计原则：
 *   - 零图表库依赖（recharts ~200KB / chart.js ~150KB 都太重）
 *   - 完全适配亮色 / 暗色 / 高对比度三种模式
 *   - 当总调用量为 0 时显示空态而不是空白图表
 *   - 7 / 30 / 90 天三档切换，沿用 GitHub Insights 的常见档位
 *   - 数字与图形通过 framer-motion 做轻微进场，与 TokenManagement 整体节奏一致
 *
 * 与后端 GET /api/tokens/usage 配套，所有数据均来自接口（前端不做随机/mock）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  BarChart3,
  Loader2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";

// 与后端 GET /api/tokens/usage 返回结构一致
interface UsageData {
  days: number;
  total: number;
  prevTotal: number;
  series: Array<{ day: string; count: number }>;
  byToken: Array<{ tokenId: string; name: string; count: number }>;
}

const RANGE_OPTIONS = [7, 30, 90] as const;
type RangeDays = (typeof RANGE_OPTIONS)[number];

/**
 * 把 ISO 日 (YYYY-MM-DD) 转成短标签：
 *   - 月-日（中文 "5/13"，英文 "May 13"）
 * 采用 toLocaleDateString 自动适配 i18n 语言。
 */
function formatDayShort(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

/** 数字千分位 + 极大值简写：1234 → 1,234；12345 → 12.3k */
function formatBigNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return n.toLocaleString();
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/** 计算环比百分比（防 0 除）：返回 { delta, label, kind } */
function computeDelta(curr: number, prev: number) {
  if (prev === 0 && curr === 0) return { kind: "flat" as const, label: "—", pct: 0 };
  if (prev === 0) return { kind: "up" as const, label: "+∞", pct: Infinity };
  const pct = ((curr - prev) / prev) * 100;
  if (Math.abs(pct) < 0.5) return { kind: "flat" as const, label: "0%", pct };
  const sign = pct > 0 ? "+" : "";
  return {
    kind: pct > 0 ? ("up" as const) : ("down" as const),
    label: `${sign}${pct.toFixed(0)}%`,
    pct,
  };
}

// ===========================================================================
// 主组件
// ===========================================================================
export default function TokenUsageStats({ refreshKey }: { refreshKey: string }): JSX.Element | null {
  const { t } = useTranslation();
  const [days, setDays] = useState<RangeDays>(7);
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    async (d: RangeDays) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.tokens.usage(d);
        setData(res);
      } catch (e: any) {
        setError(e?.message || t("tokens.usage.loadFail", { defaultValue: "加载失败" }));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void reload(days);
  }, [days, reload, refreshKey]);

  const delta = useMemo(
    () => (data ? computeDelta(data.total, data.prevTotal) : null),
    [data],
  );

  // 静默错误：用户没有任何 token 使用过时也是 0/0/[]，不做特殊处理
  if (error) {
    return (
      <div className="px-3 py-2.5 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 text-xs text-zinc-500 dark:text-zinc-400">
        {error}
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-gradient-to-br from-white to-indigo-50/30 dark:from-zinc-900/60 dark:to-indigo-500/5 p-4 sm:p-5"
    >
      {/* ===== 顶栏：标题 + 切换 ===== */}
      <div className="flex items-center justify-between gap-3 mb-3.5">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-indigo-100 dark:bg-indigo-500/15 flex items-center justify-center flex-shrink-0">
            <Activity className="w-4 h-4 text-indigo-600 dark:text-indigo-300" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
              {t("tokens.usage.title", { defaultValue: "使用概览" })}
            </h3>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
              {t("tokens.usage.subtitle", {
                defaultValue: "汇总你所有令牌的调用情况",
              })}
            </p>
          </div>
        </div>

        {/* 时间范围切换 */}
        <div className="inline-flex rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white/60 dark:bg-zinc-900/40 p-0.5 flex-shrink-0">
          {RANGE_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              disabled={loading}
              className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all disabled:opacity-50 ${
                days === d
                  ? "bg-indigo-600 text-white shadow-sm"
                  : "text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              {t("tokens.usage.daysLabel", { defaultValue: "{{n}}天", n: d })}
            </button>
          ))}
        </div>
      </div>

      {/* ===== 主指标 + 图表 ===== */}
      {loading && !data ? (
        <div className="py-8 flex items-center justify-center text-xs text-zinc-500 dark:text-zinc-400">
          <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
          {t("tokens.usage.loading", { defaultValue: "加载统计..." })}
        </div>
      ) : !data || data.total === 0 ? (
        <EmptyUsage days={days} />
      ) : (
        <div className="space-y-4">
          {/* 主数字 + 环比 */}
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="text-3xl font-bold text-zinc-900 dark:text-zinc-100 tabular-nums">
                  {formatBigNumber(data.total)}
                </span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  {t("tokens.usage.callsUnit", { defaultValue: "次调用" })}
                </span>
                {delta && <DeltaBadge {...delta} />}
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">
                {t("tokens.usage.compareHint", {
                  defaultValue: "对比上一个 {{n}} 天周期",
                  n: data.days,
                })}
              </p>
            </div>
          </div>

          {/* 柱状图 */}
          <UsageBarChart series={data.series} />

          {/* Top 令牌 */}
          {data.byToken.length > 0 && (
            <TopTokensList byToken={data.byToken} total={data.total} />
          )}
        </div>
      )}
    </motion.div>
  );
}

// ===========================================================================
// 子组件：环比徽章
// ===========================================================================
function DeltaBadge({
  kind,
  label,
}: {
  kind: "up" | "down" | "flat";
  label: string;
  pct: number;
}): JSX.Element {
  const palette =
    kind === "up"
      ? "bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
      : kind === "down"
        ? "bg-red-100 dark:bg-red-500/15 text-red-700 dark:text-red-300"
        : "bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300";

  const Icon = kind === "up" ? TrendingUp : kind === "down" ? TrendingDown : Minus;

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium ${palette}`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

// ===========================================================================
// 子组件：柱状图（零依赖 SVG）
// ===========================================================================
function UsageBarChart({
  series,
}: {
  series: Array<{ day: string; count: number }>;
}): JSX.Element {
  const { t } = useTranslation();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // 视图盒尺寸（保持 4:1 比例，自适应宽度）
  const VB_W = 600;
  const VB_H = 140;
  const PADDING_X = 4;
  const PADDING_TOP = 14; // 顶部留白让数字 tooltip 不被截
  const PADDING_BOTTOM = 18; // 底部留 axis label
  const CHART_H = VB_H - PADDING_TOP - PADDING_BOTTOM;

  const max = Math.max(1, ...series.map((s) => s.count));
  const n = series.length;
  // 柱宽 = 总宽 / n - 间距
  const slotW = (VB_W - PADDING_X * 2) / n;
  const barW = Math.max(2, slotW * 0.65);

  // 决定 x 轴刻度密度：>14 时只显示每隔几个；不然全部
  const labelStep = n <= 7 ? 1 : n <= 14 ? 2 : n <= 30 ? 5 : 10;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        className="w-full h-32 sm:h-36"
        preserveAspectRatio="none"
        role="img"
        aria-label={t("tokens.usage.chartAria", {
          defaultValue: "每日令牌调用量柱状图",
        })}
      >
        {/* 背景网格：3 条横线（25/50/75/100% 高度） */}
        {[0.25, 0.5, 0.75].map((p) => {
          const y = PADDING_TOP + CHART_H * (1 - p);
          return (
            <line
              key={p}
              x1={PADDING_X}
              x2={VB_W - PADDING_X}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.06}
              strokeDasharray="2 4"
              className="text-zinc-900 dark:text-zinc-100"
            />
          );
        })}

        {/* 柱形 */}
        {series.map((d, i) => {
          const h = (d.count / max) * CHART_H;
          const x = PADDING_X + i * slotW + (slotW - barW) / 2;
          const y = PADDING_TOP + CHART_H - h;
          const isHovered = hoverIdx === i;
          const isZero = d.count === 0;

          return (
            <g
              key={d.day}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              onFocus={() => setHoverIdx(i)}
              onBlur={() => setHoverIdx(null)}
              tabIndex={0}
              style={{ cursor: "default" }}
            >
              {/* 透明大判定框（hover 命中区，slot 整个） */}
              <rect
                x={PADDING_X + i * slotW}
                y={PADDING_TOP}
                width={slotW}
                height={CHART_H}
                fill="transparent"
              />
              {/* 实柱 */}
              <rect
                x={x}
                y={isZero ? PADDING_TOP + CHART_H - 1.5 : y}
                width={barW}
                height={isZero ? 1.5 : Math.max(h, 1.5)}
                rx={1.5}
                className={
                  isZero
                    ? "fill-zinc-300 dark:fill-zinc-700"
                    : isHovered
                      ? "fill-indigo-600 dark:fill-indigo-400"
                      : "fill-indigo-500/85 dark:fill-indigo-400/85"
                }
              />
              {/* hover 数字 */}
              {isHovered && !isZero && (
                <text
                  x={x + barW / 2}
                  y={y - 4}
                  textAnchor="middle"
                  className="fill-zinc-900 dark:fill-zinc-100"
                  fontSize="10"
                  fontWeight="600"
                >
                  {d.count}
                </text>
              )}
              {/* x 轴标签 */}
              {(i === n - 1 || i % labelStep === 0) && (
                <text
                  x={x + barW / 2}
                  y={VB_H - 5}
                  textAnchor="middle"
                  className="fill-zinc-400 dark:fill-zinc-500"
                  fontSize="9"
                >
                  {formatDayShort(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ===========================================================================
// 子组件：Top 令牌
// ===========================================================================
function TopTokensList({
  byToken,
  total,
}: {
  byToken: Array<{ tokenId: string; name: string; count: number }>;
  total: number;
}): JSX.Element {
  const { t } = useTranslation();
  // 仅展示前 5
  const top = byToken.slice(0, 5);

  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2 text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
        <BarChart3 className="w-3 h-3" />
        {t("tokens.usage.topTitle", { defaultValue: "活跃令牌排行" })}
      </div>
      <ul className="space-y-1.5">
        {top.map((tk) => {
          const pct = total > 0 ? (tk.count / total) * 100 : 0;
          return (
            <li key={tk.tokenId} className="flex items-center gap-2 text-xs">
              <span className="flex-1 min-w-0 truncate text-zinc-700 dark:text-zinc-200">
                {tk.name}
              </span>
              {/* 进度条 */}
              <div className="w-24 sm:w-32 h-1.5 rounded-full bg-zinc-200/70 dark:bg-zinc-800 overflow-hidden flex-shrink-0">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-400 dark:from-indigo-400 dark:to-indigo-300"
                  style={{ width: `${Math.max(pct, 2)}%` }}
                />
              </div>
              <span className="w-10 text-right tabular-nums text-zinc-600 dark:text-zinc-300 flex-shrink-0">
                {formatBigNumber(tk.count)}
              </span>
              <span className="w-10 text-right tabular-nums text-zinc-400 dark:text-zinc-500 flex-shrink-0">
                {pct.toFixed(0)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ===========================================================================
// 子组件：空状态
// ===========================================================================
function EmptyUsage({ days }: { days: number }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="py-6 flex flex-col items-center text-center">
      <div className="w-10 h-10 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center mb-2.5">
        <Activity className="w-4 h-4 text-zinc-400 dark:text-zinc-500" />
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs leading-relaxed">
        {t("tokens.usage.empty", {
          defaultValue: "过去 {{n}} 天还没有任何令牌调用。让你的应用开始干活吧 ✨",
          n: days,
        })}
      </p>
    </div>
  );
}
