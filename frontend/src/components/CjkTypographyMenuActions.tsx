import { Languages, Quote, TextCursorInput } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CjkTypographyAction } from "@/lib/cjkTypography";

const actions: Array<{ action: CjkTypographyAction; icon: typeof Languages }> = [
  { action: "spacing", icon: TextCursorInput },
  { action: "punctuation", icon: Languages },
  { action: "cornerQuotes", icon: Quote },
];

/** Explicit one-click tools; no automatic input transformation or settings toggle. */
export default function CjkTypographyMenuActions({
  onAction, disabled = false, mobile = false,
}: {
  onAction: (action: CjkTypographyAction) => void;
  disabled?: boolean;
  mobile?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div data-cjk-typography-actions className="py-1">
      <div className="px-3 py-1 text-[11px] font-medium text-tx-tertiary">
        {t("editor.cjkTypography.title")}
      </div>
      {actions.map(({ action, icon: Icon }) => (
        <button key={action} type="button"
          disabled={disabled}
          onClick={() => onAction(action)}
          className={"w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-tx-secondary " +
            (mobile ? "active:bg-app-hover " : "hover:bg-app-hover ") +
            "transition-colors disabled:opacity-40"}>
          <Icon size={15} className="shrink-0 text-tx-tertiary" />
          <span>{t("editor.cjkTypography." + action)}</span>
        </button>
      ))}
    </div>
  );
}
