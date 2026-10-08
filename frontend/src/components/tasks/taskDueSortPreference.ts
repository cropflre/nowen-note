/** Local display preference only: sorting must never rewrite persisted task sortOrder. */
export const TASK_DUE_SORT_PREFERENCE_KEY = "nowen.taskCenter.sortByDueTime.v1";

export function loadTaskDueSort(): boolean {
  try {
    return localStorage.getItem(TASK_DUE_SORT_PREFERENCE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveTaskDueSort(enabled: boolean): void {
  try {
    localStorage.setItem(TASK_DUE_SORT_PREFERENCE_KEY, enabled ? "1" : "0");
  } catch {
    // Restricted storage: sorting still works in the active session.
  }
}
