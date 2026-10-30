import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Loader2, RotateCcw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { confirm } from "@/components/ui/confirm";
import { humanFileSize } from "@/lib/fileExplorerModel";
import { parseServerTime } from "@/lib/dateTime";
import { toast } from "@/lib/toast";

type Entry = Awaited<ReturnType<typeof api.files.trash.list>>["entries"][number];
export default function AssetTrash({ onBack, isCurrent }: { onBack: () => void; isCurrent: () => boolean }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set<string>());
  const [revision, setRevision] = useState(0);
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setSelected(new Set());
    api.files.trash.list(page).then((result) => {
      if (!active || !isCurrent()) return;
      setEntries(result.entries); setTotal(result.total); setSupported(result.supported);
      if (!result.entries.length && page > 1 && result.total) setPage((value) => value - 1);
    }).catch((cause: unknown) => { if (active && isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active && isCurrent()) setLoading(false); });
    return () => { active = false; };
  }, [page, revision, isCurrent]);
  const actOnFiles = useCallback(async (purge: boolean) => {
    if (!selected.size || busy) return;
    if (purge && !await confirm({ title: t("assetTrash.purge"), description: t("assetTrash.purgeHint", { count: selected.size }), danger: true })) return;
    if (!isCurrent()) return;
    setBusy(true); setError("");
    try {
      if (purge) {
        const result = await api.files.trash.purge([...selected]);
        if (!isCurrent()) return;
        if (result.cleanupPending.length) toast.error(t("assetTrash.cleanupPending"));
      } else {
        const result = await api.files.trash.restore([...selected]);
        if (!isCurrent()) return;
        if (result.restored.some((row) => row.fallback)) toast.info(t("assetTrash.fallback"));
      }
      setSelected(new Set()); setRevision((value) => value + 1);
    } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }, [selected, busy, isCurrent, t]);
  return <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-app-bg text-tx-primary">
    <header className="flex flex-wrap items-center gap-3 border-b border-app-border p-4">
      <button onClick={onBack} className="flex items-center gap-2 text-xs text-accent-primary"><ArrowLeft size={16} />{t("fileExplorer.backToFiles")}</button>
      <h2 className="flex items-center gap-2 text-sm font-semibold"><Trash2 size={17} />{t("assetTrash.title")}</h2>
      <span className="text-xs text-tx-tertiary">{t("fileExplorer.fileCount", { count: total })}</span>
    </header>
    <p className="border-b border-app-border p-4 text-xs leading-5 text-tx-secondary">{t("assetTrash.hint")}</p>
    {!supported && <p role="status" className="p-4 text-sm text-tx-secondary">{t("assetTrash.nativeUnavailable")}</p>}
    {error && <div role="alert" className="p-4 text-xs text-red-500">{error}<button className="ml-2 underline" onClick={() => setRevision((value) => value + 1)}>{t("fileExplorer.retry")}</button></div>}
    <div className="min-h-0 flex-1 overflow-auto p-4">
      {loading ? <Loader2 className="mx-auto animate-spin" /> : !entries.length && supported ? <p className="py-12 text-center text-sm text-tx-tertiary">{t("assetTrash.empty")}</p> : entries.map((entry) => <label key={entry.id} className="mb-2 flex cursor-pointer items-center gap-3 rounded-lg border border-app-border bg-app-surface p-3">
        <input type="checkbox" aria-label={entry.filename} disabled={busy} checked={selected.has(entry.id)} onChange={() => setSelected((previous) => { const next = new Set(previous); if (next.has(entry.id)) next.delete(entry.id); else next.add(entry.id); return next; })} />
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
