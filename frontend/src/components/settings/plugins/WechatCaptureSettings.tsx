import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageCircle, RefreshCw } from "lucide-react";
import { wechatCaptureApi, type WechatCaptureStatus } from "@/lib/pluginApi";
import { collectWechatArticles, wechatArticleLinks, WECHAT_CAPTURE_CHANGED_EVENT, WECHAT_CAPTURE_SETTINGS_EVENT } from "@/lib/wechatCapture";

export function WechatCaptureSettings() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<WechatCaptureStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const next = await wechatCaptureApi.status();
    if (mounted.current) setStatus(next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    const update = () => { void refresh().catch((cause) => { if (mounted.current) setError(cause.message); }); };
    update(); window.addEventListener(WECHAT_CAPTURE_CHANGED_EVENT, update); window.addEventListener(WECHAT_CAPTURE_SETTINGS_EVENT, update);
    return () => { mounted.current = false; window.removeEventListener(WECHAT_CAPTURE_CHANGED_EVENT, update); window.removeEventListener(WECHAT_CAPTURE_SETTINGS_EVENT, update); };
  }, [refresh]);
  useEffect(() => {
    if (!status?.items.some((item) => ["queued", "running", "waiting"].includes(item.status))) return;
    const timer = window.setInterval(() => { void refresh().catch((cause) => { if (mounted.current) setError(cause.message); }); }, 2500);
    return () => window.clearInterval(timer);
  }, [status, refresh]);
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); await refresh(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const button = "rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50";
  return <section className="space-y-4 rounded-xl bg-zinc-50 dark:bg-zinc-900 p-4" aria-label={t("wechatCapture.title")}>
    <div className="flex items-center justify-between gap-3"><h3 className="flex items-center gap-2 font-semibold"><MessageCircle size={18} />{t("wechatCapture.title")}</h3><button className={button} disabled={busy} onClick={() => void act(refresh)} aria-label={t("wechatAssistant.refresh")}><RefreshCw size={15} /></button></div>
    <p className="text-sm text-zinc-500">{t("wechatCapture.description")}</p>
    {!status && <p className="text-sm text-zinc-500">{t("wechatAssistant.loading")}</p>}
    {status && <>
      {!status.pluginReady && <p className="text-sm text-amber-700 dark:text-amber-400">{t("wechatCapture.pluginRequired")}</p>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={status.clipboardPrompt} disabled={busy || !status.pluginReady || status.clipboardAvailable === false} onChange={(event) => { const enabled = event.target.checked; void act(async () => { await wechatCaptureApi.preferences(enabled); }); }} />{t("wechatCapture.clipboard")}</label>
      {status.clipboardAvailable === false && <p className="text-xs text-amber-700">{t("wechatCapture.upgrade")}</p>}
      <p className="text-xs text-zinc-500">{t("wechatCapture.clipboardHelp")}</p>
      {!((window as any).nowenDesktop?.isDesktop) && navigator.clipboard?.readText && <button className={button} disabled={busy || !status.pluginReady} onClick={() => void act(async () => { const links = wechatArticleLinks(await navigator.clipboard.readText()); setText(links.join("\n")); setNotice(t("wechatCapture.browserEnabled")); })}>{t("wechatCapture.readClipboard")}</button>}
      <form data-wechat-capture-form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void act(async () => { const result = await collectWechatArticles(text); if (mounted.current) { setText(""); setNotice(t("wechatAssistant.accepted", result)); } }); }}>
        <label className="block text-sm font-medium" htmlFor="wechat-article-links">{t("wechatAssistant.paste")}</label>
        <textarea id="wechat-article-links" value={text} onChange={(event) => setText(event.target.value)} maxLength={16384} placeholder={t("wechatCapture.placeholder")} className="min-h-24 w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent p-2 text-sm" />
        <button className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white disabled:opacity-50" disabled={busy || !text.trim() || !status.pluginReady}>{t(busy ? "wechatCapture.collecting" : "wechatAssistant.collect")}</button>
      </form>
      <p className="text-xs text-zinc-500">{t("wechatCapture.accountHelp")}</p>
      <div className="space-y-2">
        <p className="text-xs text-zinc-500">{t("wechatAssistant.recent")}</p>
        {status.items.length === 0 && <p className="py-3 text-sm text-zinc-500">{t("wechatAssistant.empty")}</p>}
        {status.items.map((item) => <div key={item.id} className="flex items-start gap-3 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3">
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium" title={item.note?.title || item.url}>{item.note?.title || item.url}</p><p className="text-xs text-zinc-500">{t(`wechatAssistant.status.${item.status}`, { defaultValue: item.status })} · {new Date(item.createdAt).toLocaleString(i18n.language)}</p>{item.error && item.status === "failed" && <p className="mt-1 break-words text-xs text-red-600">{item.error}</p>}</div>
          {item.note && <button className={button} onClick={() => { window.dispatchEvent(new CustomEvent("nowen:open-note", { detail: { noteId: item.note!.id } })); window.dispatchEvent(new Event("nowen:close-settings")); }}>{t("wechatAssistant.open")}</button>}
          {item.status === "failed" && <button className={button} disabled={busy} onClick={() => void act(async () => { await wechatCaptureApi.retry(item.id); })}>{t("wechatAssistant.retry")}</button>}
        </div>)}
      </div>
    </>}
    {notice && <p role="status" className="text-sm text-green-700 dark:text-green-400">{notice}</p>}
    {error && <p role="alert" className="break-words text-sm text-red-600">{error}</p>}
  </section>;
}
