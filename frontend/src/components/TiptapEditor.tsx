import React, { useCallback, useEffect, useRef, useState } from "react";
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
import { useTranslation } from "react-i18next";

const lowlight = createLowlight(common);

export interface HeadingItem {
  id: string;
  level: number;
  text: string;
  pos: number;
}

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
  onHeadingsChange?: (headings: HeadingItem[]) => void;
  onEditorReady?: (scrollTo: (pos: number) => void) => void;
}

function extractHeadings(editor: any): HeadingItem[] {
  const headings: HeadingItem[] = [];
  const doc = editor.state.doc;
  let idx = 0;
  doc.descendants((node: any, pos: number) => {
    if (node.type.name === "heading") {
      headings.push({
        id: `h-${idx++}`,
        level: node.attrs.level,
        text: node.textContent || "",
        pos,
      });
    }
  });
  return headings;
}

export default function TiptapEditor({ note, onUpdate, onTagsChange, onHeadingsChange, onEditorReady }: TiptapEditorProps) {
  const titleRef = useRef<HTMLInputElement>(null);
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const [wordStats, setWordStats] = useState({ chars: 0, charsNoSpace: 0, words: 0 });
  const { t, i18n } = useTranslation();

  const editorScrollRef = useRef<HTMLDivElement | null>(null);

  const computeStats = useCallback((text: string) => {
    const chars = text.length;
    const charsNoSpace = text.replace(/\s/g, "").length;
    // 中文按字计数 + 英文按空格分词
    const cjk = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
    const nonCjk = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, " ").trim();
    const enWords = nonCjk ? nonCjk.split(/\s+/).filter(Boolean).length : 0;
    return { chars, charsNoSpace, words: cjk + enWords };
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: t('tiptap.placeholder'),
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
      const text = editor.getText();
      setWordStats(computeStats(text));
      onHeadingsChange?.(extractHeadings(editor));
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => {
        const json = JSON.stringify(editor.getJSON());
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
      setWordStats(computeStats(editor.getText()));
      onHeadingsChange?.(extractHeadings(editor));
    }
    if (titleRef.current) {
      titleRef.current.value = note.title;
    }
  }, [note.id]);

  // Provide scrollTo callback to parent
  useEffect(() => {
    if (!editor) return;
    const scrollTo = (pos: number) => {
      editor.commands.focus();
      editor.commands.setTextSelection(pos);
      // Scroll the heading node into view
      const dom = editor.view.domAtPos(pos + 1);
      if (dom?.node) {
        const el = dom.node instanceof HTMLElement ? dom.node : dom.node.parentElement;
        el?.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    onEditorReady?.(scrollTo);
  }, [editor, onEditorReady]);

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
        <ToolbarButton onClick={() => editor.chain().focus().undo().run()} disabled={!editor.can().undo()} title={t('tiptap.undo')}>
          <Undo size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={() => editor.chain().focus().redo().run()} disabled={!editor.can().redo()} title={t('tiptap.redo')}>
          <Redo size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          isActive={editor.isActive("heading", { level: 1 })}
          title={t('tiptap.heading1')}
        >
          <Heading1 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          isActive={editor.isActive("heading", { level: 2 })}
          title={t('tiptap.heading2')}
        >
          <Heading2 size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          isActive={editor.isActive("heading", { level: 3 })}
          title={t('tiptap.heading3')}
        >
          <Heading3 size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBold().run()}
          isActive={editor.isActive("bold")}
          title={t('tiptap.bold')}
        >
          <Bold size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleItalic().run()}
          isActive={editor.isActive("italic")}
          title={t('tiptap.italic')}
        >
          <Italic size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          isActive={editor.isActive("underline")}
          title={t('tiptap.underline')}
        >
          <UnderlineIcon size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleStrike().run()}
          isActive={editor.isActive("strike")}
          title={t('tiptap.strikethrough')}
        >
          <Strikethrough size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          isActive={editor.isActive("highlight")}
          title={t('tiptap.highlight')}
        >
          <Highlighter size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCode().run()}
          isActive={editor.isActive("code")}
          title={t('tiptap.inlineCode')}
        >
          <Code size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          isActive={editor.isActive("bulletList")}
          title={t('tiptap.bulletList')}
        >
          <List size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          isActive={editor.isActive("orderedList")}
          title={t('tiptap.orderedList')}
        >
          <ListOrdered size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleTaskList().run()}
          isActive={editor.isActive("taskList")}
          title={t('tiptap.taskList')}
        >
          <CheckSquare size={iconSize} />
        </ToolbarButton>

        <ToolbarDivider />

        <ToolbarButton
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          isActive={editor.isActive("blockquote")}
          title={t('tiptap.blockquote')}
        >
          <Quote size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().toggleCodeBlock().run()}
          isActive={editor.isActive("codeBlock")}
          title={t('tiptap.codeBlock')}
        >
          <FileCode size={iconSize} />
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
          title={t('tiptap.horizontalRule')}
        >
          <Minus size={iconSize} />
        </ToolbarButton>
        <ToolbarButton onClick={handleImageUpload} title={t('tiptap.insertImage')}>
          <ImagePlus size={iconSize} />
        </ToolbarButton>
      </div>

      {/* Title */}
      <div className="px-4 md:px-8 pt-4 md:pt-6 pb-0">
        <input
          ref={titleRef}
          defaultValue={note.title}
          onChange={handleTitleChange}
          placeholder={t('tiptap.titlePlaceholder')}
          className="w-full bg-transparent text-2xl font-bold text-tx-primary placeholder:text-tx-tertiary focus:outline-none"
        />
        <div className="flex items-center gap-3 mt-2 text-[10px] text-tx-tertiary">
          <span>{t('tiptap.version')}{note.version}</span>
          <span>·</span>
          <span>{t('tiptap.updatedAt')}{new Date(note.updatedAt + "Z").toLocaleString()}</span>
          <span>·</span>
          <span>{wordStats.words}{t('tiptap.words')}</span>
          <span>·</span>
          <span>{wordStats.charsNoSpace}{t('tiptap.chars')}</span>
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
    try {
      return JSON.parse(content);
    } catch {
      // HTML 内容直接返回字符串，Tiptap 可以解析 HTML
      if (content.trim().startsWith("<")) {
        return content;
      }
      return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: content }] }] };
    }
  }
  return content;
}
