import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { HolidayDay } from "@/lib/holidayCalendar";

export function HolidayDayLabel({ day }: { day?: HolidayDay }) {
  const { t } = useTranslation();
  if (!day) return null;
  const name = t(`holidayCalendar.names.${day.name}`);
  const label = t(day.type === "holiday" ? "holidayCalendar.holidayLabel" : "holidayCalendar.makeupLabel", { name });
  return (
    <span title={label} aria-label={label} data-holiday-type={day.type} className={cn(
      "mb-1 flex w-full min-w-0 items-center gap-0.5 text-[10px] leading-4",
      day.type === "holiday" ? "text-red-600 dark:text-red-400" : "text-amber-700 dark:text-amber-400"
    )}>
      <span className={cn("shrink-0 rounded px-0.5 font-semibold", day.type === "holiday" ? "bg-red-500/10" : "bg-amber-500/10")}>{t(`holidayCalendar.${day.type}`)}</span>
      <span className="truncate">{name}</span>
    </span>
  );
}
