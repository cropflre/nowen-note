import { useEffect, useState } from "react";
import "./encrypted-notes-desktop";
import { createRoot } from "react-dom/client";
import { actions, useApp } from "./encrypted-notes-store";
import EncryptedNoteCreateDialog from "../src/components/EncryptedNoteCreateDialog";
import EncryptedNotePane from "../src/components/EncryptedNotePane";
import { getQueue } from "../src/lib/offlineQueue";
import { pendingEncryptedNote } from "../src/lib/encryptedNotes/pendingNote";
import { api } from "../src/lib/api";
import "../src/index.css";
import i18n from "../src/i18n";

void i18n.changeLanguage("zh-CN");
localStorage.setItem("nowen-server-url", "http://127.0.0.1:5177");
localStorage.setItem("nowen-token", `test.${btoa(JSON.stringify({ userId: "fixture-owner" }))}.test`);
function Fixture() {
  const { state } = useApp();
  const [creating, setCreating] = useState(false);
  useEffect(() => { if (state.activeNote) localStorage.setItem("fixture-note-id", state.activeNote.id); }, [state.activeNote]);
  return <div className="flex h-screen flex-col"><div><button onClick={() => setCreating(true)}>新建</button><button onClick={() => actions.setActiveNote(null)}>离开笔记</button>
    <button onClick={() => { const item = getQueue().find((entry) => entry.type === "updateNote"); if (item) actions.setActiveNote(pendingEncryptedNote(item.noteId)); }}>恢复离线笔记</button>
    <button onClick={async () => { const id = localStorage.getItem("fixture-note-id"); if (id) actions.setActiveNote(await api.getNote(id)); }}>恢复服务器笔记</button></div>
    {state.activeNote && <EncryptedNotePane key={state.activeNote.id} note={state.activeNote} />}
    {creating && <EncryptedNoteCreateDialog parentId={null} onClose={() => setCreating(false)} />}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
