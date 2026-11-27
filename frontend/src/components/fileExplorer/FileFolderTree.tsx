import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Folder, FolderOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { folderPath, type AssetFolder } from "@/lib/fileExplorerModel";

export default function FileFolderTree({ folders, current, onOpen, onMenu, onDrop }: {
  folders: AssetFolder[]; current: string | null; onOpen: (id: string) => void;
  onMenu?: (folder: AssetFolder, event: React.MouseEvent) => void;
  onDrop?: (folderId: string, event: React.DragEvent) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(new Map<string, boolean>());
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const ancestry = new Set(folderPath(folders, current).map((folder) => folder.id));

  const render = (parentId: string | null, depth: number, visited: Set<string>): React.ReactNode =>
    folders
      .filter((folder) => folder.parentId === parentId || (parentId === null && folder.parentId && !folders.some((candidate) => candidate.id === folder.parentId)))
      .filter((folder) => !visited.has(folder.id))
      .map((folder) => {
        const children = folders.some((candidate) => candidate.parentId === folder.id);
        const open = expanded.get(folder.id) ?? ancestry.has(folder.id);
        const isActive = current === folder.id;
        const isDragOver = dragOverId === folder.id;

        return (
          <div key={folder.id}>
            <div
              className={cn(
                "group flex items-center gap-1 rounded-xl text-sm transition-all",
                isActive
                  ? "bg-accent-primary/12 font-medium text-accent-primary shadow-xs ring-1 ring-accent-primary/20"
                  : "text-tx-secondary hover:bg-app-hover/80 hover:text-tx-primary",
                isDragOver && "bg-sky-500/15 ring-2 ring-sky-400/60",
              )}
              style={{ paddingLeft: depth * 12 + 4 }}
              onContextMenu={(event) => onMenu?.(folder, event)}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes("application/x-nowen-assets")) {
                  event.preventDefault();
                  setDragOverId(folder.id);
                }
              }}
              onDragLeave={() => setDragOverId((prev) => (prev === folder.id ? null : prev))}
              onDrop={(event) => {
                setDragOverId(null);
                onDrop?.(folder.id, event);
              }}
            >
              <button
                className="rounded-lg p-1 text-tx-tertiary transition-colors hover:text-tx-primary"
                aria-expanded={open}
                aria-label={t("fileExplorer.toggleFolder", { name: folder.name })}
                disabled={!children}
                onClick={() => setExpanded((previous) => new Map(previous).set(folder.id, !open))}
              >
                {children ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : <span className="block w-[13px]" />}
              </button>
              <button
                aria-label={folder.name}
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-2 text-left"
                onClick={() => onOpen(folder.id)}
              >
                {isActive || open ? (
                  <FolderOpen size={15} className="shrink-0 text-amber-500 dark:text-amber-400" />
                ) : (
                  <Folder size={15} className="shrink-0 text-amber-500/80 transition-transform duration-200 group-hover:-rotate-6 dark:text-amber-400/80" />
                )}
                <span className="truncate">{folder.name}</span>
                <span
                  className={cn(
                    "ml-auto rounded-full px-1.5 py-0.2 text-[11px] tabular-nums",
                    isActive ? "bg-accent-primary/15 text-accent-primary" : "bg-app-hover/80 text-tx-tertiary",
                  )}
                >
                  {folder.fileCount || 0}
                </span>
              </button>
            </div>
            {children && open && render(folder.id, depth + 1, new Set([...visited, folder.id]))}
          </div>
        );
      });

  return <nav className="space-y-0.5">{render(null, 0, new Set())}</nav>;
}
