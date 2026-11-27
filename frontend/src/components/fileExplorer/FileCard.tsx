import { useState } from "react";
import { Check, FileText, FileVideo, FileAudio, FileArchive, Image, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { resolveAttachmentUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { assetFileKind, humanFileSize, type AssetView } from "@/lib/fileExplorerModel";
import type { FileItem } from "@/types";

interface KindVisual {
  stageBg: string;
  iconWell: string;
  badgeClass: string;
}

const KIND_VISUALS: Record<"image" | "video" | "audio" | "archive" | "document" | "other", KindVisual> = {
  image: {
    stageBg: "bg-gradient-to-br from-rose-500/[0.08] via-pink-400/[0.05] to-sky-500/[0.08] dark:from-rose-400/[0.12] dark:via-pink-400/[0.08] dark:to-sky-400/[0.12]",
    iconWell: "bg-rose-500/12 text-rose-500 ring-1 ring-rose-500/20 dark:bg-rose-400/15 dark:text-rose-300",
    badgeClass: "bg-rose-500/12 text-rose-600 dark:bg-rose-400/18 dark:text-rose-300",
  },
  video: {
    stageBg: "bg-gradient-to-br from-violet-500/[0.11] via-fuchsia-400/[0.06] to-indigo-500/[0.09] dark:from-violet-400/[0.15] dark:via-fuchsia-400/[0.09] dark:to-indigo-400/[0.12]",
    iconWell: "bg-violet-500/14 text-violet-600 ring-1 ring-violet-500/22 dark:bg-violet-400/18 dark:text-violet-300",
    badgeClass: "bg-violet-500/12 text-violet-600 dark:bg-violet-400/18 dark:text-violet-300",
  },
  audio: {
    stageBg: "bg-gradient-to-br from-emerald-500/[0.10] via-teal-400/[0.06] to-cyan-500/[0.08] dark:from-emerald-400/[0.14] dark:via-teal-400/[0.08] dark:to-cyan-400/[0.12]",
    iconWell: "bg-emerald-500/14 text-emerald-600 ring-1 ring-emerald-500/22 dark:bg-emerald-400/18 dark:text-emerald-300",
    badgeClass: "bg-emerald-500/12 text-emerald-600 dark:bg-emerald-400/18 dark:text-emerald-300",
  },
  archive: {
    stageBg: "bg-gradient-to-br from-amber-500/[0.11] via-orange-400/[0.06] to-yellow-500/[0.08] dark:from-amber-400/[0.15] dark:via-orange-400/[0.09] dark:to-yellow-400/[0.10]",
    iconWell: "bg-amber-500/15 text-amber-600 ring-1 ring-amber-500/25 dark:bg-amber-400/18 dark:text-amber-300",
    badgeClass: "bg-amber-500/14 text-amber-700 dark:bg-amber-400/18 dark:text-amber-300",
  },
  document: {
    stageBg: "bg-gradient-to-br from-sky-500/[0.10] via-blue-400/[0.06] to-indigo-500/[0.09] dark:from-sky-400/[0.14] dark:via-blue-400/[0.08] dark:to-indigo-400/[0.12]",
    iconWell: "bg-sky-500/14 text-sky-600 ring-1 ring-sky-500/22 dark:bg-sky-400/18 dark:text-sky-300",
    badgeClass: "bg-sky-500/12 text-sky-600 dark:bg-sky-400/18 dark:text-sky-300",
  },
  other: {
    stageBg: "bg-gradient-to-br from-slate-500/[0.08] via-cyan-400/[0.05] to-indigo-500/[0.07] dark:from-slate-400/[0.12] dark:via-cyan-400/[0.07] dark:to-indigo-400/[0.10]",
    iconWell: "bg-slate-500/12 text-slate-600 ring-1 ring-slate-500/20 dark:bg-slate-400/16 dark:text-slate-300",
    badgeClass: "bg-app-hover text-tx-secondary",
  },
};

function getFileExtension(filename: string): string {
  const parts = filename.split(".");
  if (parts.length < 2) return "";
  const ext = parts.pop()?.trim().toUpperCase() || "";
  return ext.length <= 6 ? ext : "";
}

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
  const visual = KIND_VISUALS[kind];
  const ext = getFileExtension(item.filename);
  const Icon = { image: Image, video: FileVideo, audio: FileAudio, archive: FileArchive, document: FileText, other: FileText }[kind];
  const canThumbnail = kind === "image" && !!item.thumbnailUrl;
  const showCheckbox = selected || selectionMode || hasSelection;

  const preview = canThumbnail && !failed
    ? (
      <img
        src={resolveAttachmentUrl(item.thumbnailUrl!)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className={cn(
          "w-full object-contain transition-transform duration-300 ease-out group-hover:scale-[1.04]",
          view === "masonry" ? "max-h-[480px]" : view === "list" ? "h-10 rounded-lg object-cover" : "h-28 md:h-36",
        )}
      />
    )
    : view === "list"
      ? (
        <span className={cn("flex h-9 w-9 items-center justify-center rounded-xl transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-105", visual.iconWell)}>
          <Icon size={18} />
        </span>
      )
      : (
        <span className={cn("flex h-14 w-14 items-center justify-center rounded-2xl shadow-xs transition-transform duration-200 group-hover:-rotate-6 group-hover:scale-110", visual.iconWell)}>
          <Icon size={28} />
        </span>
      );

  const triggerCheckbox = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (onToggleSelect) onToggleSelect(event);
    else onSelect(event as React.MouseEvent);
  };

  const checkbox = (
    <button
      type="button"
      role="checkbox"
      aria-checked={selected}
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
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-lg border transition-all outline-none focus-visible:ring-2 focus-visible:ring-accent-primary active:scale-90",
        selected
          ? "border-accent-primary bg-accent-primary text-white opacity-100 shadow-xs"
          : "border-app-border/90 bg-app-elevated/90 text-transparent backdrop-blur-sm hover:border-accent-primary",
        view === "list"
          ? (showCheckbox ? "opacity-100" : "opacity-60 group-hover:opacity-100 focus-visible:opacity-100")
          : cn("absolute left-2 top-2 z-10 shadow-sm", showCheckbox ? "opacity-100" : "opacity-85 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"),
      )}
    >
      <Check size={12} strokeWidth={3} />
    </button>
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={item.filename}
      aria-pressed={selected}
      draggable={item.canManage !== false}
      onDragStart={onDrag}
      onClick={onSelect}
      onDoubleClick={onPreview}
      onContextMenu={onMenu}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") onPreview();
        if (event.key === " ") {
          event.preventDefault();
          onSelect(event as unknown as React.MouseEvent);
        }
      }}
      className={cn(
        "group relative min-w-0 cursor-pointer rounded-2xl border text-sm outline-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-accent-primary",
        selected
          ? "border-accent-primary bg-accent-primary/[0.08] ring-2 ring-accent-primary/25 shadow-sm"
          : "border-app-border/80 bg-app-elevated/85 shadow-xs hover:border-accent-primary/40 hover:bg-app-surface hover:shadow-md",
        view === "list"
          ? "flex items-center gap-3 px-3 py-2"
          : "mb-3 break-inside-avoid overflow-hidden hover:-translate-y-0.5",
      )}
    >
      {checkbox}
      <div
        className={cn(
          "relative flex items-center justify-center overflow-hidden",
          view === "list"
            ? "h-10 w-10 shrink-0 rounded-xl"
            : cn(
                visual.stageBg,
                view === "masonry" && canThumbnail ? "min-h-16" : "h-32 md:h-36",
              ),
        )}
      >
        {preview}
        {view !== "list" && ext && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute bottom-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide backdrop-blur-md",
              canThumbnail && !failed
                ? "bg-black/50 text-white"
                : visual.badgeClass,
            )}
          >
            {ext}
          </span>
        )}
      </div>
      <div className={cn("min-w-0 flex-1", view !== "list" && "p-2.5 md:p-3")}>
        <p
          className={cn(
            "text-xs font-medium text-tx-primary transition-colors group-hover:text-accent-primary md:text-sm",
            view === "list" ? "truncate" : "line-clamp-2 break-words leading-snug",
          )}
          title={item.filename}
        >
          {item.filename}
        </p>
        <p className={cn("mt-1.5 flex items-center gap-1 truncate text-[11px] text-tx-tertiary tabular-nums", view === "list" && "md:hidden")}>
          <span>{humanFileSize(item.size)}</span>
          {view !== "list" && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{item.folderName || t("fileExplorer.unorganized")}</span>
            </>
          )}
        </p>
      </div>
      {view === "list" && (
        <>
          <span className="hidden w-20 truncate md:block">
            {ext ? (
              <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", visual.badgeClass)}>
                {ext}
              </span>
            ) : (
              <span className="text-xs text-tx-tertiary">—</span>
            )}
          </span>
          <span className="hidden w-20 text-xs tabular-nums text-tx-secondary md:block">{humanFileSize(item.size)}</span>
          <span className="hidden w-24 text-xs tabular-nums text-tx-secondary lg:block">{item.createdAt.slice(0, 10)}</span>
          <span className="hidden w-28 truncate text-xs text-tx-secondary md:block">{item.folderName || t("fileExplorer.unorganized")}</span>
        </>
      )}
      <button
        aria-label={t("fileExplorer.actions")}
        className={cn(
          "shrink-0 rounded-xl p-1.5 text-tx-secondary transition-all hover:bg-app-hover hover:text-tx-primary active:scale-90",
          view !== "list" && "absolute right-2 top-2 z-10 border border-app-border/60 bg-app-elevated/85 shadow-xs backdrop-blur-md",
        )}
        onClick={(event) => { event.stopPropagation(); onMenu(event); }}
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}
