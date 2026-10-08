import { useEffect, useState } from "react";
import { BellRing, Check, Clock3, Eye, Send } from "lucide-react";
import { taskDigestApi, type TaskDigestConfig, type TaskDigestPreview } from "@/lib/taskDigestApi";

const defaultConfig: TaskDigestConfig = {
  userId: "", morningEnabled: 0, eveningEnabled: 0,
  morningTime: "09:00", eveningTime: "21:00",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
};
export default function TaskDigestSettings() {
  const [config, setConfig] = useState<TaskDigestConfig>(defaultConfig);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookCount, setWebhookCount] = useState(0);
  const [newSecret, setNewSecret] = useState("");
  const [preview, setPreview] = useState<TaskDigestPreview | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    Promise.all([taskDigestApi.get(), taskDigestApi.listWebhooks()]).then(([saved, hooks]) => {
      if (!active) return;
      setConfig(saved);
      setWebhookCount(hooks.filter((hook) =>
        hook.events.includes("*") || hook.events.some((event) => event.startsWith("task.digest."))).length);
    }).catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  const update = (values: Partial<TaskDigestConfig>) => setConfig((value) => ({ ...value, ...values }));
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950" aria-label="每日任务简报">
    <div className="flex items-start gap-3">
      <span className="rounded-lg bg-indigo-50 p-2 text-indigo-600 dark:bg-indigo-950/40"><BellRing size={18}/></span>
      <div className="flex-1"><h3 className="text-sm font-semibold">每日任务简报</h3>
        <p className="mt-1 text-xs text-zinc-500">按你的时区统计个人待办，通过 HTTPS Webhook 推送早间计划和晚间进度。关闭客户端后，需要服务器持续运行。</p></div>
    </div>
    {loading ? <p className="text-xs text-zinc-500">正在加载配置…</p> : <>
      <div className="grid gap-3 md:grid-cols-2">
        {([
          ["morningEnabled", "morningTime", "早间计划"],
          ["eveningEnabled", "eveningTime", "晚间总结"],
        ] as const).map(([enabled, time, label]) => <label key={enabled} className="space-y-2 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
          <span className="flex items-center justify-between"><span className="font-medium">{label}</span>
            <input type="checkbox" checked={!!config[enabled]} onChange={(e) => update({ [enabled]: e.target.checked ? 1 : 0 })} className="accent-indigo-600" /></span>
          <span className="flex items-center gap-2 text-zinc-500"><Clock3 size={13}/>
            <input type="time" value={config[time]} onChange={(e) => update({ [time]: e.target.value })} className="rounded-md border border-zinc-200 bg-transparent px-2 py-1 text-zinc-900 dark:border-zinc-700 dark:text-zinc-100" /></span>
        </label>)}
      </div>
      <label className="block text-xs font-medium">时区
        <input value={config.timezone} onChange={(e) => update({ timezone: e.target.value })} placeholder="Asia/Shanghai" className="mt-1 w-full rounded-md border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy} onClick={() => void run(async () => { setConfig(await taskDigestApi.save(config)); setMessage("简报设置已保存"); })} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">保存提醒设置</button>
        <button disabled={busy} onClick={() => void run(async () => { setPreview(await taskDigestApi.preview("morning")); })} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs"><Eye size={13}/>预览早间计划</button>
        <button disabled={busy} onClick={() => void run(async () => { setPreview(await taskDigestApi.preview("evening")); })} className="inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-xs"><Eye size={13}/>预览晚间总结</button>
      </div>
      {preview && <div className="rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
        <p className="font-semibold">{preview.date} · {preview.kind === "morning" ? "早间计划" : "晚间总结"}</p>
        <p className="mt-2">{preview.summary}</p>
        {preview.tasks.map((task) => <p key={task.taskId} className="mt-1 text-zinc-500">· {task.title}</p>)}
        <button disabled={busy} onClick={() => void run(async () => { await taskDigestApi.test(preview.kind); setMessage("已触发测试投递，请到 Webhook 投递记录检查结果"); })} className="mt-3 inline-flex items-center gap-1 text-indigo-600"><Send size={13}/>发送测试 Webhook</button>
      </div>}
      <div className="space-y-2 border-t border-zinc-200 pt-3 text-xs dark:border-zinc-800">
        <p className="font-semibold">推送目的地 <span className="font-normal text-zinc-500">· {webhookCount} 个已绑定</span></p>
        <p className="text-zinc-500">创建后仅订阅任务简报事件。URL 必须为公网 HTTPS 地址，请妥善保管包含密钥的 URL。</p>
        <div className="flex gap-2"><input aria-label="Webhook 接收地址" type="url" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://example.com/webhook" className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-transparent px-3 py-2 dark:border-zinc-700"/>
          <button disabled={busy || !webhookUrl.trim()} onClick={() => void run(async () => {
            const hook = await taskDigestApi.addWebhook(webhookUrl.trim());
            setWebhookCount((count) => count + 1);
            setWebhookUrl("");
            setNewSecret(hook.secret);
            setMessage("推送目的地绑定成功");
          })} className="rounded-md border px-3 py-2 font-medium disabled:opacity-50">绑定</button></div>
        {newSecret && <div className="rounded-md border border-amber-300 p-2 text-amber-700 dark:text-amber-300">接收端签名密钥仅显示一次：<code className="break-all">{newSecret}</code></div>}
      </div>
    </>}
    {message && <p role="status" className="flex items-center gap-1 text-xs text-emerald-600"><Check size={14}/>{message}</p>}
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </section>;
}
