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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex !h-6 !min-h-6 !max-h-6 self-center shrink-0 items-center gap-0.5 rounded-md bg-app-hover px-1.5 text-[10px] font-medium leading-none text-tx-secondary hover:bg-app-active hover:text-tx-primary"
        data-knowledge-search-scope-button="true"
        aria-label={`搜索范围：${scope === "tree" ? "目录" : "全文"}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{scope === "tree" ? "目录" : "全文"}</span>
        <ChevronDown size={10} aria-hidden="true" />
      </button>
      <KnowledgeTreeDropdownMenu
        open={open}
        anchor={buttonRef.current}
        ariaLabel="搜索范围"
        items={[
          { value: "tree", label: "目录与文档名称", checked: scope === "tree" },
          { value: "content", label: "笔记标题与正文", checked: scope === "content" },
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
