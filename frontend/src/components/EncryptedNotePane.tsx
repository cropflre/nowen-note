import { useTranslation } from "react-i18next";
import { hasStrongNewPassphrase } from "@/lib/encryptedNotes/passphrasePolicy";
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
import { EncryptedContentSession } from "@/lib/encryptedNotes/sessionClient";
import { EncryptedContentError, type EncryptedContentEnvelope } from "@/lib/encryptedNotes/envelope";
import { ENCRYPTED_NOTE_FORMAT, ENCRYPTED_NOTE_LEAVE_EVENT, readEncryptedNoteDocument, validateEncryptedNotePlaintext } from "@/lib/encryptedNotes/noteDocument";
import { useEncryptedAutoLock } from "@/lib/encryptedNotes/useAutoLock";

type Session = { envelope: EncryptedContentEnvelope; baseEnvelope: EncryptedContentEnvelope; initialContent: string };
const AUTOSAVE_DELAY_MS = 800;

export default function EncryptedNotePane({ note }: { note: Note }) {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [session, setSession] = useState<Session | null>(null);
  const [securing, setSecuring] = useState(false);
  const [lockFailed, setLockFailed] = useState(false);
  const [body, setBody] = useState("");
  const [savedBody, setSavedBody] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [newPassphrase, setNewPassphrase] = useState("");
  const [currentPassphrase, setCurrentPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const cryptoSession = useRef<EncryptedContentSession | null>(null);
  const confirmedStatus = useRef("");
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
  useEncryptedAutoLock(!securing && Boolean((!lockFailed && session) || passphrase || currentPassphrase || newPassphrase || confirmation || busy), () => {
    if (lockFailed) { setPassphrase(""); return; }
    void lock(false, true);
  });

  function clearSession() {
    cryptoSession.current?.close(); cryptoSession.current = null;
    current.current = { session: null, body: "", savedBody: "" };
    setSession(null); setBody(""); setSavedBody("");
    setPassphrase(""); setCurrentPassphrase(""); setNewPassphrase(""); setConfirmation("");
  }
  function edit(content: string) {
    current.current.body = content; setBody(content);
    setStatus(content !== current.current.savedBody ? t("encryptedNote.saving") : confirmedStatus.current);
  }

  useEffect(() => {
    mounted.current = true;
    const scope = getOfflineQueueStorageKey();
    const hasPendingChanges = () => current.current.body !== current.current.savedBody || Boolean(operation.current) || locking.current;
    const beforeLeave = (event: Event) => {
      if (hasPendingChanges()) { event.preventDefault(); setError(t("encryptedNote.leaveBlocked")); }
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
      mounted.current = false; operation.current?.abort(); cryptoSession.current?.close(); cryptoSession.current = null;
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
        ? t("encryptedNote.incorrectPassword")
        : t("encryptedNote.operationFailed"));
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
      const recovery = lockFailed ? current.current : null;
      if (recovery?.session && JSON.stringify(recovery.session.baseEnvelope) !== JSON.stringify(envelope)) throw new Error("Recovery base changed");
      cryptoSession.current?.close();
      const opened = new EncryptedContentSession(); cryptoSession.current = opened;
      let plaintext: string;
      try {
        plaintext = await opened.open(envelope, inputPassword, envelope, signal);
        validateEncryptedNotePlaintext(plaintext, envelope.originalFormat);
        if (!mounted.current || signal.aborted) { opened.close(); return; }
      } catch (error) {
        opened.close(); if (cryptoSession.current === opened) cryptoSession.current = null;
        throw error;
      }
      setPassphrase(""); autosaveFailed.current = Boolean(recovery);
      const restoredBody = recovery?.body ?? plaintext;
      const restoredSavedBody = recovery?.savedBody ?? plaintext;
      const unlocked = { envelope, baseEnvelope: envelope, initialContent: restoredBody };
      current.current = { session: unlocked, body: restoredBody, savedBody: restoredSavedBody };
      setLockFailed(false); setBody(restoredBody); setSavedBody(restoredSavedBody); setSession(unlocked);
      if (recovery) setError(t("encryptedNote.recovered"));
    });
  }
  function save(changePassword = false): Promise<boolean> {
    if (pendingSave.current) return pendingSave.current;
    const { session: active, body: plaintext, savedBody: saved } = current.current;
    const baseNote = currentNote.current;
    if (!active || native || !canWriteNote(baseNote) || baseNote.isLocked || baseNote.isTrashed) return Promise.resolve(false);
    if (changePassword && getQueue().some((item) => item.noteId === baseNote.id)) { setError(t("encryptedNote.waitForSync")); return Promise.resolve(false); }
    if (changePassword && (plaintext !== saved || !currentPassphrase || !hasStrongNewPassphrase(newPassphrase) || newPassphrase !== confirmation)) { setError(t("encryptedNote.changePasswordPrerequisites")); return Promise.resolve(false); }
    if (!changePassword && plaintext === saved) return Promise.resolve(true);
    const keySession = cryptoSession.current;
    if (!keySession) return Promise.resolve(false);
    const scope = getOfflineQueueStorageKey();
    setSaving(!changePassword); autosaveFailed.current = false;
    const task = execute(async (signal) => {
      // Refuse to overwrite ciphertext revalidated or changed by another device.
      if (JSON.stringify(readEncryptedNoteDocument(baseNote)) !== JSON.stringify(active.baseEnvelope)) throw new Error("Encrypted base changed");
      validateEncryptedNotePlaintext(plaintext, active.envelope.originalFormat);
      const envelope = changePassword
        ? await keySession.changePassphrase(active.envelope, currentPassphrase, newPassphrase, signal)
        : await keySession.update(active.envelope, plaintext, signal);
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
      if (changePassword) { setCurrentPassphrase(""); setNewPassphrase(""); setConfirmation(""); }
      const nextSession = { envelope, baseEnvelope: envelope, initialContent: active.initialContent };
      currentNote.current = updated;
      current.current.session = nextSession; current.current.savedBody = plaintext;
      setSavedBody(plaintext); setSession(nextSession); setLockFailed(false); setError("");
      actions.setActiveNote(updated); actions.updateNoteInList({ id: updated.id, contentText: "", version: updated.version, updatedAt: updated.updatedAt });
      confirmedStatus.current = queued ? t("encryptedNote.savedLocally") : t("encryptedNote.saved");
      setStatus(current.current.body !== plaintext ? t("encryptedNote.saving") : confirmedStatus.current);
    });
    setStatus(t("encryptedNote.saving"));
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
    setPassphrase(""); setCurrentPassphrase(""); setNewPassphrase(""); setConfirmation("");
    // Cancel only an unlock. Never abort a submitted save or start a competing write.
    if (!current.current.session) operation.current?.abort();
    try {
      let saved = pendingSave.current ? await pendingSave.current : !(automatic && autosaveFailed.current && current.current.body !== current.current.savedBody);
      if (saved && current.current.body !== current.current.savedBody) saved = await save();
      if (!mounted.current || scope !== getOfflineQueueStorageKey()) return false;
      if (!saved) {
        autosaveFailed.current = true; setLockFailed(true); setStatus("");
        cryptoSession.current?.close(); cryptoSession.current = null;
        setError(t("encryptedNote.lockFailed")); return false;
      }
      clearSession(); autosaveFailed.current = false;
      setStatus(""); return true;
    } finally {
      if (mounted.current && scope === getOfflineQueueStorageKey()) { locking.current = false; setSecuring(false); }
    }
  }
  return <section className="flex min-w-0 flex-1 flex-col bg-app-bg" aria-label={t("encryptedNote.ariaNote")}>
    <header className="flex items-center gap-2 border-b border-app-border p-3">
      <button type="button" aria-label={t("encryptedNote.backToList")} disabled={securing} onClick={async () => { if (await lock()) actions.setMobileView("list"); }}><ChevronLeft size={20} /></button>
      <Lock size={16} /><h1 className="min-w-0 flex-1 truncate">{note.title}</h1>
      {session && !lockFailed && <Button disabled={securing} onClick={() => void lock()}>{t("encryptedUi.lock")}</Button>}
    </header>
    {native && <p role="alert" className="px-4 py-2">{t("encryptedUi.nativeUnsupported")}</p>}
    {error && <p role="alert" className="px-4 py-2 text-red-500">{error}</p>}
    {!securing && status && <p role="status" className="px-4 py-2 text-tx-secondary">{status}</p>}
    {securing ? <p role="status" className="m-auto p-6">{t("encryptedUi.locking")}</p> : !session || lockFailed ? <form className="m-auto flex w-full max-w-sm flex-col gap-3 p-6" onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
      <Lock size={28} className="mx-auto text-tx-secondary" aria-hidden="true" />
      <h2 className="text-center text-lg font-medium">{t("encryptedNote.lockedTitle")}</h2>
      <p className="text-center text-sm text-tx-secondary">{t("encryptedNote.enterPassword")}</p>
      <input aria-label={t("encryptedUi.password")} placeholder={t("encryptedNote.passwordPlaceholder")} type="password" autoComplete="off" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" />
      <Button type="submit" disabled={native || busy || !passphrase}>{busy ? t("encryptedNote.verifying") : t("encryptedUi.unlock")}</Button>
      {lockFailed && <Button disabled={busy} type="button" variant="ghost" onClick={() => { if (window.confirm(t("encryptedUi.discardConfirm"))) void lock(true); }}>{t("encryptedNote.discardAndLock")}</Button>}
      <p className="text-center text-xs text-tx-secondary">{t("encryptedUi.forgotPassword")}</p>
    </form> : <>
      {session.envelope.originalFormat === "markdown"
        ? <textarea aria-label={t("encryptedNote.markdownBody")} value={body} readOnly={!editable || (busy && !saving)} onChange={(event) => edit(event.target.value)} className="min-h-64 flex-1 resize-none bg-app-bg p-4 font-mono outline-none" spellCheck={false} />
        : <EncryptedNoteRichTextEditor initialContent={session.initialContent} editable={editable && (!busy || saving)} onChange={edit} />}
      {error && dirty && <div className="flex gap-2 p-3">
        <Button disabled={!editable || busy} onClick={() => void save()}>{t("encryptedNote.retrySave")}</Button>
        <Button disabled={busy} variant="ghost" onClick={() => void lock(true)}>{t("encryptedNote.discardAndLock")}</Button>
      </div>}
      {editable && <details className="border-t border-app-border p-4"><summary>{t("encryptedNote.changePassword")}</summary><p className="my-2 text-xs">{t("encryptedNote.oldBackupHint")}</p>
        <input aria-label={t("encryptedNote.currentPassword")} type="password" autoComplete="off" value={currentPassphrase} disabled={busy} onChange={(event) => setCurrentPassphrase(event.target.value)} className="border border-app-border bg-app-bg p-2" />
        <input aria-label={t("encryptedNote.newPassword")} type="password" autoComplete="new-password" value={newPassphrase} disabled={busy} onChange={(event) => setNewPassphrase(event.target.value)} className="border border-app-border bg-app-bg p-2" />
        <input aria-label={t("encryptedNote.confirmNewPassword")} type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="border border-app-border bg-app-bg p-2" />
        <Button disabled={busy || dirty || !currentPassphrase || !hasStrongNewPassphrase(newPassphrase) || newPassphrase !== confirmation} onClick={() => void save(true)}>{t("encryptedNote.confirmChange")}</Button>
      </details>}
    </>}
  </section>;
}
