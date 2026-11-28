import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { Loader2, Mic, PlugZap, Save } from "lucide-react";
import { voiceApi, type SpeechSettings } from "@/lib/api";
import { getSpeechConnectionScope, refreshSpeechConnectionAfterSave, verifySpeechConnection } from "@/lib/speechConnection";

export default function SpeechSettingsPanel() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<SpeechSettings>({ apiUrl: "", model: "whisper-1", language: null, apiKeySet: false, configured: false });
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { void voiceApi.settings().then(setSettings).catch((error: Error) => setMessage(error.message)); }, []);
  const save = async (test: boolean) => {
    const scope = getSpeechConnectionScope();
    setBusy(true); setMessage("");
    try {
      const updated = await voiceApi.saveSettings({ apiUrl: settings.apiUrl.trim(), model: settings.model.trim(), language: settings.language || null, ...(clearKey ? { apiKey: "" } : key ? { apiKey: key } : {}) });
      setSettings(updated); setKey(""); setClearKey(false);
      if (test) {
        if (!await verifySpeechConnection(scope, updated.configured)) {
          if (scope === getSpeechConnectionScope()) setMessage(t("voice.configure"));
          return;
        }
      } else refreshSpeechConnectionAfterSave(scope);
      setMessage(t(test ? "voice.testSuccess" : "voice.configSaved"));
    } catch (error) { setMessage((error as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className="space-y-4 rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.45 }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500/20 via-violet-400/18 to-fuchsia-500/20 text-sky-600 shadow-xs ring-1 ring-sky-500/20 dark:text-sky-300"
        >
          <Mic size={18} />
        </motion.span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-tx-primary">{t("voice.settings")}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-tx-secondary">{t("voice.settingsDescription")}</p>
        </div>
      </div>

      <div className="grid gap-3.5 sm:grid-cols-2">
        {(["apiUrl", "model", "language"] as const).map((field) => (
          <label className="block space-y-1.5 text-xs font-semibold text-tx-secondary" key={field}>
            <span>{t(`voice.${field}`)}</span>
            <input
              className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2 text-sm font-normal text-tx-primary outline-none transition-all focus:border-sky-400 focus:ring-2 focus:ring-sky-500/15"
              value={settings[field] || ""}
              placeholder={field === "apiUrl" ? "https://api.openai.com/v1" : field === "language" ? "auto" : "whisper-1"}
              onChange={(event) => setSettings({ ...settings, [field]: event.target.value })}
            />
          </label>
        ))}
        <label className="block space-y-1.5 text-xs font-semibold text-tx-secondary">
          <span>{t("voice.apiKey")}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder={settings.apiKeySet ? t("voice.keySet") : ""}
            className="w-full rounded-xl border border-app-border/80 bg-app-surface/90 px-3.5 py-2 text-sm font-normal text-tx-primary outline-none transition-all focus:border-sky-400 focus:ring-2 focus:ring-sky-500/15"
          />
        </label>
      </div>

      {settings.apiKeySet && (
        <label className="inline-flex items-center gap-2 rounded-xl border border-app-border/70 bg-app-surface/65 px-3 py-2 text-xs font-medium text-tx-secondary">
          <input
            type="checkbox"
            checked={clearKey}
            onChange={(event) => setClearKey(event.target.checked)}
            className="h-3.5 w-3.5 rounded accent-sky-600"
          />
          {t("voice.clearKey")}
        </label>
      )}

      <div className="flex flex-wrap items-center gap-2.5 border-t border-app-border/70 pt-3.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void save(false)}
          className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-gradient-to-r from-sky-500 via-blue-500 to-indigo-500 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-sky-500/20 transition-all hover:-translate-y-0.5 hover:shadow-md disabled:translate-y-0 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
          {t("voice.save")}
        </button>
        <button
          type="button"
          disabled={busy || !settings.apiUrl}
          onClick={() => void save(true)}
          className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-4 py-2 text-xs font-semibold text-tx-primary transition-all hover:-translate-y-0.5 hover:border-sky-400/50 hover:text-sky-600 disabled:translate-y-0 disabled:opacity-50 dark:hover:text-sky-300"
        >
          <PlugZap size={13} />
          {t("voice.test")}
        </button>
        {message && (
          <p role="status" className="rounded-full bg-app-hover/80 px-3 py-1 text-xs font-medium text-tx-secondary sm:ml-auto">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
