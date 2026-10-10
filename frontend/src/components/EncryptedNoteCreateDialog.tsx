import { useTranslation } from "react-i18next";
import { hasStrongNewPassphrase } from "@/lib/encryptedNotes/passphrasePolicy";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Button } from "./ui/button";
import { api, getCurrentWorkspace } from "@/lib/api";
import { getOfflineQueueStorageKey } from "@/lib/offlineQueue";
import { useAppActions } from "@/store/AppContext";
import { runEncryptedContentOperation } from "@/lib/encryptedNotes/workerClient";
import { ENCRYPTED_NOTE_FORMAT } from "@/lib/encryptedNotes/noteDocument";
import type { EncryptedContentIdentity } from "@/lib/encryptedNotes/envelope";
import { useEncryptedAutoLock } from "@/lib/encryptedNotes/useAutoLock";

export default function EncryptedNoteCreateDialog({ parentId, onClose }: { parentId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const actions = useAppActions();
  const [title, setTitle] = useState(t("encryptedCreate.defaultTitle"));
  const [format, setFormat] = useState<EncryptedContentIdentity["originalFormat"]>("markdown");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const native = Capacitor.isNativePlatform();
  useEncryptedAutoLock(Boolean(passphrase || confirmation || busy), () => {
    operation.current?.abort("auto-lock"); setPassphrase(""); setConfirmation(""); onClose();
  });
  useEffect(() => {
    mounted.current = true;
    const scope = getOfflineQueueStorageKey();
    const close = () => { if (getOfflineQueueStorageKey() !== scope) { operation.current?.abort(); onClose(); } };
    window.addEventListener("nowen:token-changed", close);
    window.addEventListener("nowen:server-url-changed", close);
    return () => {
      mounted.current = false; operation.current?.abort();
      window.removeEventListener("nowen:token-changed", close);
      window.removeEventListener("nowen:server-url-changed", close);
    };
  }, []);
  async function create() {
    if (operation.current || native || !title.trim() || !hasStrongNewPassphrase(passphrase) || passphrase !== confirmation) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try {
      const envelope = await runEncryptedContentOperation({ operation: "create", input: {
        plaintext: format === "markdown" ? "" : JSON.stringify({ type: "doc", content: [] }),
        passphrase, kind: "note", originalFormat: format,
      } }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      const workspace = getCurrentWorkspace();
      const payload = { title: title.trim(), content: JSON.stringify(envelope), contentText: "", contentFormat: ENCRYPTED_NOTE_FORMAT, treeParentId: parentId, workspaceId: workspace === "personal" ? null : workspace };
      const note = await api.createNoteConfirmed(payload);
      if (!mounted.current || controller.signal.aborted) return;
      // Only ciphertext enters global state and the existing offline content cache.
      setPassphrase(""); setConfirmation("");
      actions.refreshNotes(); actions.refreshNotebooks(); actions.setActiveNote(note);
      actions.openNoteTab({ id: note.id, title: note.title, notebookId: note.notebookId, contentFormat: note.contentFormat, isLocked: note.isLocked, isTrashed: note.isTrashed, updatedAt: note.updatedAt });
      actions.setMobileView("editor");
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "encrypted-note-created", parentId } }));
      onClose();
    } catch {
      if (mounted.current && !controller.signal.aborted) setError(t("encryptedCreate.failure"));
    } finally { operation.current = null; if (mounted.current) setBusy(false); }
  }
  return createPortal(<div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4">
    <form role="dialog" aria-modal="true" aria-labelledby="encrypted-note-create-title" className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-app-border bg-app-bg p-5 shadow-xl" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <h2 id="encrypted-note-create-title">{t("encryptedCreate.title")}</h2>
      <p className="text-xs text-tx-secondary">{t("encryptedCreate.subtitle")}</p>
      {native && <p role="alert">{t("encryptedUi.nativeUnsupported")}</p>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <label>{t("encryptedCreate.titleLabel")}<input aria-label={t("encryptedCreate.ariaTitle")} value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
      <label>{t("encryptedCreate.format")}<select aria-label={t("encryptedCreate.ariaFormat")} value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as typeof format)} className="w-full rounded border border-app-border bg-app-bg p-2"><option value="markdown">Markdown</option><option value="tiptap-json">{t("encryptedCreate.richText")}</option></select></label>
      <label>{t("encryptedUi.passwordMin")}<input aria-label={t("encryptedUi.password")} type="password" autoComplete="new-password" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
      <label>{t("encryptedUi.confirmPassword")}<input aria-label={t("encryptedUi.confirmPassword")} type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("encryptedCreate.cancel")}</Button><Button type="submit" disabled={native || busy || !title.trim() || !hasStrongNewPassphrase(passphrase) || passphrase !== confirmation}>{busy ? t("encryptedCreate.creating") : t("encryptedCreate.create")}</Button></div>
    </form>
  </div>, document.body);
}
