import { useEffect, useRef, useState } from "react";
import { Lock, ChevronLeft } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { Button } from "./ui/button";
import EncryptedNoteRichTextEditor from "./EncryptedNoteRichTextEditor";
import { useAppActions } from "@/store/AppContext";
import { api } from "@/lib/api";
import { getOfflineQueueStorageKey, getQueue } from "@/lib/offlineQueue";
import type { Note } from "@/types";
import { canWriteNote } from "@/lib/notePermissions";
import { saveEncryptedNoteCiphertext } from "@/lib/encryptedNotes/saveNote";
import { runEncryptedContentOperation } from "@/lib/encryptedNotes/workerClient";
import { EncryptedContentError, type EncryptedContentEnvelope } from "@/lib/encryptedNotes/envelope";
import { ENCRYPTED_NOTE_FORMAT, ENCRYPTED_NOTE_LEAVE_EVENT, readEncryptedNoteDocument, validateEncryptedNotePlaintext } from "@/lib/encryptedNotes/noteDocument";

export default function EncryptedNotePane({ note }: { note: Note }) {
  const actions = useAppActions();
  const [session, setSession] = useState<{ envelope: EncryptedContentEnvelope; initialContent: string } | null>(null);
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const password = useRef("");
  const operation = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const dirty = body !== savedBody;
  const editable = canWriteNote(note) && !note.isLocked && !note.isTrashed;
  const native = Capacitor.isNativePlatform();
  const refs = useRef({ dirty, busy }); refs.current = { dirty, busy };

  useEffect(() => {
    mounted.current = true;
    const scope = getOfflineQueueStorageKey();
    const beforeLeave = (event: Event) => {
      if (refs.current.dirty || refs.current.busy) { event.preventDefault(); setError("请先保存密文，或明确放弃修改后再离开"); }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (refs.current.dirty || refs.current.busy) { event.preventDefault(); event.returnValue = ""; } };
    const clear = () => {
      if (getOfflineQueueStorageKey() === scope) return;
      operation.current?.abort(); password.current = "";
      setSession(null); setBody(""); setSavedBody(""); setPassphrase(""); setNewPassphrase(""); setConfirmation("");
    };
    window.addEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, beforeLeave);
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("nowen:token-changed", clear);
    window.addEventListener("nowen:server-url-changed", clear);
    return () => {
      mounted.current = false; operation.current?.abort(); password.current = "";
      window.removeEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, beforeLeave);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("nowen:token-changed", clear);
      window.removeEventListener("nowen:server-url-changed", clear);
    };
  }, []);

  async function execute(task: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setStatus("");
    try { await task(controller.signal); }
    catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof EncryptedContentError && failure.code === "unlock-failed"
        ? "口令错误或密文损坏，原密文已保留"
        : "操作未完成，原密文和当前修改已保留；请检查加密能力、网络或版本冲突后重试");
    } finally { submitting.current = false; operation.current = null; if (mounted.current) setBusy(false); }
  }
  async function unlock() {
    if (native) return;
    const inputPassword = passphrase;
    await execute(async (signal) => {
      const envelope = readEncryptedNoteDocument(note);
      const plaintext = await runEncryptedContentOperation({ operation: "decrypt", input: { envelope, expected: envelope, passphrase: inputPassword } }, signal);
      validateEncryptedNotePlaintext(plaintext, envelope.originalFormat);
      if (!mounted.current || signal.aborted) return;
      password.current = inputPassword; setPassphrase("");
      setBody(plaintext); setSavedBody(plaintext); setSession({ envelope, initialContent: plaintext });
    });
  }
  async function save(changePassword = false) {
    if (!session || !editable) return;
    if (changePassword && getQueue().some((item) => item.noteId === note.id)) { setError("请先将离线密文同步到服务器，再修改口令"); return; }
    if (changePassword && (dirty || newPassphrase.length < 12 || newPassphrase !== confirmation)) { setError("请先保存正文，并输入两次相同且至少 12 个字符的新口令"); return; }
    const plaintext = body;
    await execute(async (signal) => {
      // Refuse to overwrite ciphertext revalidated or changed by another device.
      if (JSON.stringify(readEncryptedNoteDocument(note)) !== JSON.stringify(session.envelope)) throw new Error("Conflict");
      validateEncryptedNotePlaintext(plaintext, session.envelope.originalFormat);
      const envelope = changePassword
        ? await runEncryptedContentOperation({ operation: "change-passphrase", input: { envelope: session.envelope, expected: session.envelope, passphrase: password.current, newPassphrase } }, signal)
        : await runEncryptedContentOperation({ operation: "update", input: { envelope: session.envelope, expected: session.envelope, passphrase: password.current, plaintext } }, signal);
      if (!mounted.current || signal.aborted) return;
      submitting.current = true;
      setStatus("正在提交密文…");
      const payload = { content: JSON.stringify(envelope), contentFormat: ENCRYPTED_NOTE_FORMAT, contentText: "", version: note.version };
      // Password rotation requires an online acknowledgement. Body edits may use the existing
      // scoped offline queue, but only after verifying the exact ciphertext was really stored.
      const response = changePassword ? await api.updateNoteConfirmed(note.id, payload) : await saveEncryptedNoteCiphertext(note, payload.content, signal);
      const queued = Boolean((response as Note & { __offlineQueued?: boolean }).__offlineQueued);
      const updated = queued ? { ...note, ...payload, updatedAt: response.updatedAt } : response;
      readEncryptedNoteDocument(updated);
      if (!mounted.current || signal.aborted) return;
      if (changePassword) { password.current = newPassphrase; setNewPassphrase(""); setConfirmation(""); }
      setSavedBody(plaintext); setSession({ envelope, initialContent: session.initialContent });
      actions.setActiveNote(updated); actions.updateNoteInList({ id: updated.id, contentText: "", version: updated.version, updatedAt: updated.updatedAt });
      setStatus(queued ? "密文已保存到当前账号的离线队列，尚未由服务器确认" : "密文已由服务器确认保存");
    });
  }
  function lock(discard = false) {
    if (busy) return;
    if (dirty && !discard) { setError("请先保存，或选择放弃修改并锁定"); return; }
    password.current = ""; setSession(null); setBody(""); setSavedBody(""); setPassphrase(""); setNewPassphrase(""); setConfirmation(""); setError(""); setStatus("");
  }
  return <section className="flex min-w-0 flex-1 flex-col bg-app-bg" aria-label="加密笔记">
    <header className="flex items-center gap-2 border-b border-app-border p-3">
      <button type="button" aria-label="返回列表" onClick={() => { if (!dirty && !busy) { lock(); actions.setMobileView("list"); } else setError("请先保存或放弃修改"); }}><ChevronLeft size={20} /></button>
      <Lock size={16} /><h1 className="min-w-0 flex-1 truncate">{note.title}</h1>
      {session && <><Button disabled={!editable || busy || !dirty} onClick={() => void save()}>加密保存</Button><Button disabled={busy} onClick={() => lock()}>锁定</Button></>}
    </header>
    <p className="px-4 py-2 text-xs text-tx-secondary">实验性整篇文本加密：标题、目录、标签可见；不支持附件、分享、AI、协作或旧笔记转换。口令丢失无法恢复。</p>
    {native && <p role="alert" className="px-4 py-2">移动端参数尚未完成真机验收，请使用 Web 或桌面端解锁。</p>}
    {error && <p role="alert" className="px-4 py-2 text-red-500">{error}</p>}
    {status && <p role="status" className="px-4 py-2 text-tx-secondary">{status}</p>}
    {!session ? <form className="m-auto flex max-w-sm flex-col gap-3 p-6" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
      <label>解锁口令<input aria-label="解锁口令" type="password" autoComplete="off" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
      <Button type="submit" disabled={native || busy || !passphrase}>{busy ? "正在验证…" : "解锁"}</Button>
    </form> : <>
      {session.envelope.originalFormat === "markdown"
        ? <textarea aria-label="加密 Markdown 正文" value={body} readOnly={!editable || busy} onChange={(event) => setBody(event.target.value)} className="min-h-64 flex-1 resize-none bg-app-bg p-4 font-mono outline-none" spellCheck={false} />
        : <EncryptedNoteRichTextEditor initialContent={session.initialContent} editable={editable && !busy} onChange={setBody} />}
      {dirty && <Button disabled={busy} variant="ghost" onClick={() => lock(true)}>放弃修改并锁定</Button>}
      {editable && <details className="border-t border-app-border p-4"><summary>修改口令</summary><p className="my-2 text-xs">旧备份仍使用旧口令，此操作不撤销旧副本中的密钥。</p>
        <input aria-label="新口令" type="password" autoComplete="new-password" value={newPassphrase} disabled={busy} onChange={(event) => setNewPassphrase(event.target.value)} className="border border-app-border bg-app-bg p-2" />
        <input aria-label="确认新口令" type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="border border-app-border bg-app-bg p-2" />
        <Button disabled={busy || dirty || newPassphrase.length < 12 || newPassphrase !== confirmation} onClick={() => void save(true)}>确认改口令</Button>
      </details>}
    </>}
    {busy && <Button variant="ghost" disabled={submitting.current} onClick={() => { if (!submitting.current) operation.current?.abort(); }}>取消</Button>}
  </section>;
}
