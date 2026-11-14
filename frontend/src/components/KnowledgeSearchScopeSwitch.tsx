import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export type KnowledgeSearchScope = "tree" | "content";

export default function KnowledgeSearchScopeSwitch({
  scope,
  onChange,
  compact = false,
  treeLabel,
  contentLabel,
}: {
  scope: KnowledgeSearchScope;
  onChange: (scope: KnowledgeSearchScope) => void;
  compact?: boolean;
  treeLabel?: string;
  contentLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("auditI18n.searchScope")}
      className={cn(
        "inline-flex shrink-0 items-center bg-app-hover",
        compact ? "gap-0 rounded-md p-0.5" : "gap-1 rounded-xl p-1",
      )}
    >
      {([
        ["tree", treeLabel ?? t("auditI18n.tree"), t("auditI18n.treeNames")],
        ["content", contentLabel ?? t("auditI18n.fullText"), t("auditI18n.searchContentLabel")],
      ] as const).map(([value, label, title]) => (
        <button
          key={value}
          type="button"
          aria-pressed={scope === value}
          title={title}
          onClick={() => onChange(value)}
          className={cn(
            "rounded-[5px] font-medium transition-colors",
            compact ? "px-1.5 py-1 text-[10px]" : "px-2.5 py-1.5 text-xs",
            scope === value
              ? "bg-app-surface text-accent-primary shadow-sm"
              : "text-tx-tertiary hover:text-tx-primary",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
