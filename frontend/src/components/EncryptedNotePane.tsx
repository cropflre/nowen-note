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
import { useEncryptedAutoLock } from "@/lib/encryptedNotes/useAutoLock";

type Session = { envelope: EncryptedContentEnvelope; baseEnvelope: EncryptedContentEnvelope; initialContent: string };
const AUTOSAVE_DELAY_MS = 800;

export default function EncryptedNotePane({ note }: { note: Note }) {
  const actions = useAppActions();
  const [session, setSession] = useState<Session | null>(null);
  const [securing, setSecuring] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const password = useRef("");
  const operation = useRef<AbortController | null>(null);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const autosaveFailed = useRef(false);
  const locking = useRef(false);
  const mounted = useRef(true);
  // Keep these authoritative: a synchronous store render can precede queued state updates.
  const current = useRef({ session, body, savedBody });
  const currentNote = useRef(note);
  const lastNoteProp = useRef(note);
  if (lastNoteProp.current !== note) { currentNote.current = note; lastNoteProp.current = note; }
  const dirty = body !== savedBody;
  const editable = canWriteNote(note) && !note.isLocked && !note.isTrashed;
  const native = Capacitor.isNativePlatform();
  useEncryptedAutoLock(!securing && !lockFailed && Boolean(session || passphrase || newPassphrase || confirmation || busy), () => { void lock(false, true); });

  function clearSession() {
    password.current = "";
    current.current = { session: null, body: "", savedBody: "" };
    setSession(null); setBody(""); setSavedBody("");
    setPassphrase(""); setNewPassphrase(""); setConfirmation("");
  }
  function edit(content: string) {
    current.current.body = content; setBody(content);
    setStatus(content !== current.current.savedBody ? "正在保存…" : "已保存");
  }

  useEffect(() => {
    mounted.current = true;
    const scope = getOfflineQueueStorageKey();
    const hasPendingChanges = () => current.current.body !== current.current.savedBody || Boolean(operation.current) || locking.current;
    const beforeLeave = (event: Event) => {
      if (hasPendingChanges()) { event.preventDefault(); setError("请等待保存完成，或放弃修改后再离开"); }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => { if (hasPendingChanges()) { event.preventDefault(); event.returnValue = ""; } };
    const clear = () => {
      if (getOfflineQueueStorageKey() === scope) return;
      operation.current?.abort(); operation.current = null; pendingSave.current = null;
      locking.current = false; autosaveFailed.current = false;
      clearSession(); setBusy(false); setSaving(false); setSecuring(false); setLockFailed(false); setError(""); setStatus("");
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

  useEffect(() => {
    if (!session || !dirty || !editable || native || busy || securing || autosaveFailed.current) return;
    const timer = setTimeout(() => { void save(); }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [session, body, savedBody, editable, native, busy, securing]);

  async function execute(task: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
    if (operation.current) return false;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setStatus("");
    try { await task(controller.signal); return mounted.current && !controller.signal.aborted; }
    catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof EncryptedContentError && failure.code === "unlock-failed"
        ? "密码错误或内容损坏，原内容已保留"
        : "保存或解锁失败，原内容和当前修改已保留，请重试。");
      return false;
    } finally {
      if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(false); }
    }
  }
  async function unlock() {
    if (native || locking.current) return;
    const inputPassword = passphrase;
    await execute(async (signal) => {
      const envelope = readEncryptedNoteDocument(currentNote.current);
      const plaintext = await runEncryptedContentOperation({ operation: "decrypt", input: { envelope, expected: envelope, passphrase: inputPassword } }, signal);
      validateEncryptedNotePlaintext(plaintext, envelope.originalFormat);
      if (!mounted.current || signal.aborted) return;
      password.current = inputPassword; setPassphrase(""); autosaveFailed.current = false;
      const unlocked = { envelope, baseEnvelope: envelope, initialContent: plaintext };
      current.current = { session: unlocked, body: plaintext, savedBody: plaintext };
      setLockFailed(false); setBody(plaintext); setSavedBody(plaintext); setSession(unlocked);
    });
  }
  function save(changePassword = false): Promise<boolean> {
    if (pendingSave.current) return pendingSave.current;
    const { session: active, body: plaintext, savedBody: saved } = current.current;
    const baseNote = currentNote.current;
    if (!active || native || !canWriteNote(baseNote) || baseNote.isLocked || baseNote.isTrashed) return Promise.resolve(false);
    if (changePassword && getQueue().some((item) => item.noteId === baseNote.id)) { setError("请联网并等待同步完成后再修改密码。"); return Promise.resolve(false); }
    if (changePassword && (plaintext !== saved || newPassphrase.length < 6 || newPassphrase !== confirmation)) { setError("请先保存正文，并输入两次相同且至少 6 个字符的新密码"); return Promise.resolve(false); }
    if (!changePassword && plaintext === saved) return Promise.resolve(true);
    const key = password.current;
    const scope = getOfflineQueueStorageKey();
    setSaving(!changePassword); autosaveFailed.current = false;
    const task = execute(async (signal) => {
      // Refuse to overwrite ciphertext revalidated or changed by another device.
      if (JSON.stringify(readEncryptedNoteDocument(baseNote)) !== JSON.stringify(active.baseEnvelope)) throw new Error("Encrypted base changed");
      validateEncryptedNotePlaintext(plaintext, active.envelope.originalFormat);
      const envelope = changePassword
        ? await runEncryptedContentOperation({ operation: "change-passphrase", input: { envelope: active.envelope, expected: active.envelope, passphrase: key, newPassphrase } }, signal)
        : await runEncryptedContentOperation({ operation: "update", input: { envelope: active.envelope, expected: active.envelope, passphrase: key, plaintext } }, signal);
      if (!mounted.current || signal.aborted || scope !== getOfflineQueueStorageKey()) return;
      // Permissions/remote ciphertext may have changed while the Worker was running.
      const latestNote = currentNote.current;
      if (!canWriteNote(latestNote) || latestNote.isLocked || latestNote.isTrashed || latestNote.content !== baseNote.content || latestNote.version !== baseNote.version) throw new Error("Permissions or revision changed before write");
      const payload = { content: JSON.stringify(envelope), contentFormat: ENCRYPTED_NOTE_FORMAT, contentText: "", version: baseNote.version };
      const response = changePassword ? await api.updateNoteConfirmed(baseNote.id, payload) : await saveEncryptedNoteCiphertext(baseNote, payload.content, signal);
      const queued = Boolean((response as Note & { __offlineQueued?: boolean }).__offlineQueued);
      const updated = queued ? { ...baseNote, ...payload, updatedAt: response.updatedAt } : response;
      readEncryptedNoteDocument(updated);
      if (updated.content !== payload.content) throw new Error("Ciphertext not acknowledged");
      if (!mounted.current || signal.aborted || scope !== getOfflineQueueStorageKey()) return;
      if (currentNote.current.content !== baseNote.content || currentNote.current.version !== baseNote.version || !canWriteNote(currentNote.current) || currentNote.current.isLocked || currentNote.current.isTrashed) throw new Error("Ciphertext or permissions changed during save");
      if (changePassword) { password.current = newPassphrase; setNewPassphrase(""); setConfirmation(""); }
      const nextSession = { envelope, baseEnvelope: envelope, initialContent: active.initialContent };
      currentNote.current = updated;
      current.current.session = nextSession; current.current.savedBody = plaintext;
      setSavedBody(plaintext); setSession(nextSession); setLockFailed(false); setError("");
      actions.setActiveNote(updated); actions.updateNoteInList({ id: updated.id, contentText: "", version: updated.version, updatedAt: updated.updatedAt });
      setStatus(current.current.body !== plaintext ? "正在保存…" : "已保存");
    });
    setStatus("正在保存…");
    const result = task.then((success) => {
      if (pendingSave.current === result) {
        pendingSave.current = null; autosaveFailed.current = !success;
        if (mounted.current) { setSaving(false); if (!success) setStatus(""); }
      }
      return success;
    });
    pendingSave.current = result;
    return result;
  }
  async function lock(discard = false, automatic = false): Promise<boolean> {
    if (locking.current) return false;
    if (discard) {
      if (operation.current) return false;
      clearSession(); autosaveFailed.current = false; setLockFailed(false); setError(""); setStatus(""); return true;
    }
    const scope = getOfflineQueueStorageKey();
    locking.current = true; setSecuring(true); setLockFailed(false); setError("");
    setPassphrase(""); setNewPassphrase(""); setConfirmation("");
    // Cancel only an unlock. Never abort a submitted save or start a competing write.
    if (!current.current.session) operation.current?.abort();
    try {
      let saved = pendingSave.current ? await pendingSave.current : !(automatic && autosaveFailed.current && current.current.body !== current.current.savedBody);
      if (saved && current.current.body !== current.current.savedBody) saved = await save();
      if (!mounted.current || scope !== getOfflineQueueStorageKey()) return false;
      if (!saved) {
        autosaveFailed.current = true; setLockFailed(true); setStatus("");
        // Remount rich text from the latest draft, not its original unlock seed.
        const active = current.current.session;
        if (active) { const restored = { ...active, initialContent: current.current.body }; current.current.session = restored; setSession(restored); }
        setError("保存失败，锁定未完成；修改仍保留，请重试保存或锁定。"); return false;
      }
      clearSession(); autosaveFailed.current = false;
      setStatus(""); return true;
    } finally {
      if (mounted.current && scope === getOfflineQueueStorageKey()) { locking.current = false; setSecuring(false); }
    }
  }
  return <section className="flex min-w-0 flex-1 flex-col bg-app-bg" aria-label="加密笔记">
    <header className="flex items-center gap-2 border-b border-app-border p-3">
      <button type="button" aria-label="返回列表" disabled={securing} onClick={async () => { if (await lock()) actions.setMobileView("list"); }}><ChevronLeft size={20} /></button>
      <Lock size={16} /><h1 className="min-w-0 flex-1 truncate">{note.title}</h1>
      {session && <Button disabled={securing} onClick={() => void lock()}>锁定</Button>}
    </header>
    {native && <p role="alert" className="px-4 py-2">移动应用暂不支持加密，请使用网页版或桌面端。</p>}
    {error && <p role="alert" className="px-4 py-2 text-red-500">{error}</p>}
    {!securing && status && <p role="status" className="px-4 py-2 text-tx-secondary">{status}</p>}
    {securing ? <p role="status" className="m-auto p-6">正在锁定…</p> : !session ? <form className="m-auto flex w-full max-w-sm flex-col gap-3 p-6" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
      <Lock size={28} className="mx-auto text-tx-secondary" aria-hidden="true" />
      <h2 className="text-center text-lg font-medium">此笔记已加密</h2>
      <p className="text-center text-sm text-tx-secondary">输入密码查看内容</p>
      <input aria-label="密码" placeholder="输入密码" type="password" autoComplete="off" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" />
      <Button type="submit" disabled={native || busy || !passphrase}>{busy ? "正在验证…" : "解锁"}</Button>
      <p className="text-center text-xs text-tx-secondary">忘记密码将无法恢复内容。</p>
    </form> : <>
      {lockFailed && <Button disabled={busy} onClick={() => void lock()}>重试锁定</Button>}
      {session.envelope.originalFormat === "markdown"
        ? <textarea aria-label="加密 Markdown 正文" value={body} readOnly={!editable || (busy && !saving)} onChange={(event) => edit(event.target.value)} className="min-h-64 flex-1 resize-none bg-app-bg p-4 font-mono outline-none" spellCheck={false} />
        : <EncryptedNoteRichTextEditor initialContent={session.initialContent} editable={editable && (!busy || saving)} onChange={edit} />}
      {error && dirty && <div className="flex gap-2 p-3">
        <Button disabled={!editable || busy} onClick={() => void save()}>重试保存</Button>
        <Button disabled={busy} variant="ghost" onClick={() => void lock(true)}>放弃修改并锁定</Button>
      </div>}
      {editable && <details className="border-t border-app-border p-4"><summary>修改密码</summary><p className="my-2 text-xs">以前的备份仍需使用当时的密码解锁。</p>
        <input aria-label="新密码" type="password" autoComplete="new-password" value={newPassphrase} disabled={busy} onChange={(event) => setNewPassphrase(event.target.value)} className="border border-app-border bg-app-bg p-2" />
        <input aria-label="确认新密码" type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="border border-app-border bg-app-bg p-2" />
        <Button disabled={busy || dirty || newPassphrase.length < 6 || newPassphrase !== confirmation} onClick={() => void save(true)}>确认修改</Button>
      </details>}
    </>}
  </section>;
}
