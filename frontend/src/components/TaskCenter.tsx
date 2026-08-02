import React, { useCallback, useEffect, useState } from "react";
import TaskCenterImpl from "./TaskCenterImpl";
import { TaskMetadataWorkspace } from "./tasks/TaskMetadataWorkspace";
import { shouldConfirmHabitDelete } from "./tasks/taskCenterHardening";

export * from "./TaskCenterImpl";

export default function TaskCenter() {
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);

  const remountTaskWorkspace = useCallback(() => {
    setWorkspaceGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    const handleWorkspaceChange = () => {
      // Remount capture, planning state, smart views and the legacy task center together.
      remountTaskWorkspace();
    };
    window.addEventListener("nowen:workspace-changed", handleWorkspaceChange);
    return () => window.removeEventListener("nowen:workspace-changed", handleWorkspaceChange);
  }, [remountTaskWorkspace]);

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
    <TaskMetadataWorkspace key={workspaceGeneration}>
      <TaskCenterImpl />
    </TaskMetadataWorkspace>
  );
}
