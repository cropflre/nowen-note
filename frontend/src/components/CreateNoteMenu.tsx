import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, FileCode, FileType2, Calendar } from "lucide-react";
import { setNextMarkdownNoteTemplate, type MarkdownNoteTemplate } from "@/lib/newNoteDefaults";

export type NoteType = "normal" | "markdown" | "word" | "journal";

export interface CreateNoteMenuProps {
  onPick: (type: NoteType) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

/**
 * 新建笔记下拉菜单
 *
 * 复用组件：顶部工具栏 "+" 和树形列表笔记本行内 "+" 共用。
 * 菜单项：
 *   - 新建笔记（富文本编辑器）
 *   - 新建 Markdown 笔记（原生 Markdown 编辑器）
 *   - 新建代码块笔记（Markdown + ```text``` 模板）
 *   - 新建 SQL 笔记（Markdown + ```sql``` 模板）
 *   - 今日日记（自动创建或打开今日日记）
 *   - 导入 Word 文档（.docx 转可编辑笔记）
 */
export default function CreateNoteMenu({ onPick, onClose, anchorRef }: CreateNoteMenuProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const left = Math.max(4, Math.min(window.innerWidth - 220, rect.right - 200));
      const top = Math.min(window.innerHeight - 8, rect.bottom + 4);
      setPos({ top, left });
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!pos) return null;

  const items: Array<{
    id: string;
    noteType: NoteType;
    label: string;
    desc: string;
    icon: React.ReactNode;
    markdownTemplate?: MarkdownNoteTemplate;
  }> = [
    {
      id: "normal",
      noteType: "normal",
      label: "新建笔记",
      desc: "富文本编辑器",
      icon: <FileText size={14} />,
    },
    {
      id: "markdown",
      noteType: "markdown",
      label: "新建 Markdown 笔记",
      desc: "原生 Markdown 编辑器",
      icon: <FileCode size={14} />,
    },
    {
      id: "markdown-code",
      noteType: "markdown",
      label: "新建代码块笔记",
      desc: "Markdown · ```text``` 模板",
      icon: <FileCode size={14} />,
      markdownTemplate: "code",
    },
    {
      id: "markdown-sql",
      noteType: "markdown",
      label: "新建 SQL 笔记",
      desc: "Markdown · ```sql``` 模板",
      icon: <FileCode size={14} />,
      markdownTemplate: "sql",
    },
    {
      id: "journal",
      noteType: "journal",
      label: "今日日记",
      desc: "一键创建或打开今日日记",
      icon: <Calendar size={14} />,
    },
    {
      id: "word",
      noteType: "word",
      label: "导入 Word 文档",
      desc: "选择 .docx 转为可编辑笔记",
      icon: <FileType2 size={14} />,
    },
  ];

  return createPortal(
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); onClose(); } }}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 9998, background: "transparent" }}
    >
      <div
        role="menu"
        className="rounded-lg border border-app-border bg-app-elevated shadow-xl py-1"
        style={{
          position: "fixed", top: pos.top, left: pos.left, width: 200, zIndex: 9999,
          animation: "contextMenuIn 0.12s ease-out",
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (it.markdownTemplate) setNextMarkdownNoteTemplate(it.markdownTemplate);
              onPick(it.noteType);
              onClose();
            }}
            className="w-full flex items-start gap-2 px-3 py-2 text-left text-tx-secondary hover:bg-app-hover hover:text-tx-primary transition-colors"
          >
            <span className="mt-0.5 shrink-0 text-tx-tertiary">{it.icon}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-medium truncate">{it.label}</span>
              <span className="block text-[10px] text-tx-tertiary truncate">{it.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
