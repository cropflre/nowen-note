import type { ReactNode } from "react";
import { ChevronDown, ChevronRight, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

export default function AdvancedDataManagement({ open, onToggle, children }: { open: boolean; onToggle: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return <>
    <button
      type="button"
      aria-expanded={open}
      aria-controls="advanced-data-management"
      onClick={onToggle}
      className="group flex w-full items-center gap-3 rounded-2xl border border-app-border/80 bg-app-elevated/75 p-4 text-left shadow-xs backdrop-blur-sm transition-all hover:border-emerald-400/45 hover:bg-app-elevated"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-app-surface text-tx-secondary ring-1 ring-app-border/70 transition-transform group-hover:rotate-12 group-hover:text-emerald-600 dark:group-hover:text-emerald-300">
        <Settings size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-tx-primary">{t("dataManager.overview.advanced")}</span>
        <span className="mt-0.5 block text-xs text-tx-secondary">{t("dataManager.overview.advancedHint")}</span>
      </span>
      <span className="text-tx-tertiary">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
    </button>
    {open && <div id="advanced-data-management" className="space-y-4 rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm">{children}</div>}
  </>;
}
