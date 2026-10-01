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

export default function EncryptedNoteCreateDialog({ parentId, onClose }: { parentId: string | null; onClose: () => void }) {
  const actions = useAppActions();
  const [title, setTitle] = useState("加密笔记");
  const [format, setFormat] = useState<EncryptedContentIdentity["originalFormat"]>("markdown");
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const native = Capacitor.isNativePlatform();
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
    if (operation.current || native || !accepted || !title.trim() || passphrase.length < 12 || passphrase !== confirmation) return;
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
      if (mounted.current && !controller.signal.aborted) setError("创建未完成，请检查加密能力、口令长度或网络后重试");
    } finally { operation.current = null; if (mounted.current) setBusy(false); }
  }
  return createPortal(<div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4">
    <form role="dialog" aria-modal="true" aria-labelledby="encrypted-note-create-title" className="flex w-full max-w-md flex-col gap-3 rounded-xl border border-app-border bg-app-bg p-5 shadow-xl" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <h2 id="encrypted-note-create-title">新建加密文本笔记（实验性）</h2>
      <p className="text-xs text-tx-secondary">仅正文加密，标题、目录、标签仍可见；附件、分享、AI 与多人协作暂不支持。口令丢失无法恢复，旧备份不会因改口令而失效。</p>
      {native && <p role="alert">移动端参数尚未完成真机验收，请先使用 Web 或桌面端。</p>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
      <label>标题<input aria-label="加密笔记标题" value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
      <label>格式<select aria-label="加密笔记格式" value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as typeof format)} className="w-full rounded border border-app-border bg-app-bg p-2"><option value="markdown">Markdown</option><option value="tiptap-json">富文本（基础文字格式）</option></select></label>
      <label>口令（至少 12 个字符）<input aria-label="创建口令" type="password" autoComplete="new-password" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
      <label>确认口令<input aria-label="确认创建口令" type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
      <label className="text-xs"><input type="checkbox" checked={accepted} disabled={busy} onChange={(event) => setAccepted(event.target.checked)} /> 我理解口令丢失无法恢复，当前是 Web/桌面实验性文本加密，移动端参数仍待验收。</label>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>关闭</Button><Button type="submit" disabled={native || busy || !accepted || !title.trim() || passphrase.length < 12 || passphrase !== confirmation}>{busy ? "正在创建…" : "加密创建"}</Button></div>
    </form>
  </div>, document.body);
}
