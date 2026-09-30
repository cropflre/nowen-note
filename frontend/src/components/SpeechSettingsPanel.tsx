import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { voiceApi, type SpeechSettings } from "@/lib/api";

export default function SpeechSettingsPanel() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SpeechSettings>({ apiUrl: "", model: "whisper-1", language: null, apiKeySet: false, configured: false });
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { void voiceApi.settings().then(setSettings).catch((error: Error) => setMessage(error.message)); }, []);
  const save = async (test: boolean) => {
    setBusy(true); setMessage("");
    try {
      const updated = await voiceApi.saveSettings({ apiUrl: settings.apiUrl.trim(), model: settings.model.trim(), language: settings.language || null, ...(clearKey ? { apiKey: "" } : key ? { apiKey: key } : {}) });
      setSettings(updated); setKey(""); setClearKey(false);
      window.dispatchEvent(new Event("nowen:speech-settings-changed"));
      if (test) await voiceApi.test();
      setMessage(t(test ? "voice.testSuccess" : "voice.configSaved"));
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };
  return <section className="space-y-3 rounded-xl border border-app-border p-4">
    <h3 className="font-semibold text-tx-primary">{t("voice.settings")}</h3>
    <p className="text-xs text-tx-secondary">{t("voice.settingsDescription")}</p>
    {(["apiUrl", "model", "language"] as const).map((field) => <label className="block text-sm" key={field}>
      {t(`voice.${field}`)}
      <input className="mt-1 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2" value={settings[field] || ""} placeholder={field === "apiUrl" ? "https://api.openai.com/v1" : field === "language" ? "auto" : "whisper-1"} onChange={(event) => setSettings({ ...settings, [field]: event.target.value })} />
    </label>)}
    <label className="block text-sm">{t("voice.apiKey")}<input type="password" autoComplete="new-password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={settings.apiKeySet ? t("voice.keySet") : ""} className="mt-1 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2" /></label>
    {settings.apiKeySet && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />{t("voice.clearKey")}</label>}
    <div className="flex gap-3"><button type="button" disabled={busy} onClick={() => void save(false)} className="rounded-lg bg-accent-primary px-3 py-2 text-sm text-white disabled:opacity-50">{t("voice.save")}</button><button type="button" disabled={busy || !settings.apiUrl} onClick={() => void save(true)} className="rounded-lg border border-app-border px-3 py-2 text-sm disabled:opacity-50">{t("voice.test")}</button></div>
    {message && <p role="status" className="text-sm text-tx-secondary">{message}</p>}
  </section>;
}
