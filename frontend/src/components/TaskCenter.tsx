import React, { useEffect, useState } from "react";
import TaskCenterImpl from "./TaskCenterImpl";
import RemoteImageLocalizationPanel from "./RemoteImageLocalizationPanel";
import { shouldConfirmHabitDelete } from "./tasks/taskCenterHardening";

export * from "./TaskCenterImpl";

export default function TaskCenter() {
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);

  useEffect(() => {
    const handleWorkspaceChange = () => {
      // Remount the full task center. This immediately drops the previous
      // workspace state, and late promises from the unmounted instance cannot
      // overwrite the newly selected workspace.
      setWorkspaceGeneration((value) => value + 1);
    };
    window.addEventListener("nowen:workspace-changed", handleWorkspaceChange);
    return () => window.removeEventListener("nowen:workspace-changed", handleWorkspaceChange);
  }, []);

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
    <>
      <TaskCenterImpl key={workspaceGeneration} />
      <RemoteImageLocalizationPanel key={`remote-images-${workspaceGeneration}`} />
    </>
  );
}
