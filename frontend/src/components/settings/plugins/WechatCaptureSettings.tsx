import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatAppDateTime } from "@/lib/dateTime";
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
  const button = "shrink-0 whitespace-nowrap rounded-xl border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-semibold text-tx-primary transition-all hover:border-emerald-400/50 hover:text-emerald-600 disabled:opacity-50 dark:hover:text-emerald-300";
  return (
    <section className="space-y-4 rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.06] via-app-surface/90 to-teal-500/[0.05] p-4 shadow-xs" aria-label={t("wechatCapture.title")}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2.5 text-sm font-bold text-tx-primary">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-300">
            <MessageCircle size={16} />
          </span>
          {t("wechatCapture.title")}
        </h3>
        <button className={button} disabled={busy} onClick={() => void act(refresh)} aria-label={t("wechatAssistant.refresh")}>
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        </button>
      </div>
      <p className="text-xs leading-relaxed text-tx-secondary">{t("wechatCapture.description")}</p>
      {!status && <p className="text-xs text-tx-tertiary">{t("wechatAssistant.loading")}</p>}
      {status && <>
        {!status.pluginReady && <p className="rounded-xl border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 dark:text-amber-300">{t("wechatCapture.pluginRequired")}</p>}
        <label className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-app-border/75 bg-app-elevated/80 px-3.5 py-2.5 text-xs font-semibold text-tx-primary">
          <input
            type="checkbox"
            checked={status.clipboardPrompt}
            disabled={busy || !status.pluginReady || status.clipboardAvailable === false}
            onChange={(event) => { const enabled = event.target.checked; void act(async () => { await wechatCaptureApi.preferences(enabled); }); }}
            className="h-4 w-4 rounded accent-emerald-600"
          />
          {t("wechatCapture.clipboard")}
        </label>
        {status.clipboardAvailable === false && <p className="text-xs text-amber-700 dark:text-amber-300">{t("wechatCapture.upgrade")}</p>}
        <p className="text-xs text-tx-tertiary">{t("wechatCapture.clipboardHelp")}</p>
        {!((window as Window & { nowenDesktop?: { isDesktop?: boolean } }).nowenDesktop?.isDesktop) && navigator.clipboard?.readText && (
          <button className={button} disabled={busy || !status.pluginReady} onClick={() => void act(async () => { const links = wechatArticleLinks(await navigator.clipboard.readText()); setText(links.join("\n")); setNotice(t("wechatCapture.browserEnabled")); })}>
            {t("wechatCapture.readClipboard")}
          </button>
        )}
        <form data-wechat-capture-form className="space-y-2.5" onSubmit={(event) => { event.preventDefault(); void act(async () => { const result = await collectWechatArticles(text); if (mounted.current) { setText(""); setNotice(t("wechatAssistant.accepted", result)); } }); }}>
          <label className="block text-xs font-semibold text-tx-secondary" htmlFor="wechat-article-links">{t("wechatAssistant.paste")}</label>
          <textarea
            id="wechat-article-links"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={16384}
            placeholder={t("wechatCapture.placeholder")}
            className="min-h-24 w-full rounded-xl border border-app-border/80 bg-app-elevated px-3.5 py-2.5 text-sm text-tx-primary outline-none transition focus:border-emerald-400 focus:ring-2 focus:ring-emerald-500/15"
          />
          <button className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 px-4 py-2 text-xs font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:translate-y-0 disabled:opacity-50" disabled={busy || !text.trim() || !status.pluginReady}>
            {t(busy ? "wechatCapture.collecting" : "wechatAssistant.collect")}
          </button>
        </form>
        <p className="text-xs text-tx-tertiary">{t("wechatCapture.accountHelp")}</p>
        <div className="space-y-2">
          <p className="text-xs font-semibold text-tx-secondary">{t("wechatAssistant.recent")}</p>
          {status.items.length === 0 && <p className="rounded-xl border border-dashed border-app-border/75 py-4 text-center text-xs text-tx-tertiary">{t("wechatAssistant.empty")}</p>}
          {status.items.map((item) => (
            <div key={item.id} className="flex items-start gap-3 rounded-xl border border-app-border/75 bg-app-elevated/85 p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-tx-primary" title={item.note?.title || item.url}>{item.note?.title || item.url}</p>
                <p className="mt-0.5 text-xs text-tx-secondary">{t(`wechatAssistant.status.${item.status}`, { defaultValue: item.status })} · {formatAppDateTime(item.createdAt, undefined, undefined, i18n.language)}</p>
                {item.error && item.status === "failed" && <p className="mt-1 break-words text-xs text-rose-600 dark:text-rose-400">{item.error}</p>}
              </div>
              {item.note && <button className={button} onClick={() => { window.dispatchEvent(new CustomEvent("nowen:open-note", { detail: { noteId: item.note!.id } })); window.dispatchEvent(new Event("nowen:close-settings")); }}>{t("wechatAssistant.open")}</button>}
              {item.status === "failed" && <button className={button} disabled={busy} onClick={() => void act(async () => { await wechatCaptureApi.retry(item.id); })}>{t("wechatAssistant.retry")}</button>}
            </div>
          ))}
        </div>
      </>}
      {notice && <p role="status" className="rounded-xl bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-700 dark:text-emerald-300">{notice}</p>}
      {error && <p role="alert" className="break-words rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-600 dark:text-rose-300">{error}</p>}
    </section>
  );
}
