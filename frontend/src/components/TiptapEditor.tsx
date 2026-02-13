import React, { useCallback, useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { common, createLowlight } from "lowlight";
import {
  Bold, Italic, Underline as UnderlineIcon, Strikethrough,
  Code, List, ListOrdered, Heading1, Heading2, Heading3,
  Quote, ImagePlus, CheckSquare, Highlighter, Minus, Undo, Redo,
  FileCode
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Note, Tag } from "@/types";
import TagInput from "@/components/TagInput";

const lowlight = createLowlight(common);

interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title?: string;
}

function ToolbarButton({ onClick, isActive, disabled, children, title }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "p-1.5 rounded-md transition-colors",
        isActive
          ? "bg-accent-primary/20 text-accent-primary"
          : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        disabled && "opacity-30 cursor-not-allowed"
      )}
    >
      {children}
    </button>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-5 bg-app-border mx-1" />;
}

interface TiptapEditorProps {
  note: Note;
  onUpdate: (data: { content: string; contentText: string; title: string }) => void;
  onTagsChange?: (tags: Tag[]) => void;
}

export default function TiptapEditor({ note, onUpdate, onTagsChange }: TiptapEditorProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: "开始写点什么...",
        emptyEditorClass: "is-editor-empty",
      }),
      Image.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: { class: "rounded-lg max-w-full mx-auto my-4 shadow-md" },
      }),
      CodeBlockLowlight.configure({ lowlight }),
      Underline,
      Highlight.configure({
        multicolor: true,
        HTMLAttributes: { class: "highlight-mark" },
      }),
      TaskList.configure({
        HTMLAttributes: {
          class: 'task-list',
        },
      }),
      TaskItem.configure({
        nested: true,
        HTMLAttributes: {
          class: 'task-item',
        },
      }),
    ],
    content: parseContent(note.content),
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[300px] px-1",
      },
    },
    onUpdate: ({ editor }) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const json = JSON.stringify(editor.getJSON());
        const text = editor.getText();
        const title = titleRef.current?.value || note.title;
        onUpdate({ content: json, contentText: text, title });
      }, 500);
    },
  });

  useEffect(() => {
    if (editor && note) {
      const parsed = parseContent(note.content);
      const currentJson = JSON.stringify(editor.getJSON());
      const newJson = JSON.stringify(parsed);
      if (currentJson !== newJson) {
        editor.commands.setContent(parsed);
      }
    }
    if (titleRef.current) {
      titleRef.current.value = note.title;
    }
  }, [note.id]);

  const handleTitleChange = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      const title = titleRef.current?.value || "";
      const json = editor ? JSON.stringify(editor.getJSON()) : note.content;
      const text = editor ? editor.getText() : note.contentText;
      onUpdate({ content: json, contentText: text, title });
    }, 500);
  }, [editor, note, onUpdate]);

  const handleImageUpload = useCallback(() => {
    if (!editor) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        const src = e.target?.result as string;
        editor.chain().focus().setImage({ src }).run();
      };
      reader.readAsDataURL(file);
    };
    input.click();
  }, [editor]);

  if (!editor) return null;

  const iconSize = 15;

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-4 py-2 border-b border-app-border bg-app-surface/50 md:flex-wrap overflow-x-auto hide-scrollbar touch-pan-x transition-colors">
        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title="撤销">
          <Undo size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title="重做">
          <Redo size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          isActive={editor.isActive("heading", { level: 1 })}
          title="标题 1"
        >
          <Heading1 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          isActive={editor.isActive("heading", { level: 2 })}
          title="标题 2"
        >
          <Heading2 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          isActive={editor.isActive("heading", { level: 3 })}
          title="标题 3"
        >
          <Heading3 size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title="加粗"
        >
          <Bold size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title="斜体"
        >
          <Italic size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={editor.isActive("underline")}
          title="下划线"
        >
          <UnderlineIcon size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          isActive={editor.isActive("strike")}
          title="删除线"
        >
          <Strikethrough size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          isActive={editor.isActive("highlight")}
          title="高亮"
        >
          <Highlighter size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCode().run()}
          isActive={editor.isActive("code")}
          title="行内代码"
        >
          <Code size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title="无序列表"
        >
          <List size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title="有序列表"
        >
          <ListOrdered size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          isActive={editor.isActive("taskList")}
          title="任务列表"
        >
          <CheckSquare size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          isActive={editor.isActive("blockquote")}
          title="引用"
        >
          <Quote size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          isActive={editor.isActive("codeBlock")}
          title="代码块"
        >
          <FileCode size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title="分割线"
        >
          <Minus size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={handleImageUpload} title="插入图片">
          <ImagePlus size={iconSize} />
        </ToolbarButton>
      </div>

      {/* Title */}
      <div className="px-4 md:px-8 pt-4 md:pt-6 pb-0">
        <input
          ref={titleRef}
          defaultValue={note.title}
          onChange={handleTitleChange}
          placeholder="笔记标题"
          className="w-full bg-transparent text-2xl font-bold text-tx-primary placeholder:text-tx-tertiary focus:outline-none"
        />
        <div className="flex items-center gap-3 mt-2 text-[10px] text-tx-tertiary">
          <span>版本 {note.version}</span>
          <span>·</span>
          <span>更新于 {new Date(note.updatedAt + "Z").toLocaleString("zh-CN")}</span>
        </div>
      </div>

      {/* Tag Bar */}
      <div className="px-4 md:px-8 pb-2">
        <TagInput
          noteId={note.id}
          noteTags={note.tags || []}
          onTagsChange={onTagsChange}
        />
      </div>

      {/* Bubble menu for inline formatting */}
      {editor && (
        <BubbleMenu editor={editor}
          className="flex items-center gap-0.5 bg-app-elevated border border-app-border rounded-lg shadow-lg p-1"
        >
          <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} isActive={editor.isActive("bold")}>
            <Bold size={14} />
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} isActive={editor.isActive("italic")}>
            <Italic size={14} />
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} isActive={editor.isActive("underline")}>
            <UnderlineIcon size={14} />
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleHighlight().run()} isActive={editor.isActive("highlight")}>
            <Highlighter size={14} />
          </ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleCode().run()} isActive={editor.isActive("code")}>
            <Code size={14} />
          </ToolbarButton>
        </BubbleMenu>
      )}

      {/* Editor content */}
      <div className="flex-1 overflow-auto px-4 md:px-8 pb-12">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

function parseContent(content: string): any {
  if (!content || content === "{}") {
    return { type: "doc", content: [{ type: "paragraph" }] };
  }
  if (typeof content === "string") {
    try { return JSON.parse(content); } catch { return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: content }] }] }; }
  }
  return content;
}
