import React from "react";
import { useTranslation } from "react-i18next";
import type { HabitStats } from "@/types";

export function HabitStatsOverview({ stats }: { stats: HabitStats | null }) {
  const { t } = useTranslation();
  if (!stats) return null;

  const cards = [
    { label: t("habits.stats.totalCheckins"), value: stats.totalCheckins },
    { label: t("habits.stats.checkinDays"), value: stats.checkinDays },
    { label: t("habits.stats.currentStreak"), value: stats.currentStreak },
  ];

  return (
    <div className="grid grid-cols-3 gap-2.5 px-4 md:px-5 pt-3 pb-1">
      {cards.map((card) => (
        <div key={card.label} className="rounded-lg border border-app-border bg-app-surface px-3 py-3 shadow-sm">
          <div className="text-[10px] text-tx-tertiary leading-tight">{card.label}</div>
          <div className="mt-1 text-lg font-bold text-tx-primary">{card.value}</div>
        </div>
      ))}
    </div>
  );
}