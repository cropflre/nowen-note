import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";
import { folderPath, type AssetFolder } from "@/lib/fileExplorerModel";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";

export default function FileMoveDialog({ ids, currentFolderId, folderToMove, expectedFolderIds, onClose, onMoved }: {
  ids: string[];
  currentFolderId?: string | null;
  folderToMove?: AssetFolder;
  expectedFolderIds?: Record<string, string | null>;
  onClose: () => void;
  onMoved: (folderId: string | null, folderName: string | null) => void;
}) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<AssetFolder[]>([]);
  const [target, setTarget] = useState(folderToMove?.parentId ?? currentFolderId ?? "");
  const [search, setSearch] = useState("");
  const [expected, setExpected] = useState(expectedFolderIds);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => registerMobileBackHandler("modal", () => { if (!saving) onClose(); return true; }), [onClose, saving]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    let stale = false;
    const positions = folderToMove ? Promise.resolve(undefined)
      : expectedFolderIds && ids.every((id) => Object.hasOwn(expectedFolderIds, id)) ? Promise.resolve(expectedFolderIds)
      : Promise.all(ids.map((id) => api.files.get(id))).then((files) => Object.fromEntries(files.map((file) => [file.id, file.folderId])));
    Promise.all([api.attachmentFolders.list(), positions]).then(([result, sources]) => {
      if (stale) return;
      if (result.supported === false) throw new Error(t("fileExplorer.folderUnavailable"));
      setFolders(result.folders); setExpected(sources);
    }).catch((failure: unknown) => {
      if (!stale) setError(failure instanceof Error ? failure.message : t("fileManager.moveFailed"));
    }).finally(() => { if (!stale) setLoading(false); });
    return () => { stale = true; previous?.focus(); };
    // These values identify the operation for the lifetime of this modal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = async () => {
    setSaving(true);
    try {
      if (folderToMove) {
        const result = await api.attachmentFolders.move(folderToMove.id, target || null);
        toast.success(t("fileExplorer.saved"));
        onMoved(result.parentId, folders.find((folder) => folder.id === result.parentId)?.name || null);
      } else {
        const result = await api.files.move(ids, target || null, expected);
        toast.success(t("fileManager.moved", { count: result.moved }));
        onMoved(result.folderId, result.folderName);
      }
      onClose();
    } catch (failure: unknown) {
      toast.error(failure instanceof Error ? failure.message : t("fileManager.moveFailed"));
    } finally { setSaving(false); }
  };
  const choices = folders.map((folder) => ({ ...folder, path: folderPath(folders, folder.id) }))
    .filter((folder) => !folderToMove || !folder.path.some((ancestor) => ancestor.id === folderToMove.id))
    .filter((folder) => folder.path.map((ancestor) => ancestor.name).join("/").toLowerCase().includes(search.toLowerCase()))
    .sort((left, right) => left.path.map((folder) => folder.name).join("/").localeCompare(right.path.map((folder) => folder.name).join("/")));

  return <div className="fixed inset-0 z-[130] flex items-center justify-center px-4">
    <div className="absolute inset-0 bg-black/30" onClick={() => { if (!saving) onClose(); }} />
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("fileManager.moveFiles")} className="relative w-full max-w-sm rounded-xl border border-app-border bg-app-elevated p-4 shadow-xl outline-none" onKeyDown={(event) => {
      if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); }
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)");
      const first = controls?.[0]; const last = controls?.[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus(); }
    }}>
      <h2 className="text-sm font-semibold text-tx-primary">{t("fileManager.moveFiles")}</h2>
      <p className="mt-2 text-xs text-tx-secondary">{t(folderToMove ? "fileExplorer.moveFolderHint" : "fileManager.moveHint", { count: ids.length })}</p>
      {error ? <p role="alert" className="mt-3 text-xs text-red-500">{error}</p> : <>
        <input aria-label={t("fileExplorer.searchFolders")} placeholder={t("fileExplorer.searchFolders")} value={search} onChange={(event) => setSearch(event.target.value)} disabled={loading || saving} className="mt-4 w-full rounded-lg border border-app-border bg-app-surface p-2 text-sm text-tx-primary" />
        <div role="group" aria-label={t("fileManager.targetFolder")} className="mt-2 max-h-64 overflow-auto rounded-lg border border-app-border">
          <button disabled={loading || saving} aria-pressed={!target} className={`block w-full px-3 py-2 text-left text-sm ${!target ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary"}`} onClick={() => setTarget("")}>{t(folderToMove ? "fileExplorer.rootFolder" : "fileExplorer.unorganized")}</button>
          {choices.map((folder) => <button key={folder.id} disabled={loading || saving} aria-pressed={target === folder.id} title={folder.path.map((ancestor) => ancestor.name).join(" / ")} className={`block w-full truncate py-2 pr-3 text-left text-sm ${target === folder.id ? "bg-accent-primary/10 text-accent-primary" : "text-tx-secondary hover:bg-app-hover"}`} style={{ paddingLeft: 12 + (folder.path.length - 1) * 14 }} onClick={() => setTarget(folder.id)}>{folder.path.map((ancestor) => ancestor.name).join(" / ")}</button>)}
          {!loading && !choices.length && <p className="p-3 text-xs text-tx-tertiary">{t("fileExplorer.noResults")}</p>}
        </div>
      </>}
      <div className="mt-4 flex justify-end gap-2"><Button size="sm" variant="outline" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button><Button size="sm" disabled={loading || saving || !!error} onClick={move}>{t(saving ? "fileManager.moving" : "fileManager.moveFiles")}</Button></div>
    </div>
  </div>;
}
