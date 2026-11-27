import { useSyncExternalStore } from "react";
import { getConfiguredTimeZone, subscribeAppTimeZone } from "@/lib/dateTime";

/** 订阅当前全局应用时区偏好（`"auto"` 或 canonical IANA 时区 ID），用于需要即时重渲染的视图。 */
export function useAppTimeZone(): string {
  return useSyncExternalStore(subscribeAppTimeZone, getConfiguredTimeZone, getConfiguredTimeZone);
}
