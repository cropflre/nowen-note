import { useTranslation } from "react-i18next";
import { hasStrongNewPassphrase } from "@/lib/encryptedNotes/passphrasePolicy";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Button } from "./ui/button";
import EncryptedNoteRichTextEditor from "./EncryptedNoteRichTextEditor";
import { runEncryptedContentOperation } from "@/lib/encryptedNotes/workerClient";
import { EncryptedContentSession } from "@/lib/encryptedNotes/sessionClient";
import { readEncryptedBlock } from "@/lib/encryptedNotes/blockDocument";
import { ENCRYPTED_NOTE_LEAVE_EVENT, validateEncryptedNotePlaintext } from "@/lib/encryptedNotes/noteDocument";
import { getOfflineQueueStorageKey } from "@/lib/offlineQueue";
import { useEncryptedAutoLock } from "@/lib/encryptedNotes/useAutoLock";

/** New and unlocked plaintext stays in this temporary editor. Selected text already existed in the ordinary document. */
export default function EncryptedBlockDialog({ source, initialContent, onCommit, onClose }: {
  source?: string; initialContent?: { plaintext: string; format: "markdown" | "tiptap-json" };
  onCommit?: (ciphertext: string) => void | Promise<void>; onClose: () => void;
}) {
  const { t } = useTranslation();
  const passwordFormId = useId();
  const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [body, setBody] = useState(initialContent?.plaintext || ""); const [initialBody, setInitialBody] = useState(initialContent?.plaintext || "");
  const [unlocked, setUnlocked] = useState(!source); const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ReturnType<typeof readEncryptedBlock> | null>(null);
  const [recoveredDraft, setRecoveredDraft] = useState(false);
  const [securing, setSecuring] = useState(false); const [lockFailed, setLockFailed] = useState(false);
  const [status, setStatus] = useState("");
  const operation = useRef<AbortController | null>(null); const mounted = useRef(true);
  const cryptoSession = useRef<EncryptedContentSession | null>(null);
  const recovery = useRef<{ plaintext: string; passphrase?: string; base?: string } | null>(null);
  const native = Capacitor.isNativePlatform();
  let envelope: ReturnType<typeof readEncryptedBlock> | undefined;
  try { if (source) envelope = readEncryptedBlock(source); } catch { /* malformed input stays locked */ }
  envelope = draft || envelope;
  const isNew = !source && !draft;
  const format = envelope?.originalFormat || initialContent?.format || "markdown";
  const dirty = unlocked && (recoveredDraft || body !== initialBody);
  useEncryptedAutoLock(!securing && Boolean(password || confirmation || (!lockFailed && (body || busy || (unlocked && source)))), () => { void autoLock(); });
  async function autoLock() {
    if (lockFailed) { setPassword(""); setConfirmation(""); return; }
    if (initialContent && !password && !draft) { onClose(); return; }
    const plaintext = body; const key = password; const current = envelope;
    const activeSession = cryptoSession.current;
    const scope = getOfflineQueueStorageKey();
    operation.current?.abort("auto-lock");
    setBody(""); setInitialBody(""); setPassword(""); setConfirmation(""); setUnlocked(false); setError(""); setLockFailed(false);
    setStatus(t("encryptedBlock.autoLocked"));
    if (!dirty && !(initialContent && key)) { activeSession?.close(); cryptoSession.current = null; if (!source && !draft) setUnlocked(true); return; }
    const controller = new AbortController(); operation.current = controller;
    setSecuring(true); setBusy(true); setStatus(t("encryptedBlock.autoLocking"));
    try {
      validateEncryptedNotePlaintext(plaintext, format);
      const encrypted = current
        ? await activeSession!.update(current, plaintext, controller.signal)
        : await runEncryptedContentOperation({ operation: "create", input: { kind: "block", originalFormat: format, passphrase: key, plaintext } }, controller.signal);
      if (!mounted.current || controller.signal.aborted || scope !== getOfflineQueueStorageKey()) return;
      setDraft(encrypted); setRecoveredDraft(false);
      setStatus(t("encryptedBlock.autoLockedDraft"));
    } catch {
      if (!mounted.current || controller.signal.aborted || scope !== getOfflineQueueStorageKey()) return;
      recovery.current = { plaintext, ...(current ? { base: JSON.stringify(current) } : { passphrase: key }) };
      setRecoveredDraft(true); setLockFailed(true);
      setStatus(""); setError(t("encryptedBlock.autoLockFailed"));
    } finally {
      activeSession?.close(); cryptoSession.current = null;
      if (operation.current === controller) { operation.current = null; if (mounted.current) { setBusy(false); setSecuring(false); } }
    }
  }
  function close() { if (!busy && (!(dirty || draft || lockFailed) || window.confirm(t("encryptedUi.discardConfirm")))) onClose(); }
  useEffect(() => {
    const scope = getOfflineQueueStorageKey();
    const leave = (event: BeforeUnloadEvent) => { if (dirty || draft || busy || lockFailed) { event.preventDefault(); event.returnValue = ""; } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    const account = () => { if (getOfflineQueueStorageKey() !== scope) { operation.current?.abort(); cryptoSession.current?.close(); cryptoSession.current = null; recovery.current = null; onClose(); } };
    const navigation = (event: Event) => { if (dirty || draft || busy || lockFailed) event.preventDefault(); else onClose(); };
    window.addEventListener("beforeunload", leave); window.addEventListener("keydown", escape);
    window.addEventListener("nowen:token-changed", account); window.addEventListener("nowen:server-url-changed", account);
    window.addEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, navigation);
    return () => { window.removeEventListener("beforeunload", leave); window.removeEventListener("keydown", escape);
      window.removeEventListener("nowen:token-changed", account); window.removeEventListener("nowen:server-url-changed", account); window.removeEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, navigation); };
  }, [dirty, busy, draft, lockFailed]);
  // A separate mount-only cleanup avoids aborting an operation during an ordinary state update.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); cryptoSession.current?.close(); cryptoSession.current = null; recovery.current = null; }; }, []);
  async function perform(save: boolean) {
    if (busy || operation.current || native || (source && !envelope)) return;
    if (save && (!onCommit || (isNew ? !hasStrongNewPassphrase(password) || password !== confirmation : !cryptoSession.current))) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try {
      if (!save && (envelope || recovery.current)) {
        const pending = recovery.current;
        if (!envelope && pending?.passphrase !== password) throw new Error("Recovery authentication failed");
        if (pending?.base && pending.base !== JSON.stringify(envelope)) throw new Error("Recovery base changed");
        let decoded: string;
        if (envelope) {
          cryptoSession.current?.close();
          const opened = new EncryptedContentSession(); cryptoSession.current = opened;
          try { decoded = await opened.open(envelope, password, envelope, controller.signal); }
          catch (error) { opened.close(); cryptoSession.current = null; throw error; }
        } else decoded = pending!.plaintext;
        const plaintext = pending?.plaintext ?? decoded;
        validateEncryptedNotePlaintext(plaintext, format);
        if (!mounted.current || controller.signal.aborted) return;
        recovery.current = null;
        if (envelope) setPassword("");
        setBody(plaintext); setInitialBody(plaintext); setUnlocked(true); setRecoveredDraft(Boolean(draft || pending)); setLockFailed(false);
        if (draft || pending) setStatus(t("encryptedBlock.recovered"));
      } else {
        validateEncryptedNotePlaintext(body, format);
        const encrypted = envelope
          ? await cryptoSession.current!.update(envelope, body, controller.signal)
          : await runEncryptedContentOperation({ operation: "create", input: { kind: "block", originalFormat: format, plaintext: body, passphrase: password } }, controller.signal);
        if (!mounted.current || controller.signal.aborted) return;
        await onCommit!(JSON.stringify(encrypted));
        if (mounted.current && !controller.signal.aborted) {
          cryptoSession.current?.close(); cryptoSession.current = null;
          setBody(""); setPassword(""); setConfirmation(""); onClose();
        }
      }
    } catch {
      if (!save) { cryptoSession.current?.close(); cryptoSession.current = null; }
      if (mounted.current && !controller.signal.aborted) setError(t("encryptedBlock.operationFailed"));
    }
    finally { if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(false); } }
  }
  return createPortal(<div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-label={t("encryptedBlock.ariaDialog")} className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-auto rounded-xl border border-app-border bg-app-bg p-5 shadow-xl">
      <h2>{initialContent ? t("encryptedBlock.selectedText") : !source ? t("encryptedBlock.insert") : unlocked ? t("encryptedBlock.edit") : t("encryptedBlock.unlockContent")}</h2>
      {!source && initialContent && <p className="text-xs text-tx-secondary">{t("encryptedBlock.historyHint")}</p>}
      <p className="text-xs text-tx-secondary">{t("encryptedUi.forgotPassword")}</p>
      {native && <p role="alert">{t("encryptedUi.nativeUnsupported")}</p>}
      {source && !envelope && <p role="alert">{t("encryptedBlock.unsupportedContent")}</p>}
      {error && <p role="alert" className="text-red-500">{error}</p>}
      {status && <p role="status">{status}</p>}
      {(!unlocked || isNew) && <form id={passwordFormId} onSubmit={(event) => { event.preventDefault(); if (password) void perform(unlocked); }}>
        <label>{isNew ? t("encryptedUi.passwordMin") : t("encryptedUi.password")}<input aria-label={t("encryptedUi.password")} type="password" autoComplete={isNew ? "new-password" : "off"} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
        {isNew && !lockFailed && <label>{t("encryptedUi.confirmPassword")}<input aria-label={t("encryptedUi.confirmPassword")} type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>}
      </form>}
      {unlocked && initialContent && isNew ? null : unlocked ? format === "markdown"
        ? <textarea aria-label={t("encryptedBlock.temporaryBody")} value={body} readOnly={!onCommit || busy} onChange={(event) => setBody(event.target.value)} spellCheck={false} className="min-h-48 resize-y rounded border border-app-border bg-app-bg p-3 font-mono" />
        : <EncryptedNoteRichTextEditor initialContent={initialBody} editable={Boolean(onCommit) && !busy} onChange={setBody} />
        : <Button type="submit" form={passwordFormId} disabled={native || busy || (!envelope && !lockFailed) || !password}>{busy ? t("encryptedUi.unlocking") : t("encryptedUi.unlock")}</Button>}
      <div className="flex gap-2">{unlocked && onCommit && <Button disabled={native || busy || (isNew ? !hasStrongNewPassphrase(password) || password !== confirmation : !cryptoSession.current)} onClick={() => void perform(true)}>{busy ? t("encryptedBlock.encrypting") : initialContent && isNew ? t("encryptedBlock.encrypt") : t("encryptedUi.save")}</Button>}
        <Button disabled={busy} variant="outline" onClick={close}>{t("encryptedUi.close")}</Button></div>
      {!onCommit && <p className="text-xs text-tx-secondary">{t("encryptedUi.readOnly")}</p>}
    </section>
  </div>, document.body);
}
