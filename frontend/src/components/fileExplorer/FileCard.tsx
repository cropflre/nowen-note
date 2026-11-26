import { useState } from "react";
import { Check, FileText, FileVideo, FileAudio, FileArchive, Image, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveAttachmentUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { assetFileKind, humanFileSize, type AssetView } from "@/lib/fileExplorerModel";
import type { FileItem } from "@/types";

export default function FileCard({ item, view, selected, selectionMode, hasSelection, onSelect, onToggleSelect, onPreview, onMenu, onDrag }: {
  item: FileItem; view: AssetView; selected: boolean;
  selectionMode?: boolean; hasSelection?: boolean;
  onSelect: (event: React.MouseEvent) => void;
  onToggleSelect?: (event: React.MouseEvent | React.KeyboardEvent) => void;
  onPreview: () => void;
  onMenu: (event: React.MouseEvent) => void; onDrag: (event: React.DragEvent) => void;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const kind = assetFileKind(item.mimeType);
  const Icon = { image: Image, video: FileVideo, audio: FileAudio, archive: FileArchive, document: FileText, other: FileText }[kind];
  const canThumbnail = kind === "image" && !!item.thumbnailUrl;
  const showCheckbox = selected || selectionMode || hasSelection;
  const preview = canThumbnail && !failed
    ? <img src={resolveAttachmentUrl(item.thumbnailUrl!)} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)}
        className={cn("w-full object-contain", view === "masonry" ? "max-h-[480px]" : view === "list" ? "h-10" : "h-24 md:h-32")} />
    : <Icon size={view === "list" ? 22 : 36} className="text-tx-tertiary" />;
  const triggerCheckbox = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (onToggleSelect) onToggleSelect(event);
    else onSelect(event as React.MouseEvent);
  };
  const checkbox = <button type="button" role="checkbox" aria-checked={selected}
    aria-label={t("fileExplorer.selectFileItem", { name: item.filename })}
    onClick={(event) => { event.stopPropagation(); triggerCheckbox(event); }}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault(); event.stopPropagation();
        triggerCheckbox(event);
      }
    }}
    className={cn(
      "flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
      selected ? "border-accent-primary bg-accent-primary text-white opacity-100" : "border-app-border bg-app-surface/90 text-transparent hover:border-accent-primary",
      view === "list"
        ? (showCheckbox ? "opacity-100" : "opacity-60 group-hover:opacity-100 focus-visible:opacity-100")
        : cn("absolute left-1.5 top-1.5 z-10 shadow-sm", showCheckbox ? "opacity-100" : "opacity-80 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"),
    )}><Check size={13} strokeWidth={3} /></button>;
  return <div role="button" tabIndex={0} aria-label={item.filename} aria-pressed={selected}
    draggable={item.canManage !== false} onDragStart={onDrag} onClick={onSelect} onDoubleClick={onPreview}
    onContextMenu={onMenu} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === "Enter") onPreview(); if (event.key === " ") { event.preventDefault(); onSelect(event as unknown as React.MouseEvent); } }}
    className={cn("group relative min-w-0 cursor-pointer rounded-lg border text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent-primary", selected ? "border-accent-primary bg-accent-primary/10" : "border-app-border bg-app-surface hover:bg-app-hover",
      view === "list" ? "flex items-center gap-3 px-3 py-2" : "mb-3 break-inside-avoid overflow-hidden")}>
    {checkbox}
    <div className={cn("flex items-center justify-center bg-app-elevated", view === "list" ? "h-10 w-12 shrink-0 rounded" : view === "masonry" && canThumbnail ? "min-h-16" : "h-28 md:h-36")}>{preview}</div>
    <div className={cn("min-w-0 flex-1", view !== "list" && "p-2 md:p-3")}>
      <p className={cn("text-xs md:text-sm text-tx-primary", view === "list" ? "truncate" : "line-clamp-2 break-words")} title={item.filename}>{item.filename}</p>
      <p className={cn("mt-1 truncate text-xs text-tx-tertiary", view === "list" && "md:hidden")}>{humanFileSize(item.size)}{view !== "list" && ` · ${item.folderName || t("fileExplorer.unorganized")}`}</p>
    </div>
    {view === "list" && <>
      <span className="hidden w-20 truncate text-xs text-tx-secondary md:block">{item.filename.split(".").pop()?.toUpperCase()}</span>
      <span className="hidden w-20 text-xs text-tx-secondary md:block">{humanFileSize(item.size)}</span>
      <span className="hidden w-24 text-xs text-tx-secondary lg:block">{item.createdAt.slice(0, 10)}</span>
      <span className="hidden w-28 truncate text-xs text-tx-secondary md:block">{item.folderName || t("fileExplorer.unorganized")}</span>
    </>}
    <button aria-label={t("fileExplorer.actions")} className={cn("shrink-0 rounded p-1.5 text-tx-secondary hover:bg-app-hover", view !== "list" && "absolute right-1 top-1 bg-app-surface/90")}
      onClick={(event) => { event.stopPropagation(); onMenu(event); }}><MoreHorizontal size={16} /></button>
  </div>;
}
