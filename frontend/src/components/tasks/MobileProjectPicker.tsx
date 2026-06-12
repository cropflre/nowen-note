import React, { useState } from "react";
import { FolderOpen, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskProject } from "@/types";

export function MobileProjectPicker({
  projects,
  selectedProjectId,
  onSelect,
  onCreate,
  onClose,
  t,
}: {
  projects: TaskProject[];
  selectedProjectId: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const [newName, setNewName] = useState("");

  return (
    <div className="md:hidden fixed inset-0 z-40 bg-black/30" onClick={onClose}>
      <div
        className="absolute bottom-0 left-0 right-0 bg-app-surface rounded-t-2xl border-t border-app-border max-h-[60vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        style={{ paddingBottom: "calc(var(--safe-area-bottom) + 16px)" }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border">
          <span className="text-sm font-semibold text-tx-primary">{t("tasks.projects")}</span>
          <button onClick={onClose} className="p-1"><X size={16} className="text-tx-secondary" /></button>
        </div>

        <div className="p-2 space-y-0.5">
          <button
            onClick={() => { onSelect(null); onClose(); }}
            className={cn(
              "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm",
              !selectedProjectId ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary"
            )}
          >
            {t("tasks.allTasks")}
          </button>

          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => { onSelect(p.id); onClose(); }}
              className={cn(
                "flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm",
                selectedProjectId === p.id ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary"
              )}
            >
              <FolderOpen size={14} style={{ color: p.color }} />
              <span className="flex-1 text-left truncate">{p.name}</span>
              <span className="text-[10px] text-tx-tertiary">{p.completedCount ?? 0}/{p.taskCount ?? 0}</span>
            </button>
          ))}

          {/* New project */}
          <div className="flex items-center gap-2 px-3 pt-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { onCreate(newName.trim()); setNewName(""); onClose(); } }}
              placeholder={t("tasks.newProject")}
              className="flex-1 px-2 py-1.5 text-xs rounded-md bg-app-bg border border-app-border text-tx-primary focus:outline-none focus:border-accent-primary"
            />
            <button
              onClick={() => { if (newName.trim()) { onCreate(newName.trim()); setNewName(""); onClose(); } }}
              className="p-1.5 rounded-md bg-accent-primary/10 text-accent-primary"
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MobileProjectTrigger({
  selectedProjectId,
  projects,
  onClick,
  t,
}: {
  selectedProjectId: string | null;
  projects: TaskProject[];
  onClick: () => void;
  t: (key: string) => string;
}) {
  const selected = projects.find((p) => p.id === selectedProjectId);
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors shrink-0 text-tx-secondary bg-app-hover/50 active:bg-app-active"
    >
      <FolderOpen size={12} />
      {selected ? selected.name : t("tasks.projects")}
    </button>
  );
}
