import React, { useEffect } from "react";
import { Archive, ArchiveRestore, CheckCircle2, Circle, FileText, FileSpreadsheet, Flag, FolderInput, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import ContextMenu, { type ContextMenuItem } from "@/components/ContextMenu";
import type { ContextMenuState } from "@/hooks/useContextMenu";
import type { Task, TaskProject } from "@/types";

export default function TaskContextMenu({ menu, menuRef, task, projects, canArchive, onAction }: {
  menu: ContextMenuState;
  menuRef: React.RefObject<HTMLDivElement | null>;
  task: Task;
  projects: TaskProject[];
  canArchive: boolean;
  onAction: (action: string) => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const buttons = menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    Array.from(buttons || []).find(button => button.getClientRects().length > 0)?.focus({ preventScroll: true });
  }, [menu.targetId, menuRef]);

  const items: ContextMenuItem[] = [
    { id: "open", label: t("tasks.contextMenu.open"), icon: <FileText size={14} /> },
  ];
  if (!task.archivedAt) {
    items.push(
      { id: "toggle", label: t(task.isCompleted ? "tasks.contextMenu.reopen" : "tasks.contextMenu.complete"), icon: task.isCompleted ? <Circle size={14} /> : <CheckCircle2 size={14} /> },
      { id: "add-child", label: t("tasks.addChild"), icon: <Plus size={14} /> },
      { id: "edit-separator", label: "", separator: true },
      { id: "priority", label: t("tasks.priority"), icon: <Flag size={14} />, children: [3, 2, 1].map(priority => ({
        id: `priority:${priority}`, label: t(priority === 3 ? "tasks.high" : priority === 2 ? "tasks.medium" : "tasks.low"),
        icon: <Flag size={14} className={priority === 3 ? "text-red-500" : priority === 2 ? "text-amber-500" : "text-blue-400"} />,
        disabled: task.priority === priority,
      })) },
      { id: "project", label: t("tasks.contextMenu.moveProject"), icon: <FolderInput size={14} />, children: [
        { id: "project:none", label: t("tasks.noProject"), disabled: !task.projectId },
        ...projects.map(project => ({ id: `project:${project.id}`, label: project.name, disabled: task.projectId === project.id })),
      ] },
    );
  }
  items.push(
    { id: "save-note", label: t("tasks.lifecycle.saveNote"), icon: <FileText size={14} /> },
    { id: "export:xlsx", label: t("tasks.report.exportExcel"), icon: <FileSpreadsheet size={14} /> },
    { id: "export:md", label: t("tasks.report.exportMarkdown"), icon: <FileText size={14} /> },
  );
  if (!task.parentId) items.push({
    id: task.archivedAt ? "restore" : "archive",
    label: t(task.archivedAt ? "tasks.lifecycle.restore" : "tasks.lifecycle.archive"),
    icon: task.archivedAt ? <ArchiveRestore size={14} /> : <Archive size={14} />,
    disabled: !task.archivedAt && !canArchive,
  });
  items.push(
    { id: "delete-separator", label: "", separator: true },
    { id: "delete", label: t("tasks.deleteTask"), icon: <Trash2 size={14} />, danger: true },
  );

  return <ContextMenu {...menu} menuRef={menuRef} items={items} header={task.title} onAction={onAction} />;
}
