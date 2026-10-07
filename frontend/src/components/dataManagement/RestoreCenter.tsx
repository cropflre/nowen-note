import { useRef } from "react";
import { useTranslation } from "react-i18next";
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
    <section className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 space-y-3">
      <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("dataManager.overview.restore")}</h4>
      <p className="text-xs leading-5 text-zinc-500">{t("dataManager.overview.restoreHint")}</p>
      <div className="flex flex-wrap gap-3">
        <input ref={input} type="file" accept=".bak,.zip,application/octet-stream,application/zip" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) props.onFile(file); }} />
        <button type="button" disabled={props.busy} onClick={() => input.current?.click()} className="rounded-lg border border-zinc-300 px-3 py-2 text-xs text-zinc-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200">{t("dataManager.overview.chooseBackup")}</button>
        <button type="button" disabled={props.busy || props.remoteLoading} onClick={props.onRefresh} className="text-xs text-indigo-600 disabled:opacity-50">{t("dataManager.backup.refresh")}</button>
      </div>
      {props.remoteLoading && <p role="status" className="text-xs text-zinc-500">{t("dataManager.overview.loadingRemote")}</p>}
      {props.busy && <p role="status" className="text-xs text-zinc-500">{t("dataManager.backup.importing")}</p>}
      {props.importMessage && <p role="status" className="text-xs text-zinc-600 dark:text-zinc-300">{props.importMessage}</p>}
      {props.remoteError && <p role="alert" className="text-xs text-amber-600">{t("dataManager.overview.remoteUnavailable", { error: props.remoteError })}</p>}
      {rows.length === 0 && <p className="py-4 text-center text-xs text-zinc-400">{t("dataManager.backup.noBackups")}</p>}
      <div className="max-h-80 overflow-y-auto space-y-2">
        {rows.map(({ backup, remote }) => <div key={`${remote}:${backup.filename}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-zinc-800 dark:text-zinc-200">{new Date(backup.createdAt).toLocaleString()}</div>
            <div className="mt-1 text-xs text-zinc-500">{t(backup.type === "full" ? "dataManager.overview.full" : "dataManager.overview.databaseOnly")} · {size(backup.size)} · {remote ? "WebDAV" : props.locationLabel}</div>
          </div>
          <button type="button" disabled={props.busy} onClick={() => remote ? props.onRemoteRestore(backup.filename) : props.onRestore(backup)} className="text-xs text-indigo-600 disabled:opacity-50">{t("dataManager.overview.restore")}</button>
          {props.advanced && !remote && <>
            <button type="button" disabled={props.busy} onClick={() => props.onEmail(backup)} className="text-xs text-zinc-500">{t("dataManager.backup.sendEmailTooltip")}</button>
            <button type="button" disabled={props.busy} onClick={() => props.onDelete(backup.filename)} className="text-xs text-red-500">{t("dataManager.backup.delete")}</button>
          </>}
        </div>)}
      </div>
    </section>
  );
}
