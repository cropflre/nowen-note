import { useRef, useState } from "react";
import { FolderOpen, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { IMPORT_ACCEPT, filesFromDrop, filesFromInput, type ImportFile } from "@/lib/smartImport";

/** Folder picking exists in desktop browsers and Electron, not in the Android/iOS apps. */
function canChooseFolder(): boolean {
  if (typeof document === "undefined") return false;
  const native = (window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  return !native && "webkitdirectory" in document.createElement("input");
}

export default function ImportDropZone({ disabled, onFiles }: { disabled: boolean; onFiles: (files: ImportFile[]) => void }) {
  const { t } = useTranslation();
  const [dragging, setDragging] = useState(false);
  const files = useRef<HTMLInputElement>(null);
  const folder = useRef<HTMLInputElement>(null);
  const take = (input: HTMLInputElement) => { const chosen = filesFromInput(input.files); input.value = ""; if (chosen.length) onFiles(chosen); };
  return <div className="space-y-2">
    <button
      type="button" disabled={disabled} data-import-drop-zone=""
      onClick={() => files.current?.click()}
      onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault(); setDragging(false);
        if (!disabled) void filesFromDrop(event.dataTransfer).then((dropped) => { if (dropped.length) onFiles(dropped); });
      }}
      className={cn("flex min-h-44 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed px-6 py-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:cursor-not-allowed disabled:opacity-50",
        dragging ? "border-accent-primary bg-accent-primary/5" : "border-app-border bg-app-surface hover:bg-app-hover")}
    >
      <Upload size={26} className="text-tx-secondary" aria-hidden="true" />
      <span className="text-sm font-medium text-tx-primary">{t(dragging ? "migration.smart.dropHere" : "migration.smart.drop")}</span>
      <span className="text-xs text-tx-secondary">{t("migration.smart.formats")}</span>
    </button>
    {canChooseFolder() && <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => folder.current?.click()}>
      <FolderOpen size={14} className="mr-1.5" aria-hidden="true" />{t("migration.smart.chooseFolder")}
    </Button>}
    <input ref={files} type="file" multiple accept={IMPORT_ACCEPT} className="hidden" aria-label={t("migration.smart.chooseFiles")} disabled={disabled} onChange={(event) => take(event.currentTarget)} />
    <input ref={folder} type="file" multiple className="hidden" aria-label={t("migration.smart.chooseFolder")} disabled={disabled}
      {...{ webkitdirectory: "", directory: "" }} onChange={(event) => take(event.currentTarget)} />
  </div>;
}
