import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { voiceApi } from "@/lib/api";
import { toast } from "@/lib/toast";

export default function VoiceTranscription({ src, onInsert }: { src: string; onInsert: (text: string) => void }) {
  const { t } = useTranslation();
  const attachmentId = src.match(/\/api\/attachments\/([^/?#]+)/)?.[1];
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let mounted = true;
    const refresh = () => { void voiceApi.settings().then((settings) => { if (mounted) setConfigured(settings.configured); }).catch(() => { if (mounted) setConfigured(false); }); };
    refresh(); window.addEventListener("nowen:speech-settings-changed", refresh);
    return () => { mounted = false; window.removeEventListener("nowen:speech-settings-changed", refresh); };
  }, []);
  const transcribe = async () => {
    if (!attachmentId) return;
    setBusy(true); setError("");
    try { setText((await voiceApi.transcribe(attachmentId)).text); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); }
  };
  const button = "rounded-md border border-app-border px-3 py-1.5 text-xs hover:bg-app-hover disabled:opacity-50";
  if (!attachmentId) return null;
  return <div className="space-y-2">
    <button type="button" className={button} disabled={!configured || busy} title={!configured ? t("voice.configure") : undefined} onClick={() => void transcribe()}>{t(busy ? "voice.transcribing" : text === null ? "voice.transcribe" : "voice.retranscribe")}</button>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {text !== null && <><p className="text-sm font-medium">{t("voice.transcript")}</p><textarea aria-label={t("voice.transcript")} value={text} onChange={(event) => setText(event.target.value)} className="min-h-28 w-full rounded-lg border border-app-border bg-app-bg p-3 text-sm" /><div className="flex gap-2"><button type="button" className={button} disabled={!text} onClick={() => onInsert(text)}>{t("voice.insert")}</button><button type="button" className={button} disabled={!text} onClick={() => void navigator.clipboard.writeText(text).catch((failure: Error) => toast.error(failure.message))}>{t("voice.copy")}</button></div>{!text && <p className="text-xs text-tx-secondary">{t("voice.noSpeech")}</p>}</>}
  </div>;
}
