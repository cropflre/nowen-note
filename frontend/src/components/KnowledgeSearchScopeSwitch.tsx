import { cn } from "@/lib/utils";

export type KnowledgeSearchScope = "tree" | "content";

export default function KnowledgeSearchScopeSwitch({
  scope,
  onChange,
  compact = false,
  treeLabel = "目录",
  contentLabel = "全文",
}: {
  scope: KnowledgeSearchScope;
  onChange: (scope: KnowledgeSearchScope) => void;
  compact?: boolean;
  treeLabel?: string;
  contentLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label="搜索范围"
      className={cn(
        "inline-flex shrink-0 items-center bg-app-hover",
        compact ? "gap-0 rounded-md p-0.5" : "gap-1 rounded-xl p-1",
      )}
    >
      {([
        ["tree", treeLabel, "仅筛选目录和文档名称"],
        ["content", contentLabel, "搜索笔记标题与正文"],
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
