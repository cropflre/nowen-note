import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Button } from "./ui/button";
import EncryptedNoteRichTextEditor from "./EncryptedNoteRichTextEditor";
import { runEncryptedContentOperation } from "@/lib/encryptedNotes/workerClient";
import { readEncryptedBlock } from "@/lib/encryptedNotes/blockDocument";
import { ENCRYPTED_NOTE_LEAVE_EVENT, validateEncryptedNotePlaintext } from "@/lib/encryptedNotes/noteDocument";
import { getOfflineQueueStorageKey } from "@/lib/offlineQueue";

/** Plaintext belongs only to this temporary editor, never the parent document or undo/Yjs history. */
export default function EncryptedBlockDialog({ source, onCommit, onClose }: {
  source?: string; onCommit?: (ciphertext: string) => void | Promise<void>; onClose: () => void;
}) {
  const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [body, setBody] = useState(""); const [initialBody, setInitialBody] = useState("");
  const [unlocked, setUnlocked] = useState(!source); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [accepted, setAccepted] = useState(false);
  const operation = useRef<AbortController | null>(null); const mounted = useRef(true);
  const native = Capacitor.isNativePlatform();
  let envelope: ReturnType<typeof readEncryptedBlock> | undefined;
  try { if (source) envelope = readEncryptedBlock(source); } catch { /* malformed input stays locked */ }
  const format = envelope?.originalFormat || "markdown";
  const dirty = unlocked && body !== initialBody;
  function close() { if (!busy && (!dirty || window.confirm("放弃尚未加密写回的修改并锁定？"))) onClose(); }
  useEffect(() => {
    const scope = getOfflineQueueStorageKey();
    const leave = (event: BeforeUnloadEvent) => { if (dirty || busy) { event.preventDefault(); event.returnValue = ""; } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    const account = () => { if (getOfflineQueueStorageKey() !== scope) { operation.current?.abort(); onClose(); } };
    const navigation = (event: Event) => { if (dirty || busy) event.preventDefault(); else onClose(); };
    window.addEventListener("beforeunload", leave); window.addEventListener("keydown", escape);
    window.addEventListener("nowen:token-changed", account); window.addEventListener("nowen:server-url-changed", account);
    window.addEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, navigation);
    return () => { window.removeEventListener("beforeunload", leave); window.removeEventListener("keydown", escape);
      window.removeEventListener("nowen:token-changed", account); window.removeEventListener("nowen:server-url-changed", account); window.removeEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, navigation); };
  }, [dirty, busy]);
  // A separate mount-only cleanup avoids aborting an operation during an ordinary state update.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);
  async function perform(save: boolean) {
    if (busy || operation.current || native || (source && !envelope)) return;
    if (save && (!onCommit || !password || (!source && (!accepted || password.length < 12 || password !== confirmation)))) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try {
      if (!save && envelope) {
        const plaintext = await runEncryptedContentOperation({ operation: "decrypt", input: { envelope, expected: envelope, passphrase: password } }, controller.signal);
        validateEncryptedNotePlaintext(plaintext, format);
        if (!mounted.current || controller.signal.aborted) return;
        setBody(plaintext); setInitialBody(plaintext); setUnlocked(true);
      } else {
        validateEncryptedNotePlaintext(body, format);
        const encrypted = envelope
          ? await runEncryptedContentOperation({ operation: "update", input: { envelope, expected: envelope, passphrase: password, plaintext: body } }, controller.signal)
          : await runEncryptedContentOperation({ operation: "create", input: { kind: "block", originalFormat: "markdown", plaintext: body, passphrase: password } }, controller.signal);
        if (!mounted.current || controller.signal.aborted) return;
        await onCommit!(JSON.stringify(encrypted));
        if (mounted.current && !controller.signal.aborted) { setBody(""); setPassword(""); setConfirmation(""); onClose(); }
      }
    } catch { if (mounted.current && !controller.signal.aborted) setError("操作未完成：请核对口令、加密能力及原区域是否已变化。原密文保持不变。"); }
    finally { operation.current = null; if (mounted.current) setBusy(false); }
  }
  return createPortal(<div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-label="局部加密区域" className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-auto rounded-xl border border-app-border bg-app-bg p-5 shadow-xl">
      <h2>局部加密区域（实验性）</h2>
      <p className="text-xs text-tx-secondary">此处正文仅在临时会话中解锁。加密写回后由笔记的保存流程保存；周围正文保持公开。口令丢失无法恢复。</p>
      {native && <p role="alert">移动端参数尚未真机验收，请使用 Web 或桌面端。</p>}
      {source && !envelope && <p role="alert">密文格式无效，不能解锁或覆盖。</p>}
      {error && <p role="alert" className="text-red-500">{error}</p>}
      <label>区域口令<input aria-label="区域口令" type="password" autoComplete="off" value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
      {!source && <><label>确认区域口令<input aria-label="确认区域口令" type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
        <label className="text-xs"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} disabled={busy} /> 我理解只保护在此新输入的内容，不清理已保存的明文、历史或旧备份。</label></>}
      {unlocked ? format === "markdown"
        ? <textarea aria-label="区域临时正文" value={body} readOnly={!onCommit || busy} onChange={(event) => setBody(event.target.value)} spellCheck={false} className="min-h-48 resize-y rounded border border-app-border bg-app-bg p-3 font-mono" />
        : <EncryptedNoteRichTextEditor initialContent={initialBody} editable={Boolean(onCommit) && !busy} onChange={setBody} />
        : <Button disabled={native || busy || !envelope || !password} onClick={() => void perform(false)}>解锁区域</Button>}
      <div className="flex gap-2">{unlocked && onCommit && <Button disabled={native || busy || !password || (!source && (!accepted || password.length < 12 || password !== confirmation))} onClick={() => void perform(true)}>{busy ? "正在加密…" : "加密写回"}</Button>}
        <Button disabled={busy} variant="outline" onClick={close}>关闭并锁定</Button></div>
      {!onCommit && <p className="text-xs text-tx-secondary">当前为只读查看。Markdown 修改时请在源码中选择该区域，再点击“加密区域”。</p>}
    </section>
  </div>, document.body);
}
