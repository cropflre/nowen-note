import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileCode, FileText, FileType2, FileUp, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export type NoteType = "normal" | "markdown" | "markdown-file" | "word" | "wechat";

export interface CreateNoteMenuProps {
  onPick: (type: NoteType) => void | Promise<void>;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

type CreateNoteMenuItem = {
  id: NoteType;
  label: string;
  desc: string;
  icon: React.ReactNode;
};

/**
 * 笔记列表的新建与导入菜单。
 *
 * 创建：富文本、Markdown。
 * 导入：Markdown 文件、Word 文档、微信公众号文章。
 * 所有动作都交给 NoteList 统一解析当前目录和工作区，避免菜单自己猜测目标位置。
 */
export default function CreateNoteMenu({ onPick, onClose, anchorRef }: CreateNoteMenuProps) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const menuWidth = 248;
      const estimatedHeight = 304;
      const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, rect.right - menuWidth));
      const top = Math.max(8, Math.min(window.innerHeight - estimatedHeight - 8, rect.bottom + 4));
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!pos) return null;

  const createItems: CreateNoteMenuItem[] = [
    {
      id: "normal",
      label: t("sidebar.newNote", { defaultValue: "新建笔记" }),
      desc: t("sidebar.newNoteDesc", { defaultValue: "富文本编辑器" }),
      icon: <FileText size={15} />,
    },
    {
      id: "markdown",
      label: t("sidebar.newMarkdownNote", { defaultValue: "新建 Markdown 笔记" }),
      desc: t("sidebar.newMarkdownNoteDesc", { defaultValue: "原生 Markdown 编辑器" }),
      icon: <FileCode size={15} />,
    },
  ];

  const importItems: CreateNoteMenuItem[] = [
    {
      id: "markdown-file",
      label: t("sidebar.importMarkdownNote", { defaultValue: "导入 Markdown 文件" }),
      desc: t("sidebar.importMarkdownNoteDesc", { defaultValue: "支持 .md / .markdown，可多选" }),
      icon: <FileUp size={15} />,
    },
    {
      id: "word",
      label: t("sidebar.importWordNote", { defaultValue: "导入 Word 文档" }),
      desc: t("sidebar.importWordNoteDesc", { defaultValue: "选择 .docx 转为可编辑笔记" }),
      icon: <FileType2 size={15} />,
    },
    {
      id: "wechat",
      label: t("sidebar.importUrlNote", { defaultValue: "导入公众号文章" }),
      desc: t("sidebar.importUrlNoteDesc", { defaultValue: "输入微信公众号文章链接" }),
      icon: <Link2 size={15} />,
    },
  ];

  const renderItem = (item: CreateNoteMenuItem) => (
    <button
      key={item.id}
      type="button"
      role="menuitem"
      data-note-menu-action={item.id}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        void Promise.resolve(onPick(item.id)).catch((error) => {
          console.error("Failed to handle create/import menu pick:", error);
        });
      }}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
    >
      <span className="mt-0.5 shrink-0 text-tx-tertiary">{item.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{item.label}</span>
        <span className="mt-0.5 block truncate text-[10px] text-tx-tertiary">{item.desc}</span>
      </span>
    </button>
  );

  return createPortal(
    <div
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 9998, background: "transparent" }}
    >
      <div
        role="menu"
        aria-label={t("noteList.createAndImport", { defaultValue: "新建与导入" })}
        className="rounded-lg border border-app-border bg-app-elevated py-1 shadow-xl"
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          width: 248,
          zIndex: 9999,
          animation: "contextMenuIn 0.12s ease-out",
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {createItems.map(renderItem)}
        <div className="my-1 border-t border-app-border" role="separator" />
        {importItems.map(renderItem)}
      </div>
    </div>,
    document.body,
  );
}
