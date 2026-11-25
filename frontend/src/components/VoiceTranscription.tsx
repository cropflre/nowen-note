import { useState } from "react";
import { useTranslation } from "react-i18next";
import { voiceApi } from "@/lib/api";
import { toast } from "@/lib/toast";
import { extractAttachmentId, getPersistentAttachmentUrl } from "@/lib/noteAttachmentAccessBridge";
import { useSpeechConnectionAvailable } from "@/lib/speechConnection";

export default function VoiceTranscription({ attachmentId, src, onInsert }: { attachmentId?: string; src: string; onInsert: (text: string) => void }) {
  const id = attachmentId || extractAttachmentId(getPersistentAttachmentUrl(src) || src);
  return id ? <ConnectedVoiceTranscription id={id} onInsert={onInsert} /> : null;
}

function ConnectedVoiceTranscription({ id, onInsert }: { id: string; onInsert: (text: string) => void }) {
  const connected = useSpeechConnectionAvailable();
  return connected ? <VoiceTranscriptEditor id={id} onInsert={onInsert} /> : null;
}

function VoiceTranscriptEditor({ id, onInsert }: { id: string; onInsert: (text: string) => void }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const transcribe = async () => {
    setBusy(true); setError("");
    try { setText((await voiceApi.transcribe(id)).text); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const button = "rounded-md border border-app-border px-3 py-1.5 text-xs hover:bg-app-hover disabled:opacity-50";
  return <div className="space-y-2">
    <button type="button" className={button} disabled={busy} onClick={() => void transcribe()}>{t(busy ? "voice.transcribing" : text === null ? "voice.transcribe" : "voice.retranscribe")}</button>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {text !== null && <><p className="text-sm font-medium">{t("voice.transcript")}</p><textarea aria-label={t("voice.transcript")} value={text} onChange={(event) => setText(event.target.value)} className="min-h-28 w-full rounded-lg border border-app-border bg-app-bg p-3 text-sm" /><div className="flex gap-2"><button type="button" className={button} disabled={!text} onClick={() => onInsert(text)}>{t("voice.insert")}</button><button type="button" className={button} disabled={!text} onClick={() => void navigator.clipboard.writeText(text).catch((failure: Error) => toast.error(failure.message))}>{t("voice.copy")}</button></div>{!text && <p className="text-xs text-tx-secondary">{t("voice.noSpeech")}</p>}</>}
  </div>;
}
