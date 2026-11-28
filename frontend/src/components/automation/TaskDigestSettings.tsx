import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { BellRing, Check, Clock3, Eye, Pencil, Send, Trash2, X } from "lucide-react";
import { getEffectiveTimeZone } from "@/lib/dateTime";
import { taskDigestApi, type TaskDigestConfig, type TaskDigestPreview, type TaskDigestWebhook } from "@/lib/taskDigestApi";

const DIGEST_EVENTS = new Set(["task.digest.morning", "task.digest.evening", "task.due"]);

// Only manage dedicated task-digest destinations here. Generic "*" or
// multi-purpose subscriptions must never be edited/deleted by accident.
export function isDedicatedDigestWebhook(hook: Pick<TaskDigestWebhook, "events">): boolean {
  return hook.events.length > 0 && hook.events.every((event) => DIGEST_EVENTS.has(event));
}

function previewDestination(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    // Destinations may contain an authentication token in the query string.
    return `${url.origin}${url.pathname === "/" ? "" : "/•••"}${url.search ? "?•••" : ""}`;
  } catch {
    return "HTTPS Webhook";
  }
}

function validateDestination(rawUrl: string): string | null {
  if (rawUrl.length > 2048) return "接收地址过长";
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      return "接收地址必须为 HTTPS，且不能包含账号密码或片段";
    }
    return null;
  } catch {
    return "请输入有效的 HTTPS Webhook 接收地址";
  }
}

const defaultConfig: TaskDigestConfig = {
  userId: "", morningEnabled: 0, eveningEnabled: 0, dueEnabled: 0,
  morningTime: "09:00", eveningTime: "21:00",
  timezone: getEffectiveTimeZone() || "Asia/Shanghai",
};

export default function TaskDigestSettings() {
  const [config, setConfig] = useState<TaskDigestConfig>(defaultConfig);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhooks, setWebhooks] = useState<TaskDigestWebhook[]>([]);
  const [otherWebhookCount, setOtherWebhookCount] = useState(0);
  const [editingWebhookId, setEditingWebhookId] = useState<string | null>(null);
  const [editingWebhookUrl, setEditingWebhookUrl] = useState("");
  const [newSecret, setNewSecret] = useState("");
  const [preview, setPreview] = useState<TaskDigestPreview | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([taskDigestApi.get(), taskDigestApi.listWebhooks()]).then(([saved, hooks]) => {
      if (!active) return;
      setConfig(saved);
      setWebhooks(hooks.filter(isDedicatedDigestWebhook));
      setOtherWebhookCount(hooks.filter((hook) =>
        !isDedicatedDigestWebhook(hook) && (hook.events.includes("*") || hook.events.some((event) => DIGEST_EVENTS.has(event)))).length);
    }).catch((reason) => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const update = (values: Partial<TaskDigestConfig>) => setConfig((value) => ({ ...value, ...values }));
  const refreshWebhooks = async () => {
    const hooks = await taskDigestApi.listWebhooks();
    setWebhooks(hooks.filter(isDedicatedDigestWebhook));
    setOtherWebhookCount(hooks.filter((hook) =>
      !isDedicatedDigestWebhook(hook) && (hook.events.includes("*") || hook.events.some((event) => DIGEST_EVENTS.has(event)))).length);
  };
  const startEditing = (hook: TaskDigestWebhook) => {
    setEditingWebhookId(hook.id);
    setEditingWebhookUrl(hook.url);
    setError(""); setMessage("");
  };
  const saveEditedWebhook = async (hook: TaskDigestWebhook) => {
    const destination = editingWebhookUrl.trim();
    const validationError = validateDestination(destination);
    if (validationError) { setError(validationError); return; }
    if (webhooks.some((other) => other.id !== hook.id && other.url === destination)) {
      setError("此接收地址已经绑定"); return;
    }
    await run(async () => {
      await taskDigestApi.updateWebhook(hook.id, destination);
      await refreshWebhooks();
      setEditingWebhookId(null);
      setEditingWebhookUrl("");
      setMessage("推送地址已更新，签名密钥和事件订阅保持不变");
    });
  };
  const removeWebhook = async (hook: TaskDigestWebhook) => {
    if (!window.confirm("确认解绑这条推送地址？解绑后将停止向该地址发送任务简报，原投递记录也将删除。")) return;
    await run(async () => {
      await taskDigestApi.removeWebhook(hook.id);
      await refreshWebhooks();
      if (editingWebhookId === hook.id) { setEditingWebhookId(null); setEditingWebhookUrl(""); }
      setMessage("推送地址已解绑");
    });
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  return (
    <section
      className="space-y-4 rounded-2xl border border-app-border/80 bg-app-elevated/85 p-5 shadow-xs backdrop-blur-sm"
      aria-label="每日任务简报"
    >
      <div className="flex items-start gap-3">
        <motion.span
          whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
          transition={{ duration: 0.4 }}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 via-sky-400/18 to-violet-500/20 text-indigo-600 ring-1 ring-indigo-500/20 dark:text-indigo-300"
        >
          <BellRing size={18} />
        </motion.span>
        <div className="flex-1">
          <h3 className="text-sm font-bold text-tx-primary">每日任务简报</h3>
          <p className="mt-0.5 text-xs leading-5 text-tx-secondary">
            按你的时区统计个人待办，通过 HTTPS Webhook 推送早间计划和晚间进度。关闭客户端后，需要服务器持续运行。
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-tx-tertiary">正在加载配置…</p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {([
              ["morningEnabled", "morningTime", "早间计划"],
              ["eveningEnabled", "eveningTime", "晚间总结"],
            ] as const).map(([enabled, time, label]) => (
              <label key={enabled} className="space-y-2.5 rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5 text-xs transition-colors hover:border-indigo-400/35">
                <span className="flex items-center justify-between">
                  <span className="font-semibold text-tx-primary">{label}</span>
                  <input type="checkbox" checked={!!config[enabled]} onChange={(e) => update({ [enabled]: e.target.checked ? 1 : 0 })} className="accent-indigo-600" />
                </span>
                <span className="flex items-center gap-2 text-tx-secondary">
                  <Clock3 size={13} className="text-indigo-500" />
                  <input type="time" value={config[time]} onChange={(e) => update({ [time]: e.target.value })} className="rounded-xl border border-app-border/80 bg-app-bg px-2.5 py-1 text-tx-primary outline-none focus:border-accent-primary" />
                </span>
              </label>
            ))}
          </div>

          <label className="flex cursor-pointer items-start justify-between gap-3 rounded-xl border border-app-border/75 bg-app-surface/90 p-3.5 text-xs transition-colors hover:border-indigo-400/35">
            <span>
              <span className="font-semibold text-tx-primary">任务到点提醒</span>
              <span className="mt-1 block text-tx-secondary">按待办的精确截止时间推送，不包含仅指定日期的任务。</span>
            </span>
            <input type="checkbox" checked={!!config.dueEnabled} onChange={(e) => update({ dueEnabled: e.target.checked ? 1 : 0 })} className="mt-0.5 accent-indigo-600" />
          </label>

          <label className="block text-xs font-semibold text-tx-secondary">
            时区
            <input value={config.timezone} onChange={(e) => update({ timezone: e.target.value })} placeholder="Asia/Shanghai" className="mt-1.5 w-full rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 font-normal text-tx-primary outline-none focus:border-accent-primary" />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button disabled={busy} onClick={() => void run(async () => { setConfig(await taskDigestApi.save(config)); setMessage("简报设置已保存"); })} className="rounded-xl bg-gradient-to-r from-indigo-500 to-sky-500 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:brightness-105 active:scale-95 disabled:opacity-50">
              保存提醒设置
            </button>
            <button disabled={busy} onClick={() => void run(async () => { setPreview(await taskDigestApi.preview("morning")); })} className="inline-flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-xs font-medium text-tx-secondary transition-colors hover:border-accent-primary/35 hover:text-tx-primary">
              <Eye size={13} />预览早间计划
            </button>
            <button disabled={busy} onClick={() => void run(async () => { setPreview(await taskDigestApi.preview("evening")); })} className="inline-flex items-center gap-1.5 rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-xs font-medium text-tx-secondary transition-colors hover:border-accent-primary/35 hover:text-tx-primary">
              <Eye size={13} />预览晚间总结
            </button>
          </div>

          {preview && (
            <div className="rounded-xl border border-indigo-400/25 bg-indigo-500/[0.05] p-3.5 text-xs">
              <p className="font-bold text-tx-primary">{preview.date} · {preview.kind === "morning" ? "早间计划" : "晚间总结"}</p>
              <p className="mt-1.5 text-tx-secondary">{preview.summary}</p>
              {preview.tasks.map((task) => <p key={task.taskId} className="mt-1 text-tx-tertiary">· {task.title}</p>)}
              <button disabled={busy} onClick={() => void run(async () => { await taskDigestApi.test(preview.kind); setMessage("已触发测试投递，请到 Webhook 投递记录检查结果"); })} className="mt-3 inline-flex items-center gap-1 font-semibold text-indigo-600 hover:underline dark:text-indigo-300">
                <Send size={13} />发送测试 Webhook
              </button>
            </div>
          )}

          <div className="space-y-3 border-t border-app-border/70 pt-3.5 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-bold text-tx-primary">推送目的地</p>
              <span className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-300">
                {webhooks.length} 个专用绑定
              </span>
            </div>
            <p className="text-tx-secondary">绑定地址必须为公网 HTTPS。列表隐藏 URL 中的密钥参数；修改地址会保留原签名密钥及订阅事件。</p>
            <p className="text-tx-tertiary">PushPlus 用户可直接填入 <code className="break-all rounded bg-app-hover px-1 py-0.5">https://www.pushplus.plus/send/你的Token?template=json</code>。该地址会自动将早晚简报、到点提醒整理为中文 JSON 消息；其他 Webhook 不受影响。请勿在截图或公开日志中泄露 Token。</p>
            {webhooks.length === 0 ? (
              <p className="rounded-xl border border-dashed border-app-border/80 bg-app-bg/50 p-3.5 text-tx-tertiary">尚未绑定任务简报的专用接收地址。</p>
            ) : (
              <ul className="space-y-2" aria-label="已绑定的任务简报推送地址">
                {webhooks.map((hook) => (
                  <li key={hook.id} className="min-w-0 rounded-xl border border-app-border/75 bg-app-surface/90 p-3">
                    {editingWebhookId === hook.id ? (
                      <div className="space-y-2">
                        <label className="block font-semibold text-tx-primary" htmlFor={`digest-edit-${hook.id}`}>修改接收地址</label>
                        <input
                          id={`digest-edit-${hook.id}`}
                          aria-label="修改 Webhook 接收地址"
                          type="url"
                          value={editingWebhookUrl}
                          onChange={(event) => setEditingWebhookUrl(event.target.value)}
                          className="w-full min-w-0 rounded-xl border border-app-border bg-app-bg px-3 py-2 outline-none focus:border-accent-primary"
                        />
                        <div className="flex flex-wrap gap-2">
                          <button type="button" disabled={busy || !editingWebhookUrl.trim() || editingWebhookUrl.trim() === hook.url}
                            onClick={() => void saveEditedWebhook(hook)}
                            className="rounded-xl bg-indigo-600 px-3 py-1.5 font-semibold text-white disabled:opacity-50">保存修改</button>
                          <button type="button" disabled={busy}
                            onClick={() => { setEditingWebhookId(null); setEditingWebhookUrl(""); setError(""); }}
                            className="inline-flex items-center gap-1 rounded-xl border border-app-border px-3 py-1.5 text-tx-secondary"><X size={13} />取消</button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="break-all font-mono text-tx-primary" title="URL 中的密钥参数已隐藏">{previewDestination(hook.url)}</p>
                          <p className="mt-1 text-tx-tertiary">{hook.isActive === 0 ? "已停用" : "已启用"} · 任务简报</p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <button type="button" disabled={busy} onClick={() => startEditing(hook)}
                            aria-label={`修改推送地址 ${previewDestination(hook.url)}`}
                            className="inline-flex items-center gap-1 rounded-xl border border-app-border/80 bg-app-elevated px-2.5 py-1.5 font-medium text-tx-secondary transition-colors hover:text-tx-primary disabled:opacity-50"><Pencil size={13} />修改</button>
                          <button type="button" disabled={busy} onClick={() => void removeWebhook(hook)}
                            aria-label={`解绑推送地址 ${previewDestination(hook.url)}`}
                            className="inline-flex items-center gap-1 rounded-xl border border-rose-500/30 bg-rose-500/8 px-2.5 py-1.5 font-medium text-rose-600 transition-colors hover:bg-rose-500/16 disabled:opacity-50 dark:text-rose-300"><Trash2 size={13} />解绑</button>
                        </div>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {otherWebhookCount > 0 && (
              <p className="text-tx-tertiary">
                另有 {otherWebhookCount} 个通用或混合事件 Webhook 可接收简报；为避免影响其他事件，不能在本面板修改或解绑。
              </p>
            )}
            <div className="flex min-w-0 flex-wrap gap-2">
              <input aria-label="Webhook 接收地址" type="url" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://example.com/webhook" className="min-w-0 flex-[1_1_210px] rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 outline-none focus:border-accent-primary" />
              <button type="button" disabled={busy || !webhookUrl.trim()} onClick={() => {
                const url = webhookUrl.trim();
                const invalid = validateDestination(url);
                if (invalid) { setError(invalid); return; }
                if (webhooks.some((hook) => hook.url === url)) { setError("此接收地址已经绑定"); return; }
                void run(async () => {
                  const created = await taskDigestApi.addWebhook(url);
                  await refreshWebhooks();
                  setWebhookUrl("");
                  setNewSecret(created.secret);
                  setMessage("推送目的地绑定成功");
                });
              }} className="rounded-xl border border-indigo-400/35 bg-indigo-500/10 px-3.5 py-2 font-semibold text-indigo-600 transition-colors hover:bg-indigo-500/18 disabled:opacity-50 dark:text-indigo-300">绑定新地址</button>
            </div>
            {newSecret && (
              <div className="rounded-xl border border-amber-400/40 bg-amber-500/[0.08] p-3 text-amber-800 dark:text-amber-200">
                <p>接收端签名密钥仅显示一次，请妥善保存：</p>
                <code className="mt-1 block break-all rounded-lg bg-app-surface/80 px-2 py-1">{newSecret}</code>
                <button type="button" className="mt-2 font-semibold underline" onClick={() => setNewSecret("")}>我已保存</button>
              </div>
            )}
          </div>
        </>
      )}
      {message && <p role="status" className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"><Check size={14} />{message}</p>}
      {error && <p role="alert" className="text-xs font-medium text-rose-600 dark:text-rose-400">{error}</p>}
    </section>
  );
}
