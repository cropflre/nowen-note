import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { wechatAccountApi, type WechatAccountHistory } from "@/lib/pluginApi";
import { invalidateNotebooks } from "@/lib/notebookInvalidation";

export function WechatAccountSettings({ onQueued }: { onQueued: () => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const [articleUrl, setArticleUrl] = useState("");
  const [readingUrl, setReadingUrl] = useState("");
  const [cookie, setCookie] = useState("");
  const [account, setAccount] = useState<WechatAccountHistory | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const submitted = useRef<Set<string>>(new Set());
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const collect = async (urls: string[]) => {
    if (!account) return;
    const remaining = urls.filter((url) => !submitted.current.has(url));
    let accepted = 0, duplicates = 0, completed = 0;
    try {
      for (let start = 0; start < remaining.length; start += 20) {
        const batch = remaining.slice(start, start + 20), result = await wechatAccountApi.collect(account.id, batch);
        for (const url of batch) submitted.current.add(url);
        accepted += result.accepted; duplicates += result.duplicates; completed += batch.length;
        setNotice(t("wechatAccount.queued", { accepted, duplicates, completed, total: remaining.length }));
      }
    } finally {
      if (completed) {
        setSelected((current) => new Set([...current].filter((url) => !submitted.current.has(url))));
        invalidateNotebooks("create"); window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "wechat-account" } }));
        await onQueued();
      }
    }
  };
  const button = "rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-sm disabled:opacity-50";
  return <section className="space-y-3 rounded-lg border border-zinc-200 dark:border-zinc-700 p-3" aria-label={t("wechatAccount.title")}>
    <h4 className="font-semibold">{t("wechatAccount.title")}</h4>
    <p className="text-sm text-zinc-500">{t("wechatAccount.description")}</p>
    <p className="text-xs text-amber-700 dark:text-amber-400">{t("wechatAccount.experimental")}</p>
    {!account ? <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void act(async () => { setAccount(await wechatAccountApi.identify(articleUrl)); submitted.current.clear(); setSelected(new Set()); }); }}>
      <label className="block text-sm">{t("wechatAccount.article")}<input className="mt-1 w-full rounded border bg-transparent p-2" type="url" value={articleUrl} maxLength={4096} onChange={(event) => setArticleUrl(event.target.value)} placeholder="https://mp.weixin.qq.com/s/…" /></label>
      <button className={button} disabled={busy || !articleUrl.trim()}>{t("wechatAccount.identify")}</button>
    </form> : <>
      <div className="flex items-center justify-between gap-2"><span className="font-medium">{account.name}</span><button className={button} disabled={busy} onClick={() => void act(async () => { const id = account.id; setAccount(null); setReadingUrl(""); setCookie(""); setSelected(new Set()); submitted.current.clear(); await wechatAccountApi.forget(id); })}>{t("wechatAccount.change")}</button></div>
      {!account.verified ? <>
        <p className="text-sm">{t("wechatAccount.authorization")}</p>
        <label className="block text-xs">{t("wechatAccount.home")}<input readOnly value={account.homeUrl} className="mt-1 w-full rounded border bg-transparent p-2 text-xs" /></label>
        <details><summary className="cursor-pointer text-sm">{t("wechatAccount.verifyHelp")}</summary>
          <p className="my-2 text-xs text-zinc-500">{t("wechatAccount.credentialHelp")}</p>
          <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); const value = readingUrl, sessionCookie = cookie; setReadingUrl(""); setCookie(""); void act(async () => { setAccount(await wechatAccountApi.verify(account.id, value, sessionCookie)); }); }}>
            <label className="block text-xs">{t("wechatAccount.readingUrl")}<input type="password" autoComplete="off" value={readingUrl} maxLength={8192} onChange={(event) => setReadingUrl(event.target.value)} className="mt-1 w-full rounded border bg-transparent p-2" /></label>
            <label className="block text-xs">{t("wechatAccount.cookie")}<input type="password" autoComplete="off" value={cookie} maxLength={8192} onChange={(event) => setCookie(event.target.value)} className="mt-1 w-full rounded border bg-transparent p-2" /></label>
            <button className={button} disabled={busy || !readingUrl.trim()}>{t("wechatAccount.verify")}</button>
          </form>
        </details>
      </> : <>
        <p role="status" className="text-sm">{t(account.hasMore ? "wechatAccount.partial" : "wechatAccount.end", { count: account.articles.length })}</p>
        {account.hasMore && <button className={button} disabled={busy} onClick={() => void act(async () => { setAccount(await wechatAccountApi.next(account.id)); })}>{t("wechatAccount.more")}</button>}
        <div className="max-h-64 space-y-2 overflow-auto">{account.articles.map((article) => <label key={article.url} className="flex items-start gap-2 text-sm"><input type="checkbox" disabled={busy || submitted.current.has(article.url)} checked={selected.has(article.url)} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(article.url); else next.delete(article.url); return next; })} /><span>{article.title || article.url}{article.publishedAt > 0 && <span className="block text-xs text-zinc-500">{new Date(article.publishedAt * 1000).toLocaleDateString(i18n.language)}</span>}</span></label>)}</div>
        <div className="flex flex-wrap gap-2"><button className={button} disabled={busy || selected.size === 0} onClick={() => void act(() => collect([...selected]))}>{t("wechatAccount.collectSelected", { count: selected.size })}</button><button className={button} disabled={busy || account.hasMore || account.articles.length === 0 || account.articles.every((article) => submitted.current.has(article.url))} onClick={() => void act(() => collect(account.articles.map((article) => article.url)))}>{t("wechatAccount.collectAll")}</button></div>
      </>}
    </>}
    {notice && <p role="status" className="text-sm text-green-700">{notice}</p>}
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
  </section>;
}
