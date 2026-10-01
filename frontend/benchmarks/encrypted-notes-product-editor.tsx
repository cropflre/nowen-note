// The production editor components and save callbacks, isolated from user data and the app shell.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import MarkdownEditor from "../src/components/MarkdownEditorImpl";
import TiptapEditor from "../src/components/TiptapEditor";
import { api } from "../src/lib/api";
import { convertNoteContent } from "../src/lib/noteFormatConversion";
import type { NoteEditorHandle, NoteEditorUpdatePayload } from "../src/components/editors/types";
import type { Note } from "../src/types";
import "../src/index.css";
localStorage.setItem("nowen-server-url", "http://127.0.0.1:5177");
localStorage.setItem("nowen-token", `test.${btoa(JSON.stringify({ userId: "fixture-owner" }))}.test`);
void i18n.use(initReactI18next).init({ lng: "zh-CN", resources: { "zh-CN": { translation: {} } }, initImmediate: false });
declare global { interface Window { productEditorDocument: () => string } }
function Fixture() {
  const [note, setNote] = useState<Note | null>(null);
  const noteRef = useRef<Note | null>(null);
  const [status, setStatus] = useState("");
  const editor = useRef<NoteEditorHandle>(null);
  const saveChain = useRef(Promise.resolve());
  function accept(note: Note) { noteRef.current = note; setNote(note); }
  async function create(format: "markdown" | "tiptap-json") {
    editor.current?.discardPending?.();
    const content = format === "markdown" ? "" : JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] });
    accept(await api.createNoteConfirmed({ notebookId: "fixture-public-book", title: "Public title", content, contentFormat: format })); setStatus("编辑器就绪");
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
  return <div style={{ height: "95vh", display: "flex", flexDirection: "column" }}>
    <div><button onClick={() => void create("markdown")}>打开实际 Markdown 编辑器</button><button onClick={() => void create("tiptap-json")}>打开实际富文本编辑器</button><button onClick={() => editor.current?.flushSave()}>手动保存编辑器</button><button onClick={() => void convert()}>切换实际编辑器格式</button><span role="status">{status}</span></div>
    <div style={{ flex: 1, minHeight: 0 }}>{note && (note.contentFormat === "markdown" ? <MarkdownEditor ref={editor} key={`${note.id}:md`} note={note} onUpdate={save} /> : <TiptapEditor ref={editor} key={`${note.id}:rt`} note={note} onUpdate={save} />)}</div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
