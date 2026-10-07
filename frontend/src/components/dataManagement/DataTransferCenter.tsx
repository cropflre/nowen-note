import { Download, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function DataTransferCenter({ onImport, onExport }: { onImport: () => void; onExport: () => void }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <h4 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{t("dataManager.overview.transfer")}</h4>
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{t("dataManager.overview.transferHint")}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={onImport} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"><Upload size={14} />{t("dataManager.overview.import")}</button>
        <button type="button" onClick={onExport} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"><Download size={14} />{t("dataManager.overview.export")}</button>
      </div>
    </section>
  );
}
