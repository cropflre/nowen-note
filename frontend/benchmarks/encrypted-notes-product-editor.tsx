// The production editor components and save callbacks, isolated from user data and the app shell.
import { useRef, useState } from "react";
import "./encrypted-notes-desktop";
import { createRoot } from "react-dom/client";
import i18n from "../src/i18n";
import MarkdownEditor from "../src/components/MarkdownEditorImpl";
import TiptapEditor from "../src/components/TiptapEditor";
import { api } from "../src/lib/api";
import { convertNoteContent } from "../src/lib/noteFormatConversion";
import type { NoteEditorHandle, NoteEditorUpdatePayload } from "../src/components/editors/types";
import type { Note } from "../src/types";
import "../src/index.css";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
localStorage.setItem("nowen-server-url", "http://127.0.0.1:5177");
localStorage.setItem("nowen-token", `test.${btoa(JSON.stringify({ userId: "fixture-owner" }))}.test`);
void i18n.changeLanguage("zh-CN");
declare global { interface Window { productEditorDocument: () => string; productEditorNoteId: () => string } }
function Fixture() {
  const [note, setNote] = useState<Note | null>(null);
  const noteRef = useRef<Note | null>(null);
  const [status, setStatus] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [collaboration, setCollaboration] = useState<{ doc: Y.Doc; awareness: Awareness } | null>(null);
  const editor = useRef<NoteEditorHandle>(null);
  const saveChain = useRef(Promise.resolve());
  function accept(note: Note) { noteRef.current = note; setNote(note); }
  async function create(format: "markdown" | "tiptap-json", collaborative = false) {
    editor.current?.discardPending?.();
    const content = format === "markdown" ? "" : JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });
    accept(await api.createNoteConfirmed({ notebookId: "fixture-public-book", title: "Public title", content, contentFormat: format })); setStatus("编辑器就绪");
    collaboration?.awareness.destroy(); collaboration?.doc.destroy();
    if (collaborative) { const doc = new Y.Doc(); setCollaboration({ doc, awareness: new Awareness(doc) }); }
    else setCollaboration(null);
  }
  function save(data: NoteEditorUpdatePayload) {
    const id = data._noteId || noteRef.current?.id;
    if (!id) return;
    saveChain.current = saveChain.current.then(async () => {
      const current = noteRef.current;
      if (!current || current.id !== id) return;
      try {
        const updated = await api.updateNoteConfirmed(id, { content: data.content, contentText: data.contentText, title: data.title, contentFormat: current.contentFormat, version: current.version });
        if (noteRef.current?.id === id) accept(updated);
        setStatus("实际编辑器保存已确认");
      } catch { setStatus("保存未完成，原密文保留"); }
    });
  }
  async function convert() {
    const snapshot = editor.current?.getSnapshot?.(); const current = noteRef.current;
    if (!snapshot || !current) return;
    editor.current?.discardPending?.(); await saveChain.current;
    const latest = noteRef.current!;
    const converted = convertNoteContent(snapshot.content, snapshot.contentText, latest.contentFormat === "markdown" ? "tiptap-json" : "markdown");
    accept(await api.updateNoteConfirmed(latest.id, { ...converted, version: latest.version })); setStatus("实际编辑器转换已确认");
  }
  window.productEditorDocument = () => editor.current?.getSnapshot?.()?.content || "";
  window.productEditorNoteId = () => noteRef.current?.id || "";
  async function reload() {
    editor.current?.discardPending?.(); await saveChain.current;
    accept(await api.getNote(noteRef.current!.id)); setEpoch((value) => value + 1);
    collaboration?.awareness.destroy(); collaboration?.doc.destroy(); setCollaboration(null);
    setStatus("实际笔记已重载");
  }
  return <div style={{ height: "95vh", display: "flex", flexDirection: "column" }}>
    <div><button onClick={() => void create("markdown")}>打开实际 Markdown 编辑器</button><button onClick={() => void create("markdown", true)}>打开实际 Markdown 协作编辑器</button><button onClick={() => void create("tiptap-json")}>打开实际富文本编辑器</button><button onClick={() => editor.current?.flushSave()}>手动保存编辑器</button><button onClick={() => void convert()}>切换实际编辑器格式</button><button onClick={() => void reload()}>重新载入实际笔记</button><span role="status">{status}</span></div>
    <div style={{ flex: 1, minHeight: 0 }}>{note && (note.contentFormat === "markdown" ? <MarkdownEditor ref={editor} key={`${note.id}:md:${epoch}`} note={note} onUpdate={save} yDoc={collaboration?.doc} awareness={collaboration?.awareness} /> : <TiptapEditor ref={editor} key={`${note.id}:rt:${epoch}`} note={note} onUpdate={save} />)}</div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
