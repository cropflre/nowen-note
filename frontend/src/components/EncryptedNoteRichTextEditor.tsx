import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

/** Deliberately independent of normal note editors, uploads, Yjs and diagnostic snapshots. */
export default function EncryptedNoteRichTextEditor({ initialContent, editable, onChange }: {
  initialContent: string; editable: boolean; onChange: (content: string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: false, underline: false })],
    content: JSON.parse(initialContent),
    editable,
    onUpdate: ({ editor }) => onChange(JSON.stringify(editor.getJSON())),
    editorProps: {
      attributes: { class: "prose dark:prose-invert max-w-none min-h-64 p-4 outline-none", "aria-label": "加密富文本正文" },
      handleDrop: (_view, event) => { if (event.dataTransfer?.files.length) { event.preventDefault(); return true; } return false; },
      handlePaste: (_view, event) => { if (event.clipboardData?.files.length) { event.preventDefault(); return true; } return false; },
    },
  });
  useEffect(() => { editor?.setEditable(editable, false); }, [editor, editable]);
  return <div className="flex-1 overflow-auto">
    <div className="flex gap-2 border-b border-app-border px-4 py-2">
      <button type="button" disabled={!editable} onClick={() => editor?.chain().focus().toggleBold().run()}>加粗</button>
      <button type="button" disabled={!editable} onClick={() => editor?.chain().focus().toggleItalic().run()}>斜体</button>
      <button type="button" disabled={!editable} onClick={() => editor?.chain().focus().toggleBulletList().run()}>列表</button>
    </div>
    <EditorContent editor={editor} />
  </div>;
}
