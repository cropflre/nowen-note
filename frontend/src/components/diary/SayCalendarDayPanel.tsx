import React from "react";
import { MessageCircle, FileText, Image, Video, Locate } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { Diary } from "@/types";
import { getCurrentWorkspace } from "@/lib/api";
import { formatServerTime } from "@/lib/dateTime";
import type { HolidayDay } from "@/lib/holidayCalendar";
import { HolidayDayLabel } from "@/components/calendar/HolidayDayLabel";

function DiarySummaryRow({
  item,
  onLocateItem,
}: {
  item: Diary;
  onLocateItem: (id: string) => void;
}) {
  const hasImages = (item.images || []).length > 0 || (item.media || []).some((m) => m.type === "image");
  const hasVideo = (item.media || []).some((m) => m.type === "video");
  const previewText = item.contentText?.trim().slice(0, 40) || "";

  return (
    <div className="flex items-center gap-2 rounded-xl border border-app-border/60 bg-app-surface/40 p-2 hover:border-accent-primary/30 transition-all">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11px] text-tx-secondary truncate">
          <span className="truncate">{previewText}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-tx-tertiary mt-0.5">
          {item.mood && <span>{item.mood}</span>}
          <span>{formatServerTime(item.createdAt, { hour: "2-digit", minute: "2-digit" }, "")}</span>
          {hasImages && <Image size={10} />}
          {hasVideo && <Video size={10} />}
          {(item.creatorName && getCurrentWorkspace() !== "personal") && (
            <span className="truncate">· {item.creatorName}</span>
          )}
        </div>
      </div>
      <button
        onClick={() => onLocateItem(item.id)}
        className="p-1.5 rounded-lg text-tx-tertiary hover:text-accent-primary hover:bg-accent-primary/10 transition-all"
      >
        <Locate size={14} />
      </button>
    </div>
  );
}

export default function SayCalendarDayPanel({
  holiday,
  dateKey,
  items,
  onWriteEntry,
  onLocateItem,
}: {
  holiday?: HolidayDay;
  dateKey: string;
  items: Diary[];
  onWriteEntry: () => void;
  onLocateItem: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (!dateKey) {
    return (
      <div className="rounded-2xl border border-dashed border-app-border bg-app-surface/30 p-4 text-sm text-tx-tertiary">
        {t("diary.calendarNoRecords")}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-app-border bg-app-surface/40 p-3 flex flex-col gap-2 max-h-[320px] lg:max-h-[420px] overflow-auto">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-tx-primary">
          <span>{dateKey}</span>
          {items.length > 0 && (
            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-accent-primary/10 text-accent-primary">
              {t("diary.calendarEntryCount", { count: items.length })}
            </span>
          )}
        </div>
        <button
          onClick={onWriteEntry}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-[11px] font-medium bg-accent-primary text-white hover:opacity-90 transition-all"
        >
          <FileText size={12} />
          {t("diary.calendarWriteEntry")}
        </button>
      </div>

      <HolidayDayLabel day={holiday} />

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="w-10 h-10 rounded-xl bg-app-hover flex items-center justify-center mb-2">
            <MessageCircle size={18} className="text-tx-tertiary" />
          </div>
          <p className="text-sm text-tx-secondary font-medium">{t("diary.calendarNoRecords")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((item) => (
            <DiarySummaryRow key={item.id} item={item} onLocateItem={onLocateItem} />
          ))}
        </div>
      )}
    </div>
  );
}
