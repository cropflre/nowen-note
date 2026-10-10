import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function AdvancedDataManagement({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return <>
    <button type="button" aria-expanded={open} aria-controls="advanced-data-management" onClick={onToggle} className="flex w-full items-center gap-2 rounded-lg border border-zinc-200 p-3 text-left dark:border-zinc-800">
      <Settings size={16} className="text-zinc-400" />
      <span className="flex-1"><span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">{t("dataManager.overview.advanced")}</span><span className="mt-1 block text-xs text-zinc-500">{t("dataManager.overview.advancedHint")}</span></span>
      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
    </button>
    {open && <div id="advanced-data-management" className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800 space-y-4">{children}</div>}
  </>;
}
