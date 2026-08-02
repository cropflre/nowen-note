import React, { useCallback, useEffect, useState } from "react";
import TaskCenterImpl from "./TaskCenterImpl";
import { MyDayPanel } from "./tasks/MyDayPanel";
import { shouldConfirmHabitDelete } from "./tasks/taskCenterHardening";

export * from "./TaskCenterImpl";

export default function TaskCenter() {
  const [workspaceGeneration, setWorkspaceGeneration] = useState(0);
  const [localDayKey, setLocalDayKey] = useState(() => new Date().toDateString());

  const remountTaskWorkspace = useCallback(() => {
    setWorkspaceGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    const handleWorkspaceChange = () => {
      // Remount the full task center. This immediately drops the previous
      // workspace state, and late promises from the unmounted instance cannot
      // overwrite the newly selected workspace.
      remountTaskWorkspace();
    };
    window.addEventListener("nowen:workspace-changed", handleWorkspaceChange);
    return () => window.removeEventListener("nowen:workspace-changed", handleWorkspaceChange);
  }, [remountTaskWorkspace]);

  useEffect(() => {
    // Keep a long-running desktop/web session aligned with the local calendar day.
    // Changing this key remounts only My Day; task deadlines and the task center stay untouched.
    const timer = window.setInterval(() => {
      const nextDayKey = new Date().toDateString();
      setLocalDayKey((current) => current === nextDayKey ? current : nextDayKey);
    }, 60_000);
    return () => window.clearInterval(timer);
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
    <div className="flex h-full min-h-0 flex-col">
      <MyDayPanel
        key={`my-day-${workspaceGeneration}-${localDayKey}`}
        onTaskMutated={remountTaskWorkspace}
      />
      <div className="min-h-0 flex-1">
        <TaskCenterImpl key={workspaceGeneration} />
      </div>
    </div>
  );
}
