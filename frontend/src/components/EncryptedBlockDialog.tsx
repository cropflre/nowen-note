import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Button } from "./ui/button";
import EncryptedNoteRichTextEditor from "./EncryptedNoteRichTextEditor";
import { runEncryptedContentOperation } from "@/lib/encryptedNotes/workerClient";
import { readEncryptedBlock } from "@/lib/encryptedNotes/blockDocument";
import { ENCRYPTED_NOTE_LEAVE_EVENT, validateEncryptedNotePlaintext } from "@/lib/encryptedNotes/noteDocument";
import { getOfflineQueueStorageKey } from "@/lib/offlineQueue";
import { useEncryptedAutoLock } from "@/lib/encryptedNotes/useAutoLock";

/** New and unlocked plaintext stays in this temporary editor. Selected text already existed in the ordinary document. */
export default function EncryptedBlockDialog({ source, initialContent, onCommit, onClose }: {
  source?: string; initialContent?: { plaintext: string; format: "markdown" | "tiptap-json" };
  onCommit?: (ciphertext: string) => void | Promise<void>; onClose: () => void;
}) {
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
  const native = Capacitor.isNativePlatform();
  let envelope: ReturnType<typeof readEncryptedBlock> | undefined;
  try { if (source) envelope = readEncryptedBlock(source); } catch { /* malformed input stays locked */ }
  envelope = draft || envelope;
  const isNew = !source && !draft;
  const format = envelope?.originalFormat || initialContent?.format || "markdown";
  const dirty = unlocked && (recoveredDraft || body !== initialBody);
  useEncryptedAutoLock(!securing && !lockFailed && Boolean(password || confirmation || body || busy || (unlocked && source)), () => { void autoLock(); });
  async function autoLock() {
    if (initialContent && !password && !draft) { onClose(); return; }
    const plaintext = body; const key = password; const current = envelope;
    const scope = getOfflineQueueStorageKey();
    operation.current?.abort("auto-lock");
    setBody(""); setInitialBody(""); setPassword(""); setConfirmation(""); setUnlocked(false); setError(""); setLockFailed(false);
    setStatus("已自动锁定，请重新输入密码。");
    if (!dirty && !(initialContent && key)) { if (!source && !draft) setUnlocked(true); return; }
    const controller = new AbortController(); operation.current = controller;
    setSecuring(true); setBusy(true); setStatus("正在锁定…");
    try {
      validateEncryptedNotePlaintext(plaintext, format);
      const encrypted = current
        ? await runEncryptedContentOperation({ operation: "update", input: { envelope: current, expected: current, passphrase: key, plaintext } }, controller.signal)
        : await runEncryptedContentOperation({ operation: "create", input: { kind: "block", originalFormat: format, passphrase: key, plaintext } }, controller.signal);
      if (!mounted.current || controller.signal.aborted || scope !== getOfflineQueueStorageKey()) return;
      setDraft(encrypted); setRecoveredDraft(false);
      setStatus("已自动锁定，重新解锁可恢复未保存的修改。关闭窗口会丢失这些修改。");
    } catch {
      if (!mounted.current || controller.signal.aborted || scope !== getOfflineQueueStorageKey()) return;
      setBody(plaintext); setInitialBody(format === "tiptap-json" ? plaintext : initialBody); setRecoveredDraft(true);
      setPassword(key); setConfirmation(confirmation); setUnlocked(unlocked); setLockFailed(true);
      setStatus(""); setError("自动锁定失败，修改仍保留，请保存或重试锁定。");
    } finally {
      if (operation.current === controller) { operation.current = null; if (mounted.current) { setBusy(false); setSecuring(false); } }
    }
  }
  function close() { if (!busy && (!(dirty || draft) || window.confirm("放弃未保存的修改？"))) onClose(); }
  useEffect(() => {
    const scope = getOfflineQueueStorageKey();
    const leave = (event: BeforeUnloadEvent) => { if (dirty || draft || busy) { event.preventDefault(); event.returnValue = ""; } };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    const account = () => { if (getOfflineQueueStorageKey() !== scope) { operation.current?.abort(); onClose(); } };
    const navigation = (event: Event) => { if (dirty || draft || busy) event.preventDefault(); else onClose(); };
    window.addEventListener("beforeunload", leave); window.addEventListener("keydown", escape);
    window.addEventListener("nowen:token-changed", account); window.addEventListener("nowen:server-url-changed", account);
    window.addEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, navigation);
    return () => { window.removeEventListener("beforeunload", leave); window.removeEventListener("keydown", escape);
      window.removeEventListener("nowen:token-changed", account); window.removeEventListener("nowen:server-url-changed", account); window.removeEventListener(ENCRYPTED_NOTE_LEAVE_EVENT, navigation); };
  }, [dirty, busy, draft]);
  // A separate mount-only cleanup avoids aborting an operation during an ordinary state update.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; operation.current?.abort(); }; }, []);
  async function perform(save: boolean) {
    if (busy || operation.current || native || (source && !envelope)) return;
    if (save && (!onCommit || !password || (isNew && (password.length < 6 || password !== confirmation)))) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); setError("");
    try {
      if (!save && envelope) {
        const plaintext = await runEncryptedContentOperation({ operation: "decrypt", input: { envelope, expected: envelope, passphrase: password } }, controller.signal);
        validateEncryptedNotePlaintext(plaintext, format);
        if (!mounted.current || controller.signal.aborted) return;
        setBody(plaintext); setInitialBody(plaintext); setUnlocked(true); setRecoveredDraft(Boolean(draft)); setLockFailed(false);
        if (draft) setStatus("已恢复修改，请保存。");
      } else {
        validateEncryptedNotePlaintext(body, format);
        const encrypted = envelope
          ? await runEncryptedContentOperation({ operation: "update", input: { envelope, expected: envelope, passphrase: password, plaintext: body } }, controller.signal)
          : await runEncryptedContentOperation({ operation: "create", input: { kind: "block", originalFormat: format, plaintext: body, passphrase: password } }, controller.signal);
        if (!mounted.current || controller.signal.aborted) return;
        await onCommit!(JSON.stringify(encrypted));
        if (mounted.current && !controller.signal.aborted) { setBody(""); setPassword(""); setConfirmation(""); onClose(); }
      }
    } catch { if (mounted.current && !controller.signal.aborted) setError("操作失败，请检查密码或重新打开内容后重试。原内容和当前修改已保留。"); }
    finally { if (operation.current === controller) { operation.current = null; if (mounted.current) setBusy(false); } }
  }
  return createPortal(<div className="fixed inset-0 z-[500] flex items-center justify-center bg-black/40 p-4">
    <section role="dialog" aria-modal="true" aria-label="局部加密区域" className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-auto rounded-xl border border-app-border bg-app-bg p-5 shadow-xl">
      <h2>{initialContent ? "加密选中文字" : !source ? "插入加密内容" : unlocked ? "编辑加密内容" : "解锁加密内容"}</h2>
      {!source && initialContent && <p className="text-xs text-tx-secondary">加密后，新保存的内容会受到保护。历史记录和旧备份中可能仍存在旧内容。</p>}
      <p className="text-xs text-tx-secondary">忘记密码将无法恢复内容。</p>
      {native && <p role="alert">移动应用暂不支持加密，请使用网页版或桌面端。</p>}
      {source && !envelope && <p role="alert">此内容暂时无法打开，请更新应用后重试。</p>}
      {error && <p role="alert" className="text-red-500">{error}</p>}
      {status && <p role="status">{status}</p>}
      {lockFailed && <Button disabled={busy} onClick={() => void autoLock()}>重试自动锁定</Button>}
      {(!unlocked || isNew) && <form id={passwordFormId} onSubmit={(event) => { event.preventDefault(); if (password) void perform(unlocked); }}>
        <label>{isNew ? "密码（至少 6 个字符）" : "密码"}<input aria-label="密码" type="password" autoComplete={isNew ? "new-password" : "off"} value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>
        {isNew && <label>确认密码<input aria-label="确认密码" type="password" autoComplete="new-password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} className="w-full rounded border border-app-border bg-app-bg p-2" /></label>}
      </form>}
      {unlocked && initialContent && isNew ? null : unlocked ? format === "markdown"
        ? <textarea aria-label="区域临时正文" value={body} readOnly={!onCommit || busy} onChange={(event) => setBody(event.target.value)} spellCheck={false} className="min-h-48 resize-y rounded border border-app-border bg-app-bg p-3 font-mono" />
        : <EncryptedNoteRichTextEditor initialContent={initialBody} editable={Boolean(onCommit) && !busy} onChange={setBody} />
        : <Button type="submit" form={passwordFormId} disabled={native || busy || !envelope || !password}>{busy ? "正在解锁…" : "解锁"}</Button>}
      <div className="flex gap-2">{unlocked && onCommit && <Button disabled={native || busy || !password || (isNew && (password.length < 6 || password !== confirmation))} onClick={() => void perform(true)}>{busy ? "正在加密…" : initialContent && isNew ? "加密" : "保存"}</Button>}
        <Button disabled={busy} variant="outline" onClick={close}>关闭</Button></div>
      {!onCommit && <p className="text-xs text-tx-secondary">当前笔记仅可查看。</p>}
    </section>
  </div>, document.body);
}
