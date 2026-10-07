import { Loader2, ShieldCheck, Save, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function DataProtectionOverview(props: {
  loading: boolean;
  available: boolean;
  healthy: boolean;
  lastBackup: string | null;
  automatic: boolean;
  schedule: string;
  location: string;
  busy: boolean;
  saving: boolean;
  onBackup: () => void;
  onRestore: () => void;
  onAutomaticChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <section className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-800/30">
      <div className="flex items-center gap-2">
        <ShieldCheck size={20} className={props.healthy ? "text-emerald-500" : "text-zinc-400"} />
        <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("dataManager.overview.protection")}</h4>
        <span className="ml-auto text-xs text-zinc-500">{t(`dataManager.overview.${props.loading ? "checking" : !props.available ? "unavailable" : props.healthy ? "protected" : props.lastBackup ? "attention" : "noBackup"}`)}</span>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs text-zinc-500 dark:text-zinc-400">
        <dt>{t("dataManager.overview.lastBackup")}</dt>
        <dd className="text-zinc-800 dark:text-zinc-200">{props.lastBackup ? new Date(props.lastBackup).toLocaleString() : t("dataManager.overview.noBackup")}</dd>
        <dt>{t("dataManager.overview.automatic")}</dt>
        <dd>
          <label className="inline-flex items-center gap-2">
            <input type="checkbox" checked={props.automatic} disabled={!props.available || props.saving || props.loading} onChange={(e) => props.onAutomaticChange(e.target.checked)} aria-label={t("dataManager.overview.automatic")} className="accent-emerald-600" />
            {props.schedule}
          </label>
        </dd>
        <dt>{t("dataManager.overview.location")}</dt><dd>{props.location}</dd>
      </dl>
      <p className="mt-3 text-xs leading-5 text-zinc-500 dark:text-zinc-400">{t("dataManager.overview.fullBackupHint")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={!props.available || props.loading || props.busy} onClick={props.onBackup} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
          {props.busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}{t("dataManager.overview.backupNow")}
        </button>
        <button type="button" onClick={props.onRestore} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-white dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
          <Upload size={14} />{t("dataManager.overview.restore")}
        </button>
      </div>
    </section>
  );
}
