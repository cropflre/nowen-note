import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import type { Note } from "@/types";
import { Button } from "./ui/button";
import { useAppActions } from "@/store/AppContext";
import { getOfflineQueueStorageKey } from "@/lib/offlineScope";
import { checkNoteConversion, convertNote, cancelNoteConversion, NoteConversionError } from "@/lib/encryptedNotes/convertNote";
import { api } from "@/lib/api";
import { readPendingConversion } from "@/lib/encryptedNotes/conversionPending";
import { hasStrongNewPassphrase } from "@/lib/encryptedNotes/passphrasePolicy";
import { useEncryptedAutoLock } from "@/lib/encryptedNotes/useAutoLock";
import { ENCRYPTED_NOTE_LEAVE_EVENT } from "@/lib/encryptedNotes/noteDocument";

export default function EncryptedNoteConversionDialog({ noteId, note, onClose }: { noteId: string; note?: Note; onClose: () => void }) {
  const { t } = useTranslation(); const actions = useAppActions();
  const [ready, setReady] = useState(false); const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [passphrase, setPassphrase] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [consent, setConsent] = useState(false); const [revision, setRevision] = useState(0);
  const operation = useRef<AbortController | null>(null); const mounted = useRef(true);
  const panel = useRef<HTMLFormElement>(null); const close = useRef(onClose); close.current = onClose;
  let pending = false; let storageFailed = false;
  try { pending = Boolean(readPendingConversion(noteId)); } catch { storageFailed = true; }
  const report = (failure: unknown) => {
    const code = failure instanceof NoteConversionError && failure.blockers.length ? failure.blockers[0] : (failure as { code?: string })?.code;
    return t(`encryptedConversion.errors.${code}`, { defaultValue: t("encryptedConversion.failure") });
  };
  useEncryptedAutoLock(Boolean(passphrase || confirmation || busy), () => {
    operation.current?.abort("auto-lock"); setPassphrase(""); setConfirmation("");
  });
  useEffect(() => {
    mounted.current = true; const scope = getOfflineQueueStorageKey();
    const invalidate = () => { if (scope !== getOfflineQueueStorageKey()) { operation.current?.abort(); close.current(); } };
    const storage = (event: StorageEvent) => { if (event.key === null || event.key === "nowen-token" || event.key === "nowen-server-url") invalidate(); };
    const mustStay = () => { try { return Boolean(operation.current || readPendingConversion(noteId)); } catch { return true; } };
    const leave = (event: Event) => { if (mustStay()) event.preventDefault(); };
    const unload = (event: BeforeUnloadEvent) => { if (mustStay()) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("nowen:token-changed", invalidate); window.addEventListener("nowen:server-url-changed", invalidate); window.addEventListener("storage", storage);
    window.addEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, leave); window.addEventListener("beforeunload", unload);
    panel.current?.focus();
    return () => {
      mounted.current = false; operation.current?.abort();
      window.removeEventListener("nowen:token-changed", invalidate); window.removeEventListener("nowen:server-url-changed", invalidate); window.removeEventListener("storage", storage);
      window.removeEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, leave); window.removeEventListener("beforeunload", unload);
    };
  }, [noteId]);
  useEffect(() => {
    if (!note || pending || storageFailed) return;
    const controller = new AbortController(); operation.current = controller;
    setChecking(true); setReady(false); setError("");
    void checkNoteConversion(note, controller.signal).then(() => { if (!controller.signal.aborted) setReady(true); })
      .catch((failure) => { if (!controller.signal.aborted) setError(report(failure)); })
      .finally(() => { if (operation.current === controller) operation.current = null; if (!controller.signal.aborted) setChecking(false); });
    return () => { controller.abort(); if (operation.current === controller) operation.current = null; };
    // The pending event removes the captured plaintext prop during submission;
    // that must not cancel the conversion already in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, revision]);
  async function encrypt() {
    if (operation.current || storageFailed || Capacitor.isNativePlatform() || (!pending && (!ready || !consent || !hasStrongNewPassphrase(passphrase) || passphrase !== confirmation))) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try {
      const converted = await convertNote(noteId, passphrase, controller.signal, note);
      if (!mounted.current || controller.signal.aborted) return;
      setPassphrase(""); setConfirmation("");
      actions.refreshNotes(); actions.refreshNotebooks(); actions.setActiveNote(converted);
      actions.updateNoteTab({ id: converted.id, title: converted.title, contentFormat: converted.contentFormat, updatedAt: converted.updatedAt });
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "note-encrypted", noteId } }));
      close.current();
    } catch (failure) { if (mounted.current) setError(controller.signal.aborted ? t("encryptedConversion.interrupted") : report(failure)); }
    finally { if (operation.current === controller) operation.current = null; if (mounted.current) setBusy(false); }
  }
  async function cancelPending() {
    if (operation.current || !window.confirm(t("encryptedConversion.cancelWarning"))) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try {
      await cancelNoteConversion(noteId, controller.signal);
      const restored = await api.getNote(noteId);
      if (!mounted.current || controller.signal.aborted) return;
      actions.refreshNotes(); actions.setActiveNote(restored); close.current();
    } catch (failure) { if (mounted.current) setError(report(failure)); }
    finally { if (operation.current === controller) operation.current = null; if (mounted.current) setBusy(false); }
  }
  return createPortal(<div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4">
    <form ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="encrypt-existing-note-title" className="flex max-h-[85dvh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded-xl border border-app-border bg-app-bg p-5 shadow-xl"
      onSubmit={(event) => { event.preventDefault(); void encrypt(); }} onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); if (!busy && !pending) close.current(); }
        if (event.key === "Tab") {
          const controls = panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled)");
          if (!controls?.length) { event.preventDefault(); return; }
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <h2 id="encrypt-existing-note-title">{t("encryptedConversion.title")}</h2>
      <p className="text-sm text-tx-secondary">{t(pending ? "encryptedConversion.recovery" : "encryptedConversion.description")}</p>
      {checking && <p role="status">{t("encryptedConversion.checking")}</p>}
      {(error || storageFailed) && <p role="alert" className="text-sm text-red-500">{storageFailed ? t("encryptedConversion.errors.storage_failed") : error}</p>}
      {(ready || pending) && <>
        <label>{t("encryptedUi.passwordMin")}<input aria-label={t("encryptedUi.password")} type="password" autoComplete="new-password" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
        {!pending && <>
          <label>{t("encryptedUi.confirmPassword")}<input aria-label={t("encryptedUi.confirmPassword")} type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
          <p className="text-xs text-tx-secondary">{t("encryptedConversion.warning")}</p>
          <label className="flex gap-2 text-xs"><input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} />{t("encryptedConversion.consent")}</label>
        </>}
      </>}
      <div className="flex justify-end gap-2">
        {!pending && <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("encryptedCreate.cancel")}</Button>}
        {pending && <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancelPending()}>{t("encryptedConversion.cancelPending")}</Button>}
        {!ready && !pending && <Button type="button" disabled={checking} onClick={() => setRevision((value) => value + 1)}>{t("encryptedConversion.recheck")}</Button>}
        {(ready || pending) && <Button type="submit" disabled={busy || storageFailed || (!pending && (!consent || !hasStrongNewPassphrase(passphrase) || passphrase !== confirmation))}>{busy ? t("encryptedConversion.encrypting") : t(pending ? "encryptedConversion.retry" : "encryptedConversion.encrypt")}</Button>}
      </div>
    </form>
  </div>, document.body);
}
