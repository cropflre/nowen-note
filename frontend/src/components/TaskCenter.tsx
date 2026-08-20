import React, { useEffect } from "react";
import TaskCenterImpl from "./TaskCenterImpl";
import { TaskMetadataWorkspace } from "./tasks/TaskMetadataWorkspace";
import TaskEntryUxBridge from "./tasks/TaskEntryUxBridge";
import { shouldConfirmHabitDelete } from "./tasks/taskCenterHardening";

export * from "./TaskCenterImpl";

export default function TaskCenter() {
  useEffect(() => {
    const handleDeleteCapture = (event: MouseEvent) => {
      if (!shouldConfirmHabitDelete(event.target)) return;
      const chinese = document.documentElement.lang.toLowerCase().startsWith("zh");
      const accepted = window.confirm(
        chinese
          ? "永久删除该习惯？该操作会同时删除全部打卡历史，且无法恢复。"
          : "Permanently delete this habit? All check-in history will also be deleted and cannot be restored.",
      );
      if (accepted) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", handleDeleteCapture, true);
    return () => document.removeEventListener("click", handleDeleteCapture, true);
  }, []);

  return (
      <TaskMetadataWorkspace>
      <TaskEntryUxBridge />
      <TaskCenterImpl />
    </TaskMetadataWorkspace>
  );
}
