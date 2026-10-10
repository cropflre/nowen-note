import { useEffect, useState, type ReactNode } from "react";
import { getOfflineQueueStorageKey } from "@/lib/offlineQueue";
import { convertedNoteVersion } from "@/lib/encryptedNotes/conversionBarrier";
import { holdConversionEditorLease } from "@/lib/encryptedNotes/conversionCoordination";

/** Keep ordinary editors out of an ongoing local conversion cleanup. */
export default function EncryptedConversionEditorGuard({ noteId, children }: { noteId: string | null; children: ReactNode }) {
  const scope = getOfflineQueueStorageKey();
  const identity = JSON.stringify([scope, noteId]);
  if (!noteId || !navigator.locks?.request) return children;
  return <EditorLease key={identity} scope={scope} noteId={noteId}>{children}</EditorLease>;
}

function EditorLease({ noteId, scope, children }: { noteId: string | null; scope: string; children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [converted, setConverted] = useState(false);
  const [retry, setRetry] = useState(0);
  const supported = Boolean(navigator.locks?.request);
  useEffect(() => {
    if (!noteId || !supported) return;
    setFailed(false);
    const release = holdConversionEditorLease(noteId, () => {
      if (scope !== getOfflineQueueStorageKey()) throw new Error("scope_changed");
      if (convertedNoteVersion(noteId, scope) === null) setReady(true);
      else { setConverted(true); throw new Error("converted_note"); }
    }, () => setFailed(true));
    const invalidate = () => {
      if (scope === getOfflineQueueStorageKey()) return;
      release(); setReady(false); setFailed(true);
    };
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === "nowen-token" || event.key === "nowen-server-url") invalidate();
    };
    window.addEventListener("nowen:token-changed", invalidate);
    window.addEventListener("nowen:server-url-changed", invalidate);
    window.addEventListener("storage", storage);
    invalidate();
    return () => {
      release();
      window.removeEventListener("nowen:token-changed", invalidate);
      window.removeEventListener("nowen:server-url-changed", invalidate);
      window.removeEventListener("storage", storage);
    };
  }, [noteId, scope, supported, retry]);
  // Ordinary editing remains available on older browsers; cleanup refuses them.
  if (!noteId || !supported || ready) return children;
  return <div className="flex h-full items-center justify-center text-sm text-tx-secondary" role="status">
    {converted ? "笔记已加密，请重新打开" : failed ? <button onClick={() => setRetry((value) => value + 1)}>无法确认笔记状态，点击重试</button> : "正在确认笔记状态…"}
  </div>;
}
