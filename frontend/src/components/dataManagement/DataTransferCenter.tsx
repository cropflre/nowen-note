import { motion } from "framer-motion";
import { ArrowLeftRight, Download, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function DataTransferCenter({ onImport, onExport }: { onImport: () => void; onExport: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.45 }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-teal-500/20 via-sky-400/18 to-indigo-500/20 text-teal-600 shadow-xs ring-1 ring-teal-500/20 dark:text-teal-300"
        >
          <ArrowLeftRight size={18} />
        </motion.span>
        <div className="min-w-0">
          <h4 className="text-sm font-bold text-tx-primary">{t("dataManager.overview.transfer")}</h4>
          <p className="mt-0.5 text-xs leading-relaxed text-tx-secondary">{t("dataManager.overview.transferHint")}</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2.5">
        <button
          type="button"
          onClick={onImport}
          className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-700 transition-all hover:-translate-y-0.5 hover:bg-emerald-500/15 dark:text-emerald-300"
        >
          <Upload size={14} />{t("migration.title")}
        </button>
        <button
          type="button"
          onClick={onExport}
          className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-4 py-2 text-xs font-semibold text-tx-primary transition-all hover:-translate-y-0.5 hover:border-teal-400/50 hover:text-teal-600 dark:hover:text-teal-300"
        >
          <Download size={14} />{t("dataManager.overview.export")}
        </button>
      </div>
    </section>
  );
}
