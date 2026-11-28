import React, { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import Image from "@tiptap/extension-image";
import {
  Bold,
  Check,
  Code,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  List,
  ListChecks,
  ListOrdered,
  Quote,
  Strikethrough,
  Underline as UnderlineIcon,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { VirtualRichTextSection, VirtualTiptapNode } from "@/lib/virtualRichTextDocument";
import { cn } from "@/lib/utils";

interface VirtualRichTextSectionEditorProps {
  section: VirtualRichTextSection;
  blocks: VirtualTiptapNode[];
  onSave: (sectionDocJson: string) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean, getSnapshot: () => string | null) => void;
}

/**
 * Lightweight single-section TipTap editor mounted on demand when the user clicks
 * to edit a chapter inside a multi-megabyte virtualized rich-text note.
 * Keeps DOM size bounded to <= 120 blocks with zero Yjs or whole-document overhead.
 */
export default function VirtualRichTextSectionEditor({
  section,
  blocks,
  onSave,
  onCancel,
  onDirtyChange,
}: VirtualRichTextSectionEditorProps) {
  const { t } = useTranslation();
  const [dirty, setDirty] = useState(false);
  const initialContent = useMemo(
    () => ({ type: "doc", content: blocks }),
    [blocks],
  );
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      Underline,
      Highlight.configure({ multicolor: true }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Image,
    ],
    content: initialContent,
    autofocus: "start",
    editorProps: {
      attributes: {
        class: "prose prose-sm dark:prose-invert max-w-none focus:outline-none px-2 py-3 text-tx-primary md:px-4",
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          if (editor) onSaveRef.current(JSON.stringify(editor.getJSON()));
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: activeEditor }) => {
      setDirty(true);
      onDirtyChangeRef.current?.(true, () => JSON.stringify(activeEditor.getJSON()));
    },
  }, [section.id]);

  useEffect(() => {
    if (!editor) return;
    onDirtyChangeRef.current?.(false, () => JSON.stringify(editor.getJSON()));
    return () => {
      onDirtyChangeRef.current?.(false, () => null);
    };
  }, [editor]);

  const handleSaveClick = () => {
    if (!editor) return;
    onSave(JSON.stringify(editor.getJSON()));
  };

  const toolBtn = (active: boolean) => cn(
    "inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs transition-colors",
    active
      ? "bg-accent-primary/15 text-accent-primary"
      : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
  );

  return (
    <div
      data-virtual-section-editor={section.id}
      className="nowen-virtual-section-editor -mx-2 my-3 overflow-hidden rounded-2xl border-2 border-accent-primary/50 bg-app-elevated shadow-lg ring-4 ring-accent-primary/10 md:-mx-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border/80 bg-gradient-to-r from-indigo-500/[0.08] via-app-surface to-violet-500/[0.07] px-2.5 py-2 md:px-4">
        <div className="flex flex-wrap items-center gap-1">
          <span className="mr-1.5 inline-flex items-center rounded-full bg-accent-primary/12 px-2.5 py-0.5 text-[11px] font-semibold text-accent-primary">
            {t("markdown.largeDocument.editingSectionBadge", {
              defaultValue: `正在编辑第 ${section.index + 1} 节（${blocks.length} 块）`,
              index: section.index + 1,
              count: blocks.length,
            })}
          </span>
          {editor && (
            <>
              <button type="button" title="加粗" className={toolBtn(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={13} /></button>
              <button type="button" title="斜体" className={toolBtn(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={13} /></button>
              <button type="button" title="下划线" className={toolBtn(editor.isActive("underline"))} onClick={() => editor.chain().focus().toggleUnderline().run()}><UnderlineIcon size={13} /></button>
              <button type="button" title="删除线" className={toolBtn(editor.isActive("strike"))} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={13} /></button>
              <button type="button" title="高亮" className={toolBtn(editor.isActive("highlight"))} onClick={() => editor.chain().focus().toggleHighlight().run()}><Highlighter size={13} /></button>
              <button type="button" title="行内代码" className={toolBtn(editor.isActive("code"))} onClick={() => editor.chain().focus().toggleCode().run()}><Code size={13} /></button>
              <span className="mx-0.5 h-4 w-px bg-app-border" />
              <button type="button" title="二级标题" className={toolBtn(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={13} /></button>
              <button type="button" title="三级标题" className={toolBtn(editor.isActive("heading", { level: 3 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={13} /></button>
              <button type="button" title="无序列表" className={toolBtn(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={13} /></button>
              <button type="button" title="有序列表" className={toolBtn(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={13} /></button>
              <button type="button" title="待办列表" className={toolBtn(editor.isActive("taskList"))} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks size={13} /></button>
              <button type="button" title="引用" className={toolBtn(editor.isActive("blockquote"))} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={13} /></button>
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-xl border border-app-border bg-app-surface px-2.5 py-1.5 text-xs font-medium text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary"
          >
            <X size={13} />
            {t("common.cancel", { defaultValue: "取消" })}
          </button>
          <button
            type="button"
            onClick={handleSaveClick}
            className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-xl bg-gradient-to-r from-indigo-500 via-violet-500 to-fuchsia-500 px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition-all hover:shadow-sm"
          >
            <Check size={13} />
            {dirty
              ? t("markdown.largeDocument.saveSection", { defaultValue: "保存本章" })
              : t("markdown.largeDocument.doneEditing", { defaultValue: "完成编辑" })}
          </button>
        </div>
      </div>

      <div className="max-h-[65vh] overflow-y-auto bg-app-bg/50">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
