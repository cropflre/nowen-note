import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import KnowledgeTreeDropdownMenu from "@/components/KnowledgeTreeDropdownMenu";
import type { KnowledgeSearchScope } from "@/components/KnowledgeSearchScopeSwitch";

export default function KnowledgeSearchScopeMenuButton({
  scope,
  onChange,
}: {
  scope: KnowledgeSearchScope;
  onChange: (scope: KnowledgeSearchScope) => void;
}) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex !h-7 !min-h-7 !max-h-7 self-center shrink-0 items-center gap-1 rounded-md bg-transparent px-1.5 text-[10px] font-medium leading-none text-tx-secondary hover:bg-app-hover hover:text-tx-primary"
        data-knowledge-search-scope-button="true"
        aria-label={`${t("auditI18n.searchScope")}: ${t(scope === "tree" ? "auditI18n.tree" : "auditI18n.fullText")}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{t(scope === "tree" ? "auditI18n.tree" : "auditI18n.fullText")}</span>
        <ChevronDown size={10} aria-hidden="true" />
      </button>
      <KnowledgeTreeDropdownMenu
        open={open}
        anchor={buttonRef.current}
        ariaLabel={t("auditI18n.searchScope")}
        items={[
          { value: "tree", label: t("auditI18n.treeNames"), checked: scope === "tree" },
          { value: "content", label: t("auditI18n.noteContents"), checked: scope === "content" },
        ]}
        onSelect={(value) => {
          setOpen(false);
          if (value === "tree" || value === "content") onChange(value);
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
