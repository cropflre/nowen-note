import { useTranslation } from "react-i18next";

import {
  TASK_CENTER_OPTIONAL_MODULE_IDS,
  type NavigationModuleId,
  type TaskCenterOptionalModuleId,
} from "@/lib/navigationVisibility";

export function useNavigationModuleLabels(): Record<NavigationModuleId, string> {
  const { t } = useTranslation();
  return {
    notifications: t("sidebar.notifications"),
    favorites: t("sidebar.favorites"),
    files: t("sidebar.fileManager"),
    diary: t("sidebar.dailyRecords"),
    tasks: t("sidebar.tasks"),
    mindmaps: t("sidebar.mindMaps"),
    "ai-chat": t("sidebar.aiChat"),
    shares: t("sidebar.shareManagement"),
  };
}

export function useTaskCenterModuleLabels(): Record<TaskCenterOptionalModuleId, string> {
  const { t } = useTranslation();
  return {
    inbox: t("tasks.inbox"),
    "my-day": t("tasks.myDay"),
    planner: t("tasks.timePlanning"),
    habits: t("habits.title"),
    stats: t("stats.title"),
  };
}

export const navigationModuleAnchor = (id: NavigationModuleId) => `navigation-module-${id}`;
export const taskCenterModuleAnchor = (id: TaskCenterOptionalModuleId) => `task-center-module-${id}`;

export function visibleTaskCenterModuleCount(hidden: readonly TaskCenterOptionalModuleId[]): number {
  return TASK_CENTER_OPTIONAL_MODULE_IDS.filter((id) => !hidden.includes(id)).length;
}
