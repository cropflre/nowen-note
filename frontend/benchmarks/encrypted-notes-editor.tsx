import { useState } from "react";
import { createRoot } from "react-dom/client";
import { actions, useApp } from "./encrypted-notes-store";
import EncryptedNoteCreateDialog from "../src/components/EncryptedNoteCreateDialog";
import EncryptedNotePane from "../src/components/EncryptedNotePane";
import { getQueue } from "../src/lib/offlineQueue";
import { pendingEncryptedNote } from "../src/lib/encryptedNotes/pendingNote";

localStorage.setItem("nowen-server-url", "http://127.0.0.1:5177");
localStorage.setItem("nowen-token", `test.${btoa(JSON.stringify({ userId: "fixture-owner" }))}.test`);
function Fixture() {
  const { state } = useApp();
  const [creating, setCreating] = useState(false);
  return <><button onClick={() => setCreating(true)}>新建</button><button onClick={() => actions.setActiveNote(null)}>离开笔记</button>
    <button onClick={() => { const item = getQueue().find((entry) => entry.type === "updateNote"); if (item) actions.setActiveNote(pendingEncryptedNote(item.noteId)); }}>恢复离线笔记</button>
    {state.activeNote && <EncryptedNotePane key={state.activeNote.id} note={state.activeNote} />}
    {creating && <EncryptedNoteCreateDialog parentId={null} onClose={() => setCreating(false)} />}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
