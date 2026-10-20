import { useTranslation } from "react-i18next";
import { useHolidayCalendar } from "@/hooks/useHolidayCalendar";

export function HolidayCalendarSettings({ year }: { year: number }) {
  const { t } = useTranslation();
  const calendar = useHolidayCalendar([year]);
  const state = calendar.getYear(year);
  return (
    <details className="shrink-0 border-b border-app-border px-4 py-2 text-xs text-tx-secondary">
      <summary className="w-fit cursor-pointer select-none">{t("holidayCalendar.settings")}</summary>
      <div className="mt-2 flex flex-col items-start gap-2 pb-1">
        <label className="flex items-center gap-2 font-medium text-tx-primary">
          <input type="checkbox" checked={calendar.enabled} onChange={(event) => calendar.setEnabled(event.target.checked)} />
          {t("holidayCalendar.enable")}
        </label>
        <p>{t("holidayCalendar.description")}</p>
        <p className="text-tx-tertiary">{t("holidayCalendar.updates")}</p>
        {calendar.enabled && <>
          {state.data ? <>
            <span>{t(`holidayCalendar.${state.origin}`, { year })}</span>
            <a href={state.data.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent-primary hover:underline">{t("holidayCalendar.source")}</a>
          </> : <p>{t("holidayCalendar.unknown", { year })}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={state.status === "loading"} onClick={() => void calendar.refresh(year, true)} className="rounded border border-app-border px-2 py-1 hover:bg-app-hover disabled:opacity-50">
              {t(state.status === "loading" ? "holidayCalendar.loading" : "holidayCalendar.refresh")}
            </button>
            <span role="status">{state.status === "fallback" || state.status === "updated" ? t(`holidayCalendar.${state.status}`) : ""}</span>
          </div>
        </>}
        {calendar.storageError && <p role="status">{t("holidayCalendar.storageError")}</p>}
      </div>
    </details>
  );
}
