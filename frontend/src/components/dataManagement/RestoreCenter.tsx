import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { History, RefreshCw, Upload } from "lucide-react";
import { formatAppDateTime } from "@/lib/dateTime";
import type { api } from "@/lib/api";
import type { RemoteBackup } from "@/lib/backupWebDavApi";

type LocalBackup = Awaited<ReturnType<typeof api.backup.list>>[number];

export default function RestoreCenter(props: {
  backups: LocalBackup[];
  locationLabel: string;
  remoteBackups: RemoteBackup[];
  remoteLoading: boolean;
  remoteError: string;
  busy: boolean;
  importMessage: string | null;
  advanced: boolean;
  onRefresh: () => void;
  onFile: (file: File) => void;
  onRestore: (backup: LocalBackup) => void;
  onRemoteRestore: (filename: string) => void;
  onDelete: (filename: string) => void;
  onEmail: (backup: LocalBackup) => void;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const rows = [
    ...props.backups.map((backup) => ({ backup, remote: false as const })),
    ...props.remoteBackups.map((backup) => ({ backup, remote: true as const })),
  ].sort((a, b) => b.backup.createdAt.localeCompare(a.backup.createdAt));
  const size = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <section className="space-y-3.5 rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500/18 to-indigo-500/18 text-sky-600 ring-1 ring-sky-500/20 dark:text-sky-300">
          <History size={16} />
        </span>
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-tx-primary">{t("dataManager.overview.restore")}</h4>
          <p className="mt-0.5 text-xs leading-5 text-tx-secondary">{t("dataManager.overview.restoreHint")}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2.5">
        <input ref={input} type="file" accept=".bak,.zip,application/octet-stream,application/zip" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) props.onFile(file); }} />
        <button type="button" disabled={props.busy} onClick={() => input.current?.click()} className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3.5 py-2 text-xs font-semibold text-tx-primary transition-all hover:-translate-y-0.5 hover:border-sky-400/50 hover:text-sky-600 disabled:translate-y-0 disabled:opacity-50 dark:hover:text-sky-300"><Upload size={13} />{t("dataManager.overview.chooseBackup")}</button>
        <button type="button" disabled={props.busy || props.remoteLoading} onClick={props.onRefresh} className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-700 transition-colors hover:bg-sky-500/15 disabled:opacity-50 dark:text-sky-300"><RefreshCw size={12} />{t("dataManager.backup.refresh")}</button>
      </div>
      {props.remoteLoading && <p role="status" className="text-xs text-tx-secondary">{t("dataManager.overview.loadingRemote")}</p>}
      {props.busy && <p role="status" className="text-xs text-tx-secondary">{t("dataManager.backup.importing")}</p>}
      {props.importMessage && <p role="status" className="rounded-xl bg-app-surface/80 px-3 py-2 text-xs font-medium text-tx-secondary">{props.importMessage}</p>}
      {props.remoteError && <p role="alert" className="rounded-xl border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">{t("dataManager.overview.remoteUnavailable", { error: props.remoteError })}</p>}
      {rows.length === 0 && <p className="rounded-xl border border-dashed border-app-border/80 py-6 text-center text-xs text-tx-tertiary">{t("dataManager.backup.noBackups")}</p>}
      <div className="max-h-80 space-y-2 overflow-y-auto pr-0.5">
        {rows.map(({ backup, remote }) => (
          <div key={`${remote}:${backup.filename}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-app-border/75 bg-app-surface/75 px-3.5 py-2.5 transition-all hover:border-sky-400/40">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-tx-primary">{formatAppDateTime(backup.createdAt)}</div>
              <div className="mt-0.5 text-xs text-tx-secondary">{t(backup.type === "full" ? "dataManager.overview.full" : "dataManager.overview.databaseOnly")} · {size(backup.size)} · {remote ? "WebDAV" : props.locationLabel}</div>
            </div>
            <button type="button" disabled={props.busy} onClick={() => remote ? props.onRemoteRestore(backup.filename) : props.onRestore(backup)} className="shrink-0 whitespace-nowrap rounded-lg border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-700 transition-colors hover:bg-sky-500/15 disabled:opacity-50 dark:text-sky-300">{t("dataManager.overview.restore")}</button>
            {props.advanced && !remote && <>
              <button type="button" disabled={props.busy} onClick={() => props.onEmail(backup)} className="shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-xs font-medium text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary">{t("dataManager.backup.sendEmailTooltip")}</button>
              <button type="button" disabled={props.busy} onClick={() => props.onDelete(backup.filename)} className="shrink-0 whitespace-nowrap rounded-lg px-2 py-1 text-xs font-medium text-rose-500 transition-colors hover:bg-rose-500/10">{t("dataManager.backup.delete")}</button>
            </>}
          </div>
        ))}
      </div>
    </section>
  );
}
