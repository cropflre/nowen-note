import React, { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { common, createLowlight } from "lowlight";
import {
  Bold,
  Code2,
  FileCode2,
  Heading1,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Paperclip,
  Quote,
  Redo2,
  Strikethrough,
  Table2,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  markdownToTiptapJSON,
  normalizeToMarkdown,
  tiptapJsonToMarkdown,
} from "@/lib/contentFormat";
import {
  resolveTaskAttachmentMarkdownForEditor,
  stabilizeTaskAttachmentMarkdown,
  uploadTaskAttachment,
} from "@/lib/taskAttachmentClient";

const lowlight = createLowlight(common);

type Props = {
  taskId: string;
  value: string;
  placeholder: string;
  onSave: (markdown: string) => void;
};

type ToolbarButtonProps = {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
};

function ToolbarButton({ title, active, disabled, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active || undefined}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-accent-primary/12 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        disabled && "cursor-not-allowed opacity-35",
      )}
    >
      {children}
    </button>
  );
}

function editorMarkdown(editor: NonNullable<ReturnType<typeof useEditor>>): string {
  return stabilizeTaskAttachmentMarkdown(tiptapJsonToMarkdown(editor.getJSON())).trimEnd();
}

export default function TaskDescriptionRichEditor({ taskId, value, placeholder, onSave }: Props) {
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraftRef = useRef(value || "");
  const lastEmittedRef = useRef(value || "");
  const [uploading, setUploading] = useState(false);

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Placeholder.configure({ placeholder }),
      Image.configure({ inline: false, allowBase64: false }),
      CodeBlockLowlight.configure({ lowlight }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: markdownToTiptapJSON(resolveTaskAttachmentMarkdownForEditor(normalizeToMarkdown(value || ""))),
    editorProps: {
      attributes: {
        class: "task-description-prosemirror min-h-[180px] px-3 py-3 text-sm leading-6 text-tx-primary outline-none",
        spellcheck: "false",
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      const next = editorMarkdown(currentEditor);
      latestDraftRef.current = next;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        if (lastEmittedRef.current === latestDraftRef.current) return;
        lastEmittedRef.current = latestDraftRef.current;
        onSave(latestDraftRef.current);
      }, 500);
    },
    onBlur: ({ editor: currentEditor }) => {
      const next = editorMarkdown(currentEditor);
      latestDraftRef.current = next;
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (lastEmittedRef.current !== next) {
        lastEmittedRef.current = next;
        onSave(next);
      }
    },
  });

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  useEffect(() => {
    if (!editor) return;
    const normalized = normalizeToMarkdown(value || "");
    if (normalized === latestDraftRef.current || normalized === lastEmittedRef.current) return;
    latestDraftRef.current = normalized;
    lastEmittedRef.current = normalized;
    editor.commands.setContent(
      markdownToTiptapJSON(resolveTaskAttachmentMarkdownForEditor(normalized)),
      { emitUpdate: false },
    );
  }, [editor, value]);

  const uploadFiles = useCallback(async (files: File[], insertImages: boolean) => {
    if (!editor || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of files) {
        const uploaded = await uploadTaskAttachment(file, taskId);
        if (insertImages && file.type.toLowerCase().startsWith("image/")) {
          editor.chain().focus().setImage({
            src: uploaded.url,
            alt: uploaded.filename,
            title: uploaded.filename,
          }).run();
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "任务附件上传失败");
    } finally {
      setUploading(false);
    }
  }, [editor, taskId]);

  const handlePasteCapture = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData?.files || []);
    const images = files.filter((file) => file.type.toLowerCase().startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    void uploadFiles(images, true);
  }, [uploadFiles]);

  const handleDropCapture = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length === 0) return;
    event.preventDefault();
    const hasOnlyImages = files.every((file) => file.type.toLowerCase().startsWith("image/"));
    void uploadFiles(files, hasOnlyImages);
  }, [uploadFiles]);

  if (!editor) {
    return <div className="min-h-[180px] animate-pulse rounded-lg border border-app-border bg-app-bg" />;
  }

  const setLink = () => {
    const previous = editor.getAttributes("link")?.href || "";
    const href = window.prompt("链接地址", previous);
    if (href === null) return;
    const normalized = href.trim();
    if (!normalized) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    if (!/^(https?:\/\/|mailto:|tel:|\/)/i.test(normalized)) {
      toast.error("请输入 http(s) 链接或站内路径");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: normalized }).run();
  };

  return (
    <div
      className="overflow-hidden rounded-lg border border-app-border bg-app-bg focus-within:border-accent-primary"
      onPasteCapture={handlePasteCapture}
      onDropCapture={handleDropCapture}
      onDragOver={(event) => {
        if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
      }}
    >
      <div className="flex items-center gap-0.5 overflow-x-auto border-b border-app-border bg-app-elevated/60 px-1.5 py-1">
        <ToolbarButton title="标题 1" active={editor.isActive("heading", { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 size={15} /></ToolbarButton>
        <ToolbarButton title="标题 2" active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={15} /></ToolbarButton>
        <ToolbarButton title="标题 3" active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={15} /></ToolbarButton>
        <span className="mx-1 h-5 w-px shrink-0 bg-app-border" />
        <ToolbarButton title="粗体" active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></ToolbarButton>
        <ToolbarButton title="斜体" active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></ToolbarButton>
        <ToolbarButton title="删除线" active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}><Strikethrough size={15} /></ToolbarButton>
        <ToolbarButton title="行内代码" active={editor.isActive("code")} onClick={() => editor.chain().focus().toggleCode().run()}><Code2 size={15} /></ToolbarButton>
        <span className="mx-1 h-5 w-px shrink-0 bg-app-border" />
        <ToolbarButton title="无序列表" active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={15} /></ToolbarButton>
        <ToolbarButton title="有序列表" active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={15} /></ToolbarButton>
        <ToolbarButton title="任务列表" active={editor.isActive("taskList")} onClick={() => editor.chain().focus().toggleTaskList().run()}><ListChecks size={15} /></ToolbarButton>
        <ToolbarButton title="引用" active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={15} /></ToolbarButton>
        <ToolbarButton title="代码块" active={editor.isActive("codeBlock")} onClick={() => editor.chain().focus().toggleCodeBlock().run()}><FileCode2 size={15} /></ToolbarButton>
        <span className="mx-1 h-5 w-px shrink-0 bg-app-border" />
        <ToolbarButton title="链接" active={editor.isActive("link")} onClick={setLink}><Link2 size={15} /></ToolbarButton>
        <ToolbarButton title="表格" active={editor.isActive("table")} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 size={15} /></ToolbarButton>
        <ToolbarButton title="插入图片" disabled={uploading} onClick={() => imageInputRef.current?.click()}><ImagePlus size={15} /></ToolbarButton>
        <ToolbarButton title="上传附件" disabled={uploading} onClick={() => fileInputRef.current?.click()}><Paperclip size={15} /></ToolbarButton>
        <span className="mx-1 h-5 w-px shrink-0 bg-app-border" />
        <ToolbarButton title="撤销" disabled={!editor.can().chain().focus().undo().run()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={15} /></ToolbarButton>
        <ToolbarButton title="重做" disabled={!editor.can().chain().focus().redo().run()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={15} /></ToolbarButton>
        {uploading && <span className="ml-1 whitespace-nowrap px-1 text-[10px] text-accent-primary">上传中…</span>}
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          void uploadFiles(files, true);
        }}
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          event.target.value = "";
          void uploadFiles(files, false);
        }}
      />

      <EditorContent editor={editor} />
      <div className="border-t border-app-border px-3 py-1.5 text-[10px] text-tx-tertiary">
        支持粘贴/拖入图片；其他文件上传后会显示在下方附件区。内容以兼容 Markdown 的格式保存。
      </div>
    </div>
  );
}
