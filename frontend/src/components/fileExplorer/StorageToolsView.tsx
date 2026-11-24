import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { humanFileSize } from "@/lib/fileExplorerModel";
import { sameCleanupPreview, summarizeCleanup, type CleanupSummary, type StorageJumpTarget } from "@/lib/filePageViews";
import type { FileStats } from "@/types";

const FEATURES: Array<{ key: string; target?: StorageJumpTarget }> = [
  { key: "hostMode", target: "imageHost" }, { key: "copyFormats", target: "imageHost" },
  { key: "publicOrigin", target: "imageHost" }, { key: "hostScopes", target: "imageHost" },
  { key: "storageSummary" }, { key: "cleanup" }, { key: "searchSort" },
  { key: "viewModes", target: "files" }, { key: "folderGroups", target: "files" }, { key: "notebookGroups" },
  { key: "batch", target: "files" }, { key: "upload", target: "files" }, { key: "pageSize" }, { key: "details", target: "files" },
];

type ScanState =
  | { status: "scanning" }
  | { status: "ready"; preview: CleanupSummary; changed?: boolean }
  | { status: "cleaning"; preview: CleanupSummary }
  | { status: "error"; error: string };

export default function StorageToolsView({ refreshKey, isCurrent, onCleaned, onGo }: {
  refreshKey: number;
  isCurrent: () => boolean;
  onCleaned: () => void;
  onGo: (target: StorageJumpTarget) => void;
}) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<FileStats | null>(null);
  const [statsError, setStatsError] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [scan, setScan] = useState<ScanState>({ status: "scanning" });
  const [lastResult, setLastResult] = useState<CleanupSummary | null>(null);
  const scanRequest = useRef(0);
  const cleaning = useRef(false);

  const loadStats = useCallback(() => {
    api.files.stats().then((result) => {
      if (isCurrent()) { setStats(result); setStatsError(""); }
    }).catch((failure: unknown) => {
      if (isCurrent()) setStatsError(failure instanceof Error ? failure.message : String(failure));
    });
  }, [isCurrent]);
  const runScan = useCallback(async () => {
    if (cleaning.current) return;
    const request = ++scanRequest.current;
    setScan({ status: "scanning" });
    try {
      const preview = summarizeCleanup(await api.dataFile.cleanupOrphans({ dryRun: true }));
      if (request === scanRequest.current && isCurrent()) setScan({ status: "ready", preview });
    } catch (failure: unknown) {
      // Translated at render time so the scan never depends on the `t` identity.
      if (request === scanRequest.current && isCurrent()) setScan({ status: "error", error: failure instanceof Error ? failure.message : "" });
    }
  }, [isCurrent]);

  useEffect(() => { loadStats(); void runScan(); }, [refreshKey, loadStats, runScan]);
  useEffect(() => {
    let cancelled = false;
    api.getMe().then((user) => { if (!cancelled) setIsAdmin(user?.role === "admin"); }).catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    // Emptying the note trash elsewhere can delete attachments; refresh the numbers shown here.
    const changed = () => { loadStats(); void runScan(); };
    window.addEventListener("nowen:storage-changed", changed);
    return () => window.removeEventListener("nowen:storage-changed", changed);
  }, [loadStats, runScan]);

  const confirmCleanup = async () => {
    if (scan.status !== "ready" || !scan.preview.count || cleaning.current) return;
    const confirmed = scan.preview;
    cleaning.current = true;
    scanRequest.current++;
    setScan({ status: "cleaning", preview: confirmed });
    try {
      const fresh = summarizeCleanup(await api.dataFile.cleanupOrphans({ dryRun: true }));
      if (!isCurrent()) return;
      if (!sameCleanupPreview(confirmed, fresh)) {
        setScan({ status: "ready", preview: fresh, changed: true });
        return;
      }
      const result = summarizeCleanup(await api.dataFile.cleanupOrphans({ dryRun: false }));
      if (!isCurrent()) return;
      setLastResult(result);
      toast.success(t("fileExplorer.storage.done", { count: result.count, size: humanFileSize(result.bytes) }));
      cleaning.current = false;
      onCleaned();
    } catch (failure: unknown) {
      if (!isCurrent()) return;
      toast.error(failure instanceof Error && failure.message ? failure.message : t("fileExplorer.storage.scanFailed"));
      setScan({ status: "ready", preview: confirmed });
    } finally {
      cleaning.current = false;
    }
  };

  const preview = scan.status === "ready" || scan.status === "cleaning" ? scan.preview : null;
  const adminScope = isAdmin || preview?.disk.skipped === false;
  const storage = stats?.storage;
  const storageLabel = !stats ? "—" : storage?.mode === "object" ? t("files.storage.objectEnabled")
    : storage?.mode === "fallback" ? t("files.storage.objectFallback") : t("files.storage.local");
  const storageDetail = [storage?.bucket, storage?.prefix ? `/${storage.prefix}` : ""].filter(Boolean).join(" · ");
  const busy = scan.status === "scanning" || scan.status === "cleaning";

  return <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
    <div className="mx-auto max-w-5xl space-y-4">
      <section aria-labelledby="file-storage-overview">
        <h2 id="file-storage-overview" className="text-sm font-semibold">{t("fileExplorer.storage.overview")}</h2>
        <p className="mt-1 text-xs text-tx-tertiary">{t("fileExplorer.storage.statsScope")}</p>
        {statsError && <p role="alert" className="mt-2 text-xs text-red-500">{statsError}<button className="ml-2 underline" onClick={loadStats}>{t("fileExplorer.retry")}</button></p>}
        <div className="mt-3 grid grid-cols-2 gap-2 md:gap-3 lg:grid-cols-4">
          <StatCard label={t("fileExplorer.storage.used")} value={stats ? humanFileSize(stats.totalBytes) : "—"} />
          <StatCard label={t("fileExplorer.storage.count")} value={stats ? String(stats.total) : "—"}
            detail={stats ? t("fileExplorer.storage.countDetail", { images: stats.images.count, files: stats.files.count }) : undefined} />
          <StatCard label={t("fileExplorer.storage.reclaimable")} tone={preview?.count ? "warning" : undefined}
            value={preview ? humanFileSize(preview.bytes) : scan.status === "scanning" ? t("fileExplorer.storage.scanning") : "—"}
            detail={preview ? t("fileExplorer.storage.reclaimableDetail", { count: preview.count }) : undefined} />
          <StatCard label={t("fileExplorer.storage.location")} value={storageLabel} detail={storageDetail || undefined} />
        </div>
      </section>

      <section aria-labelledby="file-storage-cleanup" className="rounded-lg border border-app-border bg-app-surface p-3 md:p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="file-storage-cleanup" className="text-sm font-semibold">{t("fileExplorer.storage.cleanupTitle")}</h2>
          <button type="button" disabled={busy} onClick={() => void runScan()} className="flex min-h-8 items-center gap-1.5 rounded-md border border-app-border px-2.5 text-xs hover:bg-app-hover disabled:opacity-40">
            <RefreshCw size={13} />{t("fileExplorer.storage.rescan")}
          </button>
        </div>
        <p className="mt-1 text-xs leading-5 text-tx-secondary">{t(adminScope ? "fileExplorer.storage.scopeAdmin" : "fileExplorer.storage.scopeUser")}</p>
        {lastResult && <p role="status" className="mt-3 rounded-md bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          {t("fileExplorer.storage.done", { count: lastResult.count, size: humanFileSize(lastResult.bytes) })}
        </p>}
        {scan.status === "scanning" && <p role="status" className="mt-3 flex items-center gap-2 text-xs text-tx-secondary"><Loader2 size={14} className="animate-spin" />{t("fileExplorer.storage.scanning")}</p>}
        {scan.status === "error" && <p role="alert" className="mt-3 text-xs text-red-500">{scan.error || t("fileExplorer.storage.scanFailed")}<button className="ml-2 underline" onClick={() => void runScan()}>{t("fileExplorer.retry")}</button></p>}
        {preview && <div className="mt-3 space-y-3">
          {scan.status === "ready" && scan.changed && <p role="alert" className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{t("fileExplorer.storage.changed")}</p>}
          <dl className="divide-y divide-app-border rounded-md border border-app-border text-xs">
            {(["content", "db", "disk"] as const).map((key) => <div key={key} className="flex items-center justify-between gap-3 px-3 py-2">
              <dt className="min-w-0 text-tx-secondary">{t(`fileExplorer.storage.categories.${key}`)}</dt>
              <dd className="shrink-0 tabular-nums text-tx-primary">{key === "disk" && preview.disk.skipped ? t("fileExplorer.storage.diskSkipped")
                : t("fileExplorer.storage.categoryValue", { count: preview[key].count, size: humanFileSize(preview[key].bytes) })}</dd>
            </div>)}
          </dl>
          <p className="text-sm font-medium">{preview.count ? t("fileExplorer.storage.total", { count: preview.count, size: humanFileSize(preview.bytes) }) : t("fileExplorer.storage.nothing")}</p>
          <p className="text-xs leading-5 text-tx-tertiary">{t("fileExplorer.storage.rules", { hours: preview.graceHours })}</p>
          {preview.count > 0 && <button type="button" disabled={scan.status === "cleaning"} onClick={() => void confirmCleanup()}
            className="flex min-h-9 items-center gap-1.5 rounded-lg border border-red-500/40 px-3 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-40">
            {scan.status === "cleaning" ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            {scan.status === "cleaning" ? t("fileExplorer.storage.cleaning") : t("fileExplorer.storage.confirm", { count: preview.count })}
          </button>}
        </div>}
      </section>

      <section aria-labelledby="file-storage-features" className="rounded-lg border border-app-border bg-app-surface p-3 md:p-4">
        <h2 id="file-storage-features" className="text-sm font-semibold">{t("fileExplorer.storage.featureMap", { name: t("fileExplorer.storageTools") })}</h2>
        <p className="mt-1 text-xs leading-5 text-tx-secondary">{t("fileExplorer.storage.selectionTools")}</p>
        <div className="mt-3 hidden grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_4rem] gap-3 px-3 text-xs text-tx-tertiary md:grid">
          <span>{t("fileExplorer.storage.featureColumn")}</span><span>{t("fileExplorer.storage.locationColumn")}</span><span />
        </div>
        <ul className="mt-2 divide-y divide-app-border rounded-md border border-app-border text-xs">
          {FEATURES.map(({ key, target }) => <li key={key} className="grid gap-1 px-3 py-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_4rem] md:items-center md:gap-3">
            <span className="font-medium text-tx-primary">{t(`fileExplorer.storage.features.${key}.feature`)}</span>
            <span className="text-tx-secondary">{t(`fileExplorer.storage.features.${key}.location`)}</span>
            {target ? <button type="button" className="justify-self-start text-accent-primary md:justify-self-end" onClick={() => onGo(target)}>{t("fileExplorer.storage.go")}</button> : <span />}
          </li>)}
        </ul>
      </section>
    </div>
  </div>;
}

function StatCard({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "warning" }) {
  return <div className={cn("min-w-0 rounded-lg border bg-app-surface p-3", tone === "warning" ? "border-amber-500/40" : "border-app-border")}>
    <p className="truncate text-xs text-tx-tertiary">{label}</p>
    <p className={cn("mt-1 truncate text-base font-semibold md:text-lg", tone === "warning" && "text-amber-600 dark:text-amber-300")}>{value}</p>
    {detail && <p className="mt-0.5 truncate text-xs text-tx-secondary">{detail}</p>}
  </div>;
}
