import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { wechatCaptureApi } from "@/lib/pluginApi";
import { collectWechatArticles, readWechatClipboard, wechatArticleLinks, WECHAT_CAPTURE_SETTINGS_EVENT } from "@/lib/wechatCapture";
import { toast } from "@/lib/toast";

export default function WechatClipboardBridge() {
  const { t } = useTranslation();
  const [urls, setUrls] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let disposed = false;
    let checking = false;
    const check = async (pasted?: string) => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const status = await wechatCaptureApi.status();
        if (disposed) return;
        if (!status.pluginReady || !status.clipboardPrompt) { pending.current = false; setUrls([]); return; }
        if (pending.current) return;
        const candidates = pasted === undefined ? await readWechatClipboard() : wechatArticleLinks(pasted);
        if (disposed) return;
        const newUrls = candidates.filter((url) => !seen.current.has(url) && !status.items.some((item) => item.url === url && ["queued", "running", "waiting", "completed"].includes(item.status)));
        if (!newUrls.length) return;
        newUrls.forEach((url) => seen.current.add(url));
        pending.current = true; setUrls(newUrls); setError("");
      } catch { /* Offline, disabled, or clipboard access unavailable: manual capture remains available. */ }
      finally { checking = false; }
    };
    const onFocus = () => { void check(); };
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-wechat-capture-form]") || target?.closest('input[type="password"]')) return;
      const text = event.clipboardData?.getData("text/plain") || "";
      if (wechatArticleLinks(text).length) void check(text);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    document.addEventListener("paste", onPaste);
    window.addEventListener(WECHAT_CAPTURE_SETTINGS_EVENT, onFocus);
    void check();
    return () => {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      document.removeEventListener("paste", onPaste);
      window.removeEventListener(WECHAT_CAPTURE_SETTINGS_EVENT, onFocus);
    };
  }, []);
  if (!urls.length) return null;
  const dismiss = () => { pending.current = false; setUrls([]); setError(""); };
  const collect = async () => {
    setBusy(true); setError("");
    try { const result = await collectWechatArticles(urls.join("\n")); toast.success(t("wechatAssistant.accepted", result)); dismiss(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <aside role="dialog" aria-label={t("wechatCapture.detected")} className="fixed bottom-5 right-5 z-[100] w-[calc(100vw-2.5rem)] max-w-sm rounded-xl border border-zinc-200 bg-white p-4 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
    <p className="font-semibold">{t("wechatCapture.detected")}</p>
    <p className="mt-2 text-sm text-zinc-500">{t("wechatCapture.prompt", { count: urls.length })}</p>
    <ul className="my-3 max-h-32 overflow-auto text-xs text-zinc-500">{urls.map((url) => <li key={url} className="truncate" title={url}>{url}</li>)}</ul>
    {error && <p role="alert" className="mb-2 text-sm text-red-600">{error}</p>}
    <div className="flex justify-end gap-2"><button disabled={busy} className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50" onClick={dismiss}>{t("wechatCapture.dismiss")}</button><button disabled={busy} className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white disabled:opacity-50" onClick={() => void collect()}>{t(busy ? "wechatCapture.collecting" : "wechatAssistant.collect")}</button></div>
  </aside>;
}
