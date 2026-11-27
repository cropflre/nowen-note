import React, { useState } from "react";
import { motion } from "framer-motion";
import { Inbox, Search, CalendarDays, FileText, BellOff, Link2, FolderOpen, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MOTION_EASE } from "@/lib/motion";
import { cn } from "@/lib/utils";

export type TaskEmptyStateType =
  | "no-tasks"
  | "no-search"
  | "no-scheduled"
  | "no-templates"
  | "no-reminders"
  | "no-dependencies"
  | "no-projects";

interface TaskEmptyStateProps {
  type: TaskEmptyStateType;
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

const COMPACT_ICONS: Record<TaskEmptyStateType, React.ReactNode> = {
  "no-tasks": <Inbox size={22} />,
  "no-search": <Search size={22} />,
  "no-scheduled": <CalendarDays size={22} />,
  "no-templates": <FileText size={22} />,
  "no-reminders": <BellOff size={22} />,
  "no-dependencies": <Link2 size={22} />,
  "no-projects": <FolderOpen size={22} />,
};

const MASCOT_BOOP_LINES = [
  "清单空空如也，像喝了一口冰气泡水一样清爽 🫧",
  "有灵光一闪的想法？按 Enter 马上抓进清单里 ✨",
  "一步一个小勾勾，今天也在稳稳向前走 🌟",
];

/** 俏皮拟人化「小清单精灵」空状态插画：悬停轻浮，点击弹跳打气。 */
function PlayfulTaskMascot({ onBoop }: { onBoop: () => void }) {
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
      className="group relative mx-auto mb-4 flex h-28 w-28 cursor-pointer items-center justify-center rounded-full focus:outline-none"
      whileHover={{ scale: 1.07 }}
      whileTap={{ scale: 0.93 }}
      animate={boops > 0 ? { y: [0, -11, 0], rotate: [0, -7, 7, 0] } : { y: [0, -4, 0] }}
      transition={boops > 0
        ? { duration: 0.45, ease: MOTION_EASE.enter }
        : { duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
    >
      <span className="pointer-events-none absolute inset-1.5 rounded-full bg-gradient-to-tr from-emerald-400/22 via-sky-400/18 to-violet-400/22 blur-xl" />

      <motion.span
        className="pointer-events-none absolute right-2 top-2.5 text-amber-400 dark:text-amber-300"
        animate={{ y: [0, -5, 0], rotate: [0, 16, 0], opacity: [0.65, 1, 0.65] }}
        transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
      >
        <Sparkles size={15} />
      </motion.span>
      <motion.span
        className="pointer-events-none absolute left-2 top-6 h-2 w-2 rounded-full bg-emerald-400/60"
        animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0.95, 0.5] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.span
        className="pointer-events-none absolute bottom-3 right-3 h-2 w-2 rounded-full bg-sky-400/60"
        animate={{ y: [0, 4, 0], opacity: [0.45, 0.9, 0.45] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut", delay: 0.35 }}
      />

      <svg viewBox="0 0 112 112" className="relative h-22 w-22 drop-shadow-sm" fill="none">
        {/* 小清单卡片主体 */}
        <rect
          x="24"
          y="22"
          width="64"
          height="72"
          rx="16"
          className="fill-app-elevated stroke-sky-500/55 dark:stroke-sky-300/55"
          strokeWidth="2.4"
        />
        {/* 顶部小夹子 */}
        <rect
          x="42"
          y="15"
          width="28"
          height="13"
          rx="6.5"
          className="fill-sky-500/20 stroke-sky-500/70 dark:fill-sky-400/25 dark:stroke-sky-300/70"
          strokeWidth="2.2"
        />
        {/* 绿色开心大勾勾 */}
        <g className="origin-center transition-transform duration-300 group-hover:scale-105">
          <circle cx="56" cy="52" r="14" className="fill-emerald-500/15 dark:fill-emerald-400/20" />
          <path
            d="M49 52.5L54 57.5L63.5 47"
            className="stroke-emerald-500 dark:stroke-emerald-300"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
        {/* 笑眯眯小表情 */}
        <circle cx="46.5" cy="75" r="2.2" className="fill-tx-primary/70" />
        <circle cx="65.5" cy="75" r="2.2" className="fill-tx-primary/70" />
        <path
          d="M52 78.5C53.8 80.8 58.2 80.8 60 78.5"
          className="stroke-tx-primary/70"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <circle cx="41.5" cy="77.5" r="2.6" className="fill-rose-400/40" />
        <circle cx="70.5" cy="77.5" r="2.6" className="fill-rose-400/40" />
      </svg>
    </motion.button>
  );
}

export function TaskEmptyState({ type, title, description, actionLabel, onAction, compact }: TaskEmptyStateProps) {
  const { t } = useTranslation();
  const [boopIndex, setBoopIndex] = useState<number | null>(null);

  const resolvedTitle = title || t(`tasks.empty.${type}.title`);
  const resolvedDescription = description || t(`tasks.empty.${type}.description`);
  const resolvedAction = actionLabel || t(`tasks.empty.${type}.action`, { defaultValue: "" });

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.26, ease: MOTION_EASE.enter }}
      className={cn(
        "flex w-full flex-col items-center justify-center rounded-3xl text-tx-tertiary",
        compact
          ? "px-4 py-6"
          : "border border-dashed border-app-border/80 bg-app-elevated/55 px-6 py-10 backdrop-blur-sm",
      )}
    >
      {compact ? (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-500/12 text-sky-500 ring-1 ring-sky-500/20 dark:text-sky-300">
          {COMPACT_ICONS[type]}
        </div>
      ) : (
        <PlayfulTaskMascot
          onBoop={() => setBoopIndex((prev) => (prev === null ? 0 : (prev + 1) % MASCOT_BOOP_LINES.length))}
        />
      )}
      <span className={cn("text-center font-semibold text-tx-primary", compact ? "text-xs" : "text-sm")}>
        {resolvedTitle}
      </span>
      {(boopIndex !== null || resolvedDescription) && (
        <span className={cn("mt-1.5 max-w-[300px] text-center leading-5 text-tx-secondary", compact ? "text-[11px]" : "text-xs")}>
          {boopIndex !== null ? MASCOT_BOOP_LINES[boopIndex] : resolvedDescription}
        </span>
      )}
      {resolvedAction && onAction && (
        <motion.button
          type="button"
          whileHover={{ y: -1, scale: 1.02 }}
          whileTap={{ scale: 0.96 }}
          onClick={onAction}
          className={cn(
            "mt-4 rounded-xl bg-gradient-to-r from-sky-500 to-indigo-500 font-semibold text-white shadow-sm shadow-sky-500/20 transition-all hover:from-sky-400 hover:to-indigo-400",
            compact ? "px-3 py-1.5 text-[11px]" : "px-4 py-2 text-xs",
          )}
        >
          {resolvedAction}
        </motion.button>
      )}
    </motion.div>
  );
}
