import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { confirm } from "@/components/ui/confirm";
import { useFileSelection } from "@/hooks/useFileSelection";
import { chunkIds, FILE_BATCH_CHUNK_LIMIT, FILE_SELECT_ALL_MATCHES_LIMIT, humanFileSize } from "@/lib/fileExplorerModel";
import { parseServerTime } from "@/lib/dateTime";
import { toast } from "@/lib/toast";

type Entry = Awaited<ReturnType<typeof api.files.trash.list>>["entries"][number];
export default function AssetTrash({ onBack, isCurrent }: { onBack: () => void; isCurrent: () => boolean }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const selectAllRef = useRef<HTMLInputElement>(null);
  const shiftRef = useRef(false);
  const {
    selectedIds: selected,
    selectingAll,
    allPageSelected,
    somePageSelected,
    clearSelection,
    syncPageItems,
    handleSelectItem,
    togglePage: toggleSelectPage,
    selectAllMatching,
  } = useFileSelection(entries);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = somePageSelected && !allPageSelected;
    }
  }, [allPageSelected, somePageSelected]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    api.files.trash.list(page).then((result) => {
      if (!active || !isCurrent()) return;
      setEntries(result.entries); setTotal(result.total); setSupported(result.supported);
      syncPageItems(result.entries);
      if (!result.entries.length && page > 1 && result.total) setPage((value) => value - 1);
    }).catch((cause: unknown) => { if (active && isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active && isCurrent()) setLoading(false); });
    return () => { active = false; };
  }, [page, revision, isCurrent, syncPageItems]);

  const actOnFiles = useCallback(async (purge: boolean) => {
    if (!selected.size || busy) return;
    if (purge && !await confirm({ title: t("assetTrash.purge"), description: t("assetTrash.purgeHint", { count: selected.size }), danger: true })) return;
    if (!isCurrent()) return;
    setBusy(true); setError("");
    try {
      const batches = chunkIds([...selected], FILE_BATCH_CHUNK_LIMIT);
      if (purge) {
        let hasCleanupPending = false;
        for (const batch of batches) {
          const result = await api.files.trash.purge(batch);
          if (!isCurrent()) return;
          if (result.cleanupPending.length) hasCleanupPending = true;
        }
        if (hasCleanupPending) toast.error(t("assetTrash.cleanupPending"));
      } else {
        let hasFallback = false;
        for (const batch of batches) {
          const result = await api.files.trash.restore(batch);
          if (!isCurrent()) return;
          if (result.restored.some((row) => row.fallback)) hasFallback = true;
        }
        if (hasFallback) toast.info(t("assetTrash.fallback"));
      }
      clearSelection();
      setRevision((value) => value + 1);
      window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "asset-trash" } }));
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (isCurrent()) setBusy(false); }
  }, [selected, busy, isCurrent, clearSelection, t]);

  const emptyTrash = useCallback(async () => {
    if (busy || !supported || total === 0 || typeof api.files.trash.empty !== "function") return;
    if (!await confirm({ title: t("assetTrash.emptyAction"), description: t("assetTrash.emptyHint", { count: total }), danger: true })) return;
    if (!isCurrent()) return;
    setBusy(true); setError("");
    try {
      const result = await api.files.trash.empty();
      if (!isCurrent()) return;
      if (result.cleanupPending.length) toast.error(t("assetTrash.cleanupPending"));
      if (result.skipped > 0 && result.count === 0) {
        toast.info(t("assetTrash.emptySkippedOnly", { skipped: result.skipped }));
      } else if (result.skipped > 0) {
        toast.info(t("assetTrash.emptyPartial", { count: result.count, skipped: result.skipped }));
      } else if (result.count > 0) {
        toast.success(t("assetTrash.emptied", { count: result.count }));
      }
      clearSelection();
      setPage(1);
      setRevision((value) => value + 1);
      window.dispatchEvent(new CustomEvent("nowen:storage-changed", { detail: { reason: "asset-trash" } }));
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (isCurrent()) setBusy(false); }
  }, [busy, supported, total, isCurrent, clearSelection, t]);

  return <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-app-bg text-tx-primary">
    <header className="flex flex-wrap items-center gap-3 border-b border-app-border p-4">
      <button onClick={onBack} className="flex items-center gap-2 text-xs text-accent-primary"><ArrowLeft size={16} />{t("fileExplorer.backToFiles")}</button>
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Trash2 size={17} />{t("assetTrash.title")}</h2>
      <span className="text-xs text-tx-tertiary">{t("fileExplorer.fileCount", { count: total })}</span>
      <button type="button" disabled={busy || loading || !supported || total === 0}
        onClick={() => void emptyTrash()}
        className="ml-auto flex items-center gap-1.5 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-500 hover:bg-red-500/10 disabled:opacity-30">
        <Trash2 size={14} />{t("assetTrash.emptyAction")}
      </button>
    </header>
    <p className="border-b border-app-border p-4 text-xs leading-5 text-tx-secondary">{t("assetTrash.hint")}</p>
    {supported && (entries.length > 0 || selected.size > 0) && <div className="flex flex-wrap items-center gap-3 border-b border-app-border bg-app-surface px-4 py-2.5 text-xs">
      <label className="flex cursor-pointer items-center gap-2">
        <input ref={selectAllRef} type="checkbox" aria-label={t(allPageSelected ? "assetTrash.deselectAll" : "assetTrash.selectAllPage")}
          disabled={loading || busy || !entries.length} checked={allPageSelected} onChange={toggleSelectPage} />
        <span>{t(allPageSelected ? "assetTrash.deselectAll" : "assetTrash.selectAllPage")}</span>
      </label>
      {selected.size > 0 && <span className="text-tx-secondary">{t("fileExplorer.selected", { count: selected.size })}</span>}
      {allPageSelected && total > selected.size && (total <= FILE_SELECT_ALL_MATCHES_LIMIT
        ? <button type="button" disabled={selectingAll || busy} className="text-accent-primary underline disabled:opacity-40"
            onClick={() => void selectAllMatching(async (targetPage, targetSize) => {
              const res = await api.files.trash.list(targetPage, targetSize);
              return { items: res.entries, total: res.total };
            }, isCurrent, FILE_SELECT_ALL_MATCHES_LIMIT, 100)}>
            {selectingAll ? t("fileExplorer.loading") : t("assetTrash.selectAllCount", { count: total })}
          </button>
        : <span className="text-tx-tertiary">{t("fileExplorer.selectAllTooMany", { max: FILE_SELECT_ALL_MATCHES_LIMIT })}</span>)}
      {selected.size > 0 && <button type="button" disabled={busy} className="text-tx-secondary hover:text-tx-primary disabled:opacity-40" onClick={clearSelection}>{t("common.cancel")}</button>}
    </div>}
    {!supported && <p role="status" className="p-4 text-sm text-tx-secondary">{t("assetTrash.nativeUnavailable")}</p>}
    {error && <div role="alert" className="p-4 text-xs text-red-500">{error}<button className="ml-2 underline" onClick={() => setRevision((value) => value + 1)}>{t("fileExplorer.retry")}</button></div>}
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {loading ? <Loader2 className="mx-auto animate-spin" /> : !entries.length && supported ? <p className="py-12 text-center text-sm text-tx-tertiary">{t("assetTrash.empty")}</p> : entries.map((entry) => <label key={entry.id} className="mb-2 flex cursor-pointer items-center gap-3 rounded-lg border border-app-border bg-app-surface p-3 hover:bg-app-hover">
        <input type="checkbox" aria-label={entry.filename} disabled={busy} checked={selected.has(entry.id)}
          onClick={(event) => { shiftRef.current = event.shiftKey; }}
          onChange={() => { handleSelectItem(entry, { toggle: true, range: shiftRef.current }); shiftRef.current = false; }} />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm">{entry.filename}</span><span className="text-xs text-tx-tertiary">{humanFileSize(entry.size)} · {parseServerTime(entry.trashedAt)?.toLocaleString() || entry.trashedAt}</span></span>
      </label>)}
    </div>
    <footer className="flex flex-wrap items-center gap-4 border-t border-app-border p-4 text-xs">
      <button disabled={busy || !selected.size} className="flex items-center gap-1 text-accent-primary disabled:opacity-30" onClick={() => void actOnFiles(false)}><RotateCcw size={14} />{t("assetTrash.restore")}</button>
      <button disabled={busy || !selected.size} className="flex items-center gap-1 text-red-500 disabled:opacity-30" onClick={() => void actOnFiles(true)}><Trash2 size={14} />{t("assetTrash.purge")}</button>
      <div className="ml-auto flex items-center gap-3"><button disabled={loading || busy || page === 1} onClick={() => setPage((value) => value - 1)}>{t("assetOrganization.previousPage")}</button><span>{page} / {Math.max(1, Math.ceil(total / 50))}</span><button disabled={loading || busy || page * 50 >= total} onClick={() => setPage((value) => value + 1)}>{t("assetOrganization.nextPage")}</button></div>
    </footer>
  </section>;
}
