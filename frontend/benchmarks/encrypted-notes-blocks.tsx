// Actual region components, worker, document converters and API against a private fixture DB.
import { useEffect, useState } from "react";
import "./encrypted-notes-desktop";
import { createRoot } from "react-dom/client";
import { EditorContent, ReactNodeViewRenderer, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import CodeBlock from "@tiptap/extension-code-block";
import { CodeBlockView } from "../src/components/CodeBlockView";
import EncryptedBlockDialog from "../src/components/EncryptedBlockDialog";
import { MarkdownCodeBlock } from "../src/components/MarkdownCodeBlock";
import { ENCRYPTED_BLOCK_LANGUAGE, markdownEncryptedBlocks } from "../src/lib/encryptedNotes/blockDocument";
import { convertNoteContent } from "../src/lib/noteFormatConversion";
import { publishEditorEditable } from "../src/lib/editorEditableStore";
import { api } from "../src/lib/api";
import type { Note } from "../src/types";
import i18n from "../src/i18n";
void i18n.changeLanguage("zh-CN");
localStorage.setItem("nowen-server-url", "http://127.0.0.1:5177");
localStorage.setItem("nowen-token", `test.${btoa(JSON.stringify({ userId: "fixture-owner" }))}.test`);
declare global { interface Window { blockFixtureDocument: () => string } }
function Fixture() {
  const [note, setNote] = useState<Note | null>(null);
  const [source, setSource] = useState("");
  const [markdown, setMarkdown] = useState(false);
  const [creating, setCreating] = useState<{ commit: (source: string) => void } | null>(null);
  const [status, setStatus] = useState("");
  const editor = useEditor({ extensions: [StarterKit.configure({ codeBlock: false }), CodeBlock.extend({ addNodeView: () => ReactNodeViewRenderer(CodeBlockView) })], content: "<p>Public before</p>", onUpdate: ({ editor }) => setSource(JSON.stringify(editor.getJSON())) });
  useEffect(() => { window.blockFixtureDocument = () => markdown ? source : JSON.stringify(editor?.getJSON()); }, [editor, source, markdown]);
  async function load() {
    const id = localStorage.getItem("fixture-block-note-id");
    const loaded = id ? await api.getNote(id) : await api.createNoteConfirmed({ notebookId: "fixture-public-book", title: "Public title", content: "Public before", contentFormat: "markdown" });
    setNote(loaded); localStorage.setItem("fixture-block-note-id", loaded.id);
    const rich = convertNoteContent(loaded.content, "", "tiptap-json");
    editor?.commands.setContent(JSON.parse(rich.content)); setSource(rich.content); setMarkdown(false); setStatus("已载入");
  }
  function create() {
    if (!editor) return;
    const snapshot = editor.state.doc;
    setCreating({ commit: (source) => {
      if (editor.state.doc !== snapshot) throw new Error("Changed document");
      if (!editor.commands.insertContentAt(1, { type: "codeBlock", attrs: { language: ENCRYPTED_BLOCK_LANGUAGE }, content: [{ type: "text", text: source }] })) throw new Error("Write failed");
    } });
  }
  function convert() {
    const input = markdown ? source : JSON.stringify(editor?.getJSON());
    const converted = convertNoteContent(input, "", markdown ? "tiptap-json" : "markdown");
    setSource(converted.content);
    if (markdown) editor?.commands.setContent(JSON.parse(converted.content));
    setMarkdown(!markdown);
  }
  async function save() {
    if (!note) return;
    try { const updated = await api.updateNoteConfirmed(note.id, { content: markdown ? source : JSON.stringify(editor?.getJSON()), contentFormat: markdown ? "markdown" : "tiptap-json", version: note.version }); setNote(updated); setStatus("服务器已保存密文"); }
    catch { setStatus("保存失败，主文档密文保留"); }
  }
  const blocks = markdown ? markdownEncryptedBlocks(source) : [];
  return <><button onClick={() => void load()}>载入普通笔记</button><button onClick={create} disabled={!note || markdown}>新增加密区域</button>
    <button onClick={convert}>转换格式</button><button onClick={() => void save()}>保存主文档</button>
    <button onClick={() => editor?.commands.undo()}>撤销</button><button onClick={() => editor?.commands.redo()}>重做</button>
    <button onClick={() => { editor?.setEditable(false); if (editor) publishEditorEditable(editor); }}>只读</button>
    <button onClick={() => editor?.commands.insertContentAt(editor.state.doc.content.size - 1, "public change")}>外部修改</button>
    <button onClick={() => { if (!editor) return; let position: number | undefined; editor.state.doc.descendants((node, pos) => { if (position === undefined && node.type.name === "codeBlock") position = pos; }); if (position !== undefined) editor.view.dispatch(editor.state.tr.insertText("!", position + 1, position + 2)); }}>修改区域密文</button>
    <p role="status">{status}</p>
    {markdown ? <>{blocks.map((block) => <MarkdownCodeBlock key={block.from} className={`language-${ENCRYPTED_BLOCK_LANGUAGE}`}>{block.source}</MarkdownCodeBlock>)}<textarea aria-label="主文档 Markdown 密文" value={source} readOnly /></> : <EditorContent editor={editor} />}
    {creating && <EncryptedBlockDialog onCommit={creating.commit} onClose={() => setCreating(null)} />}
    <pre aria-label="文档密文">{markdown ? source : JSON.stringify(editor?.getJSON())}</pre>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
