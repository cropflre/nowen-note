import React from "react";
import DailyRecordsHub from "@/components/daily-records/DailyRecordsHub";

/**
 * Unified entry for moments, calendar and daily journals.
 *
 * The existing diary timeline stays intact inside the "moments" tab, while the
 * hub adds a date-oriented journal workspace without duplicating diary data.
 */
export default function DiaryCenter() {
  return <DailyRecordsHub />;
}
