export type TaskViewMode = "list" | "board" | "calendar" | "timeline";

export const TASK_VIEW_MODE_KEY = "nowen.taskCenter.viewMode.v1";

export function loadTaskViewMode(): TaskViewMode {
  try {
    const value = localStorage.getItem(TASK_VIEW_MODE_KEY);
    if (value === "list" || value === "board" || value === "calendar" || value === "timeline") return value;
  } catch {
    // 存储不可用时仍允许正常进入任务中心。
  }
  return "list";
}

export function saveTaskViewMode(mode: TaskViewMode): void {
  try {
    localStorage.setItem(TASK_VIEW_MODE_KEY, mode);
  } catch {
    // 存储受限时保留本次会话中的视图选择。
  }
}
