import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, MessageCircle, RefreshCw } from "lucide-react";
import { invalidateNotebooks } from "@/lib/notebookInvalidation";
import { wechatAssistantApi, type WechatAssistantConfiguration, type WechatAssistantStatus } from "@/lib/pluginApi";
import { WechatAccountSettings } from "./WechatAccountSettings";

export function WechatAssistantSettings({ isAdmin }: { isAdmin: boolean }) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<WechatAssistantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [qr, setQr] = useState<{ qrUrl: string; expiresAt: number } | null>(null);
  const [expired, setExpired] = useState(false);
  const [configuration, setConfiguration] = useState<WechatAssistantConfiguration | null>(null);
  const [draft, setDraft] = useState({ appId: "", publicUrl: "", mode: "encrypted", token: "", appSecret: "", encodingKey: "" });
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const next = await wechatAssistantApi.status();
    if (mounted.current) { setStatus(next); if (next.connected) setQr(null); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((cause) => setError(cause.message));
    return () => { mounted.current = false; };
  }, [refresh]);
  useEffect(() => {
    if (!qr && !status?.connected && !status?.items.some((item) => ["queued", "running", "waiting"].includes(item.status))) return;
    const timer = window.setInterval(() => {
      if (qr && Date.now() >= qr.expiresAt) { setExpired(true); setQr(null); }
      void refresh().catch((cause) => { if (mounted.current) setError(cause.message); });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [qr, status, refresh]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const loadConfiguration = async () => {
    try {
      const config = await wechatAssistantApi.configuration();
      setConfiguration(config);
      setDraft((current) => ({ ...current, appId: config.appId, publicUrl: config.publicUrl, mode: config.mode }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const button = "rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50";
  return <section className="space-y-4 rounded-xl bg-zinc-50 dark:bg-zinc-900 p-4" aria-label={t("wechatAssistant.inbox")}>
    <div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2 font-semibold"><MessageCircle size={18} />{t("wechatAssistant.inbox")}</div><button className={button} disabled={busy} onClick={() => void act(refresh)} aria-label={t("wechatAssistant.refresh")}><RefreshCw size={15} /></button></div>
    {!status && <p className="text-sm text-zinc-500">{t("wechatAssistant.loading")}</p>}
    {status && <>
      <WechatAccountSettings onQueued={refresh} />
      <details><summary className="cursor-pointer text-sm text-zinc-500">{t("wechatAccount.messageEntry")}</summary><div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm">{t(status.connected ? "wechatAssistant.connected" : "wechatAssistant.disconnected")}</span>
        {status.connected ? <button className={button} disabled={busy} onClick={() => void act(async () => { await wechatAssistantApi.disconnect(); setQr(null); })}>{t("wechatAssistant.disconnect")}</button> : <button className={button} disabled={busy || !status.ready} onClick={() => void act(async () => { setQr(await wechatAssistantApi.connect()); setExpired(false); })}>{busy && <Loader2 size={14} className="inline animate-spin mr-1" />}{t("wechatAssistant.connect")}</button>}
      </div>
      {!status.ready && <p className="text-sm text-amber-700 dark:text-amber-400">{t(status.pluginReady ? "wechatAssistant.setupRequired" : "wechatAssistant.pluginRequired")}</p>}
      {expired && <p className="text-sm text-amber-700 dark:text-amber-400">{t("wechatAssistant.expired")}</p>}
      {qr && <div className="space-y-2"><img src={qr.qrUrl} className="h-48 w-48 rounded-lg bg-white p-2" alt={t("wechatAssistant.qrAlt")} referrerPolicy="no-referrer" /><p className="text-xs text-zinc-500">{t("wechatAssistant.scanDisclosure")}</p></div>}

    {isAdmin && <details onToggle={(event) => { if (event.currentTarget.open && !configuration) void loadConfiguration(); }}>
      <summary className="cursor-pointer text-sm text-zinc-500">{t("wechatAssistant.adminSetup")}</summary>
      <p className="my-2 text-xs text-zinc-500">{t("wechatAssistant.adminDescription")}</p>
      <form className="grid gap-2" onSubmit={(event) => { event.preventDefault(); void act(async () => { const next = await wechatAssistantApi.configure(draft); setConfiguration(next); setDraft((current) => ({ ...current, token: "", appSecret: "", encodingKey: "" })); setNotice(t("wechatAssistant.saved")); }); }}>
        {(["publicUrl", "appId", "token", "appSecret", "encodingKey"] as const).map((key) => <label key={key} className="text-xs">{t(`wechatAssistant.fields.${key}`)}<input type={["token", "appSecret", "encodingKey"].includes(key) ? "password" : "text"} autoComplete="off" value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} className="mt-1 block w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent p-2 text-sm" placeholder={configuration?.configured && ["token", "appSecret", "encodingKey"].includes(key) ? t("wechatAssistant.keepSecret") : undefined} /></label>)}
        <label className="text-xs">{t("wechatAssistant.mode")}<select className="ml-2 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-1" value={draft.mode} onChange={(event) => setDraft((current) => ({ ...current, mode: event.target.value }))}><option value="encrypted">{t("wechatAssistant.encrypted")}</option><option value="plain">{t("wechatAssistant.plain")}</option></select></label>
        <button className={button} disabled={busy || !status?.pluginReady}>{t("wechatAssistant.save")}</button>
      </form>
      {configuration?.callbackUrl && <p className="mt-2 break-all text-xs">{t("wechatAssistant.callback")}: <code>{configuration.callbackUrl}</code></p>}
    </details>}
      </div></details>
      <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void act(async () => { const result = await wechatAssistantApi.collect(text); setText(""); setNotice(t("wechatAssistant.accepted", result)); invalidateNotebooks("create"); window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "wechat-inbox" } })); }); }}>
        <label className="block text-sm font-medium" htmlFor="wechat-article-links">{t("wechatAssistant.paste")}</label>
        <textarea id="wechat-article-links" value={text} onChange={(event) => setText(event.target.value)} maxLength={16384} placeholder={t("wechatAssistant.placeholder")} className="min-h-24 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent p-2 text-sm" />
        <button className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={busy || !text.trim() || !status.pluginReady}>{t("wechatAssistant.collect")}</button>
      </form>
      <div className="space-y-2">
        <p className="text-xs text-zinc-500">{t("wechatAssistant.recent")}</p>
        {status.items.length === 0 && <p className="py-3 text-sm text-zinc-500">{t("wechatAssistant.empty")}</p>}
        {status.items.map((item) => <div key={item.id} className="flex items-start gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium" title={item.note?.title || item.url}>{item.note?.title || item.url}</p><p className="text-xs text-zinc-500">{t(`wechatAssistant.status.${item.status}`, { defaultValue: item.status })} · {new Date(item.createdAt).toLocaleString(i18n.language)}</p>{item.error && item.status === "failed" && <p className="mt-1 break-words text-xs text-red-600">{item.error}</p>}</div>
          {item.note && <button className={button} onClick={() => { window.dispatchEvent(new CustomEvent("nowen:open-note", { detail: { noteId: item.note!.id } })); window.dispatchEvent(new Event("nowen:close-settings")); }}>{t("wechatAssistant.open")}</button>}
          {item.status === "failed" && <button className={button} disabled={busy} onClick={() => void act(async () => { await wechatAssistantApi.retry(item.id); })}>{t("wechatAssistant.retry")}</button>}
        </div>)}
      </div>
    </>}
    {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
    {error && <p role="alert" className="break-words text-sm text-red-600">{error}</p>}

  </section>;
}
