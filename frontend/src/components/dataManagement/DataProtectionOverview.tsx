import { motion } from "framer-motion";
import { Loader2, ShieldCheck, Save, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatAppDateTime } from "@/lib/dateTime";
import { cn } from "@/lib/utils";

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
  const statusKey = props.loading ? "checking" : !props.available ? "unavailable" : props.healthy ? "protected" : props.lastBackup ? "attention" : "noBackup";
  return (
    <section className="relative overflow-hidden rounded-2xl border border-app-border/80 bg-gradient-to-br from-emerald-500/[0.07] via-app-elevated/85 to-teal-500/[0.07] p-5 shadow-xs backdrop-blur-sm">
      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-emerald-400/15 blur-2xl" />
      <div className="relative flex flex-wrap items-center gap-3">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.45 }}
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl shadow-xs ring-1",
            props.healthy
              ? "bg-gradient-to-br from-emerald-500/20 via-teal-400/18 to-sky-500/20 text-emerald-600 ring-emerald-500/25 dark:text-emerald-300"
              : "bg-app-surface text-tx-tertiary ring-app-border/80",
          )}
        >
          <ShieldCheck size={20} />
        </motion.span>
        <h4 className="text-sm font-bold text-tx-primary">{t("dataManager.overview.protection")}</h4>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
            props.healthy
              ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
              : !props.available && !props.loading
                ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                : "bg-amber-500/12 text-amber-700 dark:text-amber-300",
          )}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", props.healthy ? "bg-emerald-500" : !props.available && !props.loading ? "bg-rose-500" : "bg-amber-500")} />
          {t(`dataManager.overview.${statusKey}`)}
        </span>
      </div>
      <dl className="relative mt-4 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2.5 rounded-xl border border-app-border/70 bg-app-surface/75 px-4 py-3 text-xs text-tx-secondary">
        <dt className="font-medium text-tx-tertiary">{t("dataManager.overview.lastBackup")}</dt>
        <dd className="font-semibold text-tx-primary">{props.lastBackup ? formatAppDateTime(props.lastBackup) : t("dataManager.overview.noBackup")}</dd>
        <dt className="font-medium text-tx-tertiary">{t("dataManager.overview.automatic")}</dt>
        <dd>
          <label className="inline-flex cursor-pointer items-center gap-2 font-medium text-tx-primary">
            <input
              type="checkbox"
              checked={props.automatic}
              disabled={!props.available || props.saving || props.loading}
              onChange={(e) => props.onAutomaticChange(e.target.checked)}
              aria-label={t("dataManager.overview.automatic")}
              className="h-4 w-4 rounded accent-emerald-600"
            />
            {props.schedule}
          </label>
        </dd>
        <dt className="font-medium text-tx-tertiary">{t("dataManager.overview.location")}</dt>
        <dd className="font-semibold text-tx-primary">{props.location}</dd>
      </dl>
      <p className="relative mt-3 text-xs leading-5 text-tx-secondary">{t("dataManager.overview.fullBackupHint")}</p>
      <div className="relative mt-4 flex flex-wrap gap-2.5">
        <button
          type="button"
          disabled={!props.available || props.loading || props.busy}
          onClick={props.onBackup}
          className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-emerald-500/20 transition-all hover:-translate-y-0.5 hover:shadow-md disabled:translate-y-0 disabled:opacity-50"
        >
          {props.busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}{t("dataManager.overview.backupNow")}
        </button>
        <button
          type="button"
          onClick={props.onRestore}
          className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-4 py-2 text-xs font-semibold text-tx-primary transition-all hover:-translate-y-0.5 hover:border-emerald-400/50 hover:text-emerald-600 dark:hover:text-emerald-300"
        >
          <Upload size={14} />{t("dataManager.overview.restore")}
        </button>
      </div>
    </section>
  );
}
