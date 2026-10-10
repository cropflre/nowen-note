import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, Minus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { VoiceRecorderSession, recordedVoiceFile, formatVoiceDuration, type RecordedVoice, type VoiceRecorderState } from "@/lib/voiceRecorder";
import { voiceRecordingExtension } from "@/lib/voiceRecordingMime";
import { createVoiceMemoDraft, voiceMemoDraftStore, type VoiceMemoDraft } from "@/lib/voiceMemoDraftStore";
import { voiceMemoScope, type VoiceMemoRequest } from "@/lib/voiceMemo";

export default function VoiceRecorderSheet() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<VoiceRecorderState>("idle");
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<VoiceMemoDraft[]>([]);
  const [current, setCurrent] = useState<VoiceMemoDraft | null>(null);
  const requestRef = useRef<VoiceMemoRequest | null>(null);
  const sessionRef = useRef<VoiceRecorderSession | null>(null);
  const scopeRef = useRef("");
  const draftRef = useRef<VoiceMemoDraft | null>(null);
  const busyRef = useRef(false);
  const persistedRef = useRef(true);
  const downloadedRef = useRef(false);
  const refreshDrafts = useCallback(async () => {
    const scope = voiceMemoScope();
    const drafts = scope ? await voiceMemoDraftStore.list(scope).catch(() => []) : [];
    if (scope === voiceMemoScope()) setDrafts(drafts);
  }, []);
  const setDraft = useCallback((draft: VoiceMemoDraft | null) => { draftRef.current = draft; setCurrent(draft); }, []);
  const close = useCallback(() => {
    if (draftRef.current && !persistedRef.current && !downloadedRef.current) { toast.error(t("voice.localFailed")); return; }
    requestRef.current?.release?.(); requestRef.current = null;
    sessionRef.current = null; setDraft(null); setState("idle"); setVisible(false); setError("");
    void refreshDrafts();
  }, [refreshDrafts, setDraft, t]);

  const upload = async (draft: VoiceMemoDraft) => {
    if (busyRef.current) return;
    scopeRef.current = draft.scope;
    busyRef.current = true; setError(""); setDraft(draft);
    try {
      // 先持久化，再执行网络操作；配额不足时保留内存数据并提供下载。
      persistedRef.current = false;
      try { await voiceMemoDraftStore.put(draft); persistedRef.current = true; } catch { throw new Error(t("voice.localFailed")); }
      if (draft.scope !== voiceMemoScope()) throw new Error(t("voice.localSaved"));
      setState("uploading");
      const note = await api.getNote(draft.noteId);
      if (note.isTrashed) throw new Error(t("voice.noteUnavailable"));
      if (draft.scope !== voiceMemoScope()) throw new Error(t("voice.localSaved"));
      let attachment = draft.attachment ? { ...draft.attachment, src: `/api/attachments/${draft.attachment.attachmentId}` } : undefined;
      if (!attachment) {
        const file = recordedVoiceFile({ blob: draft.blob, mimeType: draft.mimeType, extension: voiceRecordingExtension(draft.mimeType), durationMs: draft.durationMs, size: draft.blob.size }, draft.createdAt);
        const result = await api.attachments.upload(draft.noteId, file);
        if (result.size !== file.size) throw new Error(t("voice.uploadIncomplete"));
        attachment = { attachmentId: result.id, src: `/api/attachments/${result.id}`, filename: result.filename, mimeType: result.mimeType, size: result.size, durationMs: draft.durationMs };
        draft = { ...draft, attachment };
        setDraft(draft);
        await voiceMemoDraftStore.put(draft);
      }
      // 账号、笔记或编辑器已经切换时，保留原笔记附件，绝不调用错误编辑器。
      const inserted = draft.scope === voiceMemoScope() && requestRef.current?.noteId === draft.noteId && requestRef.current.insert(attachment);
      if (inserted) {
        await voiceMemoDraftStore.remove(draft.id);
        toast.success(t("voice.saved")); close();
      } else { setState("saved"); setError(t("voice.savedOriginal")); }
      await refreshDrafts();
    } catch (failure) {
      const failedDraft = { ...draft, status: "upload-failed" as const };
      setDraft(failedDraft);
      await voiceMemoDraftStore.put(failedDraft).then(() => { persistedRef.current = true; }).catch(() => undefined);
      setState("error"); setError(`${(failure as Error).message}\n${t(persistedRef.current ? "voice.localSaved" : "voice.localFailed")}`);
      await refreshDrafts();
    } finally {
      busyRef.current = false;
      if (draft.scope !== voiceMemoScope() && persistedRef.current) close();
    }
  };
  const recorded = (voice: RecordedVoice) => {
    const request = requestRef.current;
    if (!request) return;
    const draft = createVoiceMemoDraft(scopeRef.current, request.noteId, voice);
    downloadedRef.current = false;
    void upload(draft);
  };
  const start = async () => {
    if (!requestRef.current || busyRef.current) return;
    setError(""); scopeRef.current = voiceMemoScope();
    const session = new VoiceRecorderSession(setState, recorded);
    sessionRef.current = session;
    try { await session.start(); } catch (failure) {
      const error = failure as Error;
      setError(t(error.name === "NotAllowedError" || error.name === "SecurityError" ? "voice.denied" : error.name === "NotFoundError" ? "voice.noDevice" : error.message.startsWith("voice.") ? error.message : "voice.error"));
    }
  };
  const finish = async () => {
    try { const voice = await sessionRef.current?.stop(); if (voice) recorded(voice); } catch (failure) { setError(t((failure as Error).message)); }
  };
  const download = (draft: VoiceMemoDraft) => {
    const url = URL.createObjectURL(draft.blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `voice-${draft.createdAt}.${voiceRecordingExtension(draft.mimeType)}`; anchor.click();
    downloadedRef.current = true;
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  useEffect(() => {
    void refreshDrafts();
    const onRequest = (event: Event) => {
      const request = (event as CustomEvent<VoiceMemoRequest>).detail;
      if (!voiceMemoScope()) { request.release?.(); return; }
      if (sessionRef.current && ["requesting-permission", "recording", "paused", "processing"].includes(sessionRef.current.state) || busyRef.current || draftRef.current) {
        request.release?.(); setVisible(true); toast.info(t("voice.busy")); return;
      }
      requestRef.current?.release?.(); requestRef.current = request;
      scopeRef.current = voiceMemoScope(); setVisible(true); setState("idle"); setError(""); setDuration(0);
      void refreshDrafts();
    };
    const onAuth = () => {
      setDrafts([]);
      void refreshDrafts();
      if (!scopeRef.current || scopeRef.current === voiceMemoScope()) return;
      setVisible(false);
      const session = sessionRef.current;
      const request = requestRef.current;
      const scope = scopeRef.current;
      if (session && request && (session.state === "recording" || session.state === "paused")) {
        void session.stop().then(async (voice) => {
          const draft = createVoiceMemoDraft(scope, request.noteId, voice);
          setDraft(draft); persistedRef.current = false;
          await voiceMemoDraftStore.put(draft);
          persistedRef.current = true; close();
        }).catch(() => setError(t("voice.localFailed")));
      } else if (session?.state === "requesting-permission") void session.cancel().then(close);
      else if (!busyRef.current && persistedRef.current) close();
    };
    window.addEventListener("nowen:voice-record", onRequest);
    window.addEventListener("nowen:token-changed", onAuth);
    return () => { window.removeEventListener("nowen:voice-record", onRequest); window.removeEventListener("nowen:token-changed", onAuth); };
  }, [close, refreshDrafts, t, setDraft]);
  useEffect(() => {
    const timer = setInterval(() => setDuration(sessionRef.current?.durationMs || draftRef.current?.durationMs || 0), 250);
    const unload = (event: BeforeUnloadEvent) => { if (draftRef.current && !persistedRef.current || sessionRef.current && ["recording", "paused", "requesting-permission"].includes(sessionRef.current.state)) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", unload);
    return () => { clearInterval(timer); window.removeEventListener("beforeunload", unload); void sessionRef.current?.cancel(); };
  }, []);

  const active = state === "recording" || state === "paused" || state === "requesting-permission";
  const button = "rounded-lg border border-app-border px-4 py-2 text-sm hover:bg-app-hover disabled:opacity-50";
  if ((active || current) && scopeRef.current && scopeRef.current !== voiceMemoScope()) return null;
  if (!visible) return (active || current || drafts.length > 0) ? createPortal(<button type="button" className="fixed bottom-20 right-4 z-[100] flex items-center gap-2 rounded-xl border border-app-border bg-app-surface px-4 py-3 text-sm shadow-lg" onClick={() => setVisible(true)}><Mic size={16} />{active ? `${t("voice.recording")} ${formatVoiceDuration(duration)}` : t("voice.drafts", { count: drafts.length || 1 })}</button>, document.body) : null;
  return createPortal(<div className="fixed inset-0 z-[150] flex items-end justify-center bg-black/40 md:items-center" onKeyDown={(event) => { if (event.key === "Escape") setVisible(false); }}>
    <section role="dialog" aria-modal="true" aria-label={t("voice.title")} className="max-h-[85dvh] w-full overflow-auto rounded-t-2xl border border-app-border bg-app-surface p-5 text-tx-primary shadow-xl md:max-w-md md:rounded-2xl">
      <header className="mb-5 flex items-center justify-between"><h2 className="font-semibold">{t("voice.title")}</h2><button autoFocus type="button" className={button} aria-label={t("voice.minimize")} onClick={() => setVisible(false)}><Minus size={16} /></button></header>
      <div className="mb-5 text-center"><Mic className={state === "recording" ? "mx-auto animate-pulse text-red-500" : "mx-auto text-accent-primary"} size={36} /><p className="mt-3 font-mono text-3xl">{formatVoiceDuration(duration)}</p></div>
      {error && <p role="alert" className="mb-4 whitespace-pre-line text-sm text-tx-secondary">{error}</p>}
      <div className="flex flex-wrap justify-center gap-3">
        {!active && !current && requestRef.current && state !== "uploading" && <button type="button" className={button} onClick={() => void start()}>{t("voice.start")}</button>}
        {(state === "recording" || state === "paused") && <><button type="button" className={button} onClick={() => state === "paused" ? sessionRef.current?.resume() : sessionRef.current?.pause()}>{t(state === "paused" ? "voice.resume" : "voice.pause")}</button><button type="button" className={button} onClick={() => void finish()}>{t("voice.finish")}</button></>}
        {state === "requesting-permission" && <p role="status">{t("voice.permission")}</p>}
        {(state === "processing" || state === "uploading") && <p role="status">{t(`voice.${state}`)}</p>}
        {current && state !== "uploading" && <><button type="button" className={button} onClick={() => void upload(current)}>{t("voice.retry")}</button><button type="button" className={button} onClick={() => download(current)}>{t("voice.download")}</button></>}
        {active && <button type="button" className={button} onClick={() => { if (window.confirm(t("voice.cancelConfirm"))) void sessionRef.current?.cancel().then(close); }}>{t("voice.cancel")}</button>}
        {!active && state !== "processing" && state !== "uploading" && <button type="button" className={button} onClick={() => { if (current && state === "saved") void voiceMemoDraftStore.remove(current.id).then(close); else close(); }}><X className="mr-1 inline" size={14} />{t("voice.close")}</button>}
      </div>
      {!active && state !== "uploading" && drafts.filter((draft) => draft.id !== current?.id).map((draft) => <div key={draft.id} className="mt-4 rounded-lg border border-app-border p-3 text-sm"><p>{new Date(draft.createdAt).toLocaleString()} · {formatVoiceDuration(draft.durationMs)}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className={button} onClick={() => void upload(draft)}>{t("voice.retry")}</button><button type="button" className={button} onClick={() => download(draft)}>{t("voice.download")}</button><button type="button" className={button} onClick={() => { if (window.confirm(t("voice.discardConfirm"))) void voiceMemoDraftStore.remove(draft.id).then(refreshDrafts); }}>{t("voice.discard")}</button></div></div>)}
    </section>
  </div>, document.body);
}
