import React from "react";
import { BarChart3, Blocks, CalendarDays, FileText, LayoutGrid, ListChecks, PenLine, Star, Unplug } from "lucide-react";
import { builtinWidgetKind, studioAppIdOf, type BuiltinWidgetKind } from "@/lib/pluginDashboard";
import { cn } from "@/lib/utils";

const KIND_KEY: Record<BuiltinWidgetKind, string> = {
  "quick-note": "quickNote", "today-tasks": "todayTasks", "recent-notes": "recentNotes",
  "task-stats": "taskStats", "diary-calendar": "diaryCalendar", favorites: "favorites",
};
const KIND_ICON: Record<BuiltinWidgetKind, React.ComponentType<{ size?: number }>> = {
  "quick-note": PenLine, "today-tasks": ListChecks, "recent-notes": FileText,
  "task-stats": BarChart3, "diary-calendar": CalendarDays, favorites: Star,
};

export interface DashboardCardAccent {
  iconBg: string;
  cardTint: string;
  orbBg: string;
  hoverBorder: string;
}

const KIND_ACCENT: Record<BuiltinWidgetKind, DashboardCardAccent> = {
  "quick-note": {
    iconBg: "bg-gradient-to-br from-amber-400/20 to-orange-500/20 text-amber-600 dark:text-amber-300",
    cardTint: "from-amber-500/[0.06] via-app-surface to-app-surface",
    orbBg: "bg-amber-400/15 dark:bg-amber-400/10",
    hoverBorder: "hover:border-amber-400/50",
  },
  "today-tasks": {
    iconBg: "bg-gradient-to-br from-emerald-400/20 to-teal-500/20 text-emerald-600 dark:text-emerald-300",
    cardTint: "from-emerald-500/[0.06] via-app-surface to-app-surface",
    orbBg: "bg-emerald-400/15 dark:bg-emerald-400/10",
    hoverBorder: "hover:border-emerald-400/50",
  },
  "recent-notes": {
    iconBg: "bg-gradient-to-br from-sky-400/20 to-blue-500/20 text-sky-600 dark:text-sky-300",
    cardTint: "from-sky-500/[0.06] via-app-surface to-app-surface",
    orbBg: "bg-sky-400/15 dark:bg-sky-400/10",
    hoverBorder: "hover:border-sky-400/50",
  },
  "task-stats": {
    iconBg: "bg-gradient-to-br from-indigo-400/20 to-violet-500/20 text-indigo-600 dark:text-indigo-300",
    cardTint: "from-indigo-500/[0.06] via-app-surface to-app-surface",
    orbBg: "bg-indigo-400/15 dark:bg-indigo-400/10",
    hoverBorder: "hover:border-indigo-400/50",
  },
  "diary-calendar": {
    iconBg: "bg-gradient-to-br from-fuchsia-400/20 to-pink-500/20 text-fuchsia-600 dark:text-fuchsia-300",
    cardTint: "from-fuchsia-500/[0.06] via-app-surface to-app-surface",
    orbBg: "bg-fuchsia-400/15 dark:bg-fuchsia-400/10",
    hoverBorder: "hover:border-fuchsia-400/50",
  },
  favorites: {
    iconBg: "bg-gradient-to-br from-yellow-400/25 to-amber-500/20 text-amber-600 dark:text-yellow-300",
    cardTint: "from-yellow-500/[0.06] via-app-surface to-app-surface",
    orbBg: "bg-yellow-400/15 dark:bg-yellow-400/10",
    hoverBorder: "hover:border-amber-400/50",
  },
};

const STUDIO_ACCENT: DashboardCardAccent = {
  iconBg: "bg-gradient-to-br from-cyan-400/20 to-indigo-500/20 text-cyan-600 dark:text-cyan-300",
  cardTint: "from-cyan-500/[0.06] via-app-surface to-app-surface",
  orbBg: "bg-cyan-400/15 dark:bg-cyan-400/10",
  hoverBorder: "hover:border-cyan-400/50",
};

const PLUGIN_ACCENT: DashboardCardAccent = {
  iconBg: "bg-gradient-to-br from-sky-400/20 to-purple-500/20 text-sky-600 dark:text-sky-300",
  cardTint: "from-purple-500/[0.05] via-app-surface to-app-surface",
  orbBg: "bg-purple-400/15 dark:bg-purple-400/10",
  hoverBorder: "hover:border-purple-400/50",
};

const DORMANT_ACCENT: DashboardCardAccent = {
  iconBg: "bg-app-hover text-tx-tertiary",
  cardTint: "from-app-hover/50 via-app-hover/30 to-app-hover/30",
  orbBg: "bg-transparent",
  hoverBorder: "",
};

export function dashboardCardAccent(id: string, dormant = false): DashboardCardAccent {
  if (dormant) return DORMANT_ACCENT;
  const kind = builtinWidgetKind(id);
  if (kind) return KIND_ACCENT[kind];
  if (studioAppIdOf(id) !== null) return STUDIO_ACCENT;
  return PLUGIN_ACCENT;
}

export function builtinCardText(kind: BuiltinWidgetKind, t: (key: string) => string): { title: string; description: string } {
  return { title: t(`extensionCenter.workbench.builtin.${KIND_KEY[kind]}.title`), description: t(`extensionCenter.workbench.builtin.${KIND_KEY[kind]}.description`) };
}

/** Icon tile for a placement: built-in kinds and personal apps get playful themed icon capsules. */
export function BuiltinCardIcon({ id, dormant = false }: { id: string; dormant?: boolean }) {
  const kind = builtinWidgetKind(id);
  const studio = !kind && studioAppIdOf(id) !== null;
  const Icon = dormant ? Unplug : kind ? KIND_ICON[kind] : studio ? LayoutGrid : Blocks;
  const accent = dashboardCardAccent(id, dormant);
  return <span aria-hidden className={cn(
    "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 motion-safe:group-hover/card:scale-110 motion-safe:group-hover/card:-rotate-6",
    accent.iconBg,
  )}>
    <Icon size={16} />
  </span>;
}
