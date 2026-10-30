import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import { folderPath, type AssetFolder } from "@/lib/fileExplorerModel";

export default function FileFolderTree({ folders, current, onOpen, onMenu, onDrop }: {
  folders: AssetFolder[]; current: string | null; onOpen: (id: string) => void;
  onMenu?: (folder: AssetFolder, event: React.MouseEvent) => void;
  onDrop?: (folderId: string, event: React.DragEvent) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(new Map<string, boolean>());
  const ancestry = new Set(folderPath(folders, current).map((folder) => folder.id));
  const render = (parentId: string | null, depth: number, visited: Set<string>): React.ReactNode =>
    folders.filter((folder) => folder.parentId === parentId || (parentId === null && folder.parentId && !folders.some((candidate) => candidate.id === folder.parentId)))
      .filter((folder) => !visited.has(folder.id)).map((folder) => {
        const children = folders.some((candidate) => candidate.parentId === folder.id);
        const open = expanded.get(folder.id) ?? ancestry.has(folder.id);
        return <div key={folder.id}>
          <div className={cn("flex items-center gap-1 rounded-md text-sm", current === folder.id ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover")}
            style={{ paddingLeft: depth * 14 }} onContextMenu={(event) => onMenu?.(folder, event)}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("application/x-nowen-assets")) event.preventDefault(); }}
            onDrop={(event) => onDrop?.(folder.id, event)}>
            <button className="p-1" aria-expanded={open} aria-label={t("fileExplorer.toggleFolder", { name: folder.name })} disabled={!children} onClick={() => setExpanded((previous) => {
              return new Map(previous).set(folder.id, !open);
            })}>{children ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="block w-[13px]" />}</button>
            <button aria-label={folder.name} className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-2 text-left" onClick={() => onOpen(folder.id)}>
              <Folder size={15} className="shrink-0" /><span className="truncate">{folder.name}</span>
              <span className="ml-auto text-xs text-tx-tertiary">{folder.fileCount || 0}</span>
            </button>
          </div>
          {children && open && render(folder.id, depth + 1, new Set([...visited, folder.id]))}
        </div>;
      });
  return <nav>{render(null, 0, new Set())}</nav>;
}
