import { useEffect, useSyncExternalStore } from "react";
import { holidayCalendarStore } from "@/lib/holidayCalendarStore";

export function useHolidayCalendar(years: number[]) {
  useSyncExternalStore(holidayCalendarStore.subscribe, holidayCalendarStore.getSnapshot);
  const enabled = holidayCalendarStore.enabled;
  const yearKey = [...new Set(years)].sort().join(",");
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      for (const year of yearKey.split(",")) void holidayCalendarStore.refresh(Number(year));
    };
    refresh();
    const timer = window.setInterval(refresh, 24 * 60 * 60 * 1000);
    window.addEventListener("online", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", refresh);
    };
  }, [enabled, yearKey]);
  return holidayCalendarStore;
}
