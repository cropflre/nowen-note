export const OPEN_TASK_DATA_TRANSFER_EVENT = "nowen:open-task-data-transfer";

export function openTaskDataTransfer(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_TASK_DATA_TRANSFER_EVENT));
}
