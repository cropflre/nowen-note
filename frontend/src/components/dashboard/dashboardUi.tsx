import React from "react";
import { BarChart3, Blocks, CalendarDays, FileText, ListChecks, PenLine, Star, Unplug } from "lucide-react";
import { builtinWidgetKind, type BuiltinWidgetKind } from "@/lib/pluginDashboard";
import { cn } from "@/lib/utils";

const KIND_KEY: Record<BuiltinWidgetKind, string> = {
  "quick-note": "quickNote", "today-tasks": "todayTasks", "recent-notes": "recentNotes",
  "task-stats": "taskStats", "diary-calendar": "diaryCalendar", favorites: "favorites",
};
const KIND_ICON: Record<BuiltinWidgetKind, React.ComponentType<{ size?: number }>> = {
  "quick-note": PenLine, "today-tasks": ListChecks, "recent-notes": FileText,
  "task-stats": BarChart3, "diary-calendar": CalendarDays, favorites: Star,
};

export function builtinCardText(kind: BuiltinWidgetKind, t: (key: string) => string): { title: string; description: string } {
  return { title: t(`extensionCenter.workbench.builtin.${KIND_KEY[kind]}.title`), description: t(`extensionCenter.workbench.builtin.${KIND_KEY[kind]}.description`) };
}

/** Icon tile for a placement: built-in kinds get their own icon, plugin widgets a generic block, dormant cards an unplugged icon. */
export function BuiltinCardIcon({ id, dormant = false }: { id: string; dormant?: boolean }) {
  const kind = builtinWidgetKind(id);
  const Icon = dormant ? Unplug : kind ? KIND_ICON[kind] : Blocks;
  return <span aria-hidden className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
    dormant ? "bg-app-hover text-tx-tertiary" : kind ? "bg-accent-primary/10 text-accent-primary" : "bg-sky-500/10 text-sky-600 dark:text-sky-300")}>
    <Icon size={16} />
  </span>;
}
