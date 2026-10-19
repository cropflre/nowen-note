import { useEffect, useRef, useState } from "react";
import { Bot, Clock3, RotateCcw, Send, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pluginApi } from "@/lib/pluginApi";
import type { StudioApp, StudioSpec, StudioVersion } from "@/lib/personalApps";

const copy = {
  zh: {
    ai: "AI 创建应用", modify: "AI 修改应用", helper: "描述你想要的应用，AI 会先生成草稿。确认满意后，再点击“保存应用”。",
    external: "仅将需求与字段结构发送给你已配置的 AI 服务，不会发送记录内容、笔记或密钥。",
    placeholder: "例如：做一个用于跟踪开源项目开发进度的看板，包含任务、优先级和完成状态",
    example: "创建项目进度看板", improve: "增加一个负责人字段，并改成卡片布局",
    generate: "生成草稿", generating: "正在生成…", accept: "应用此草稿", discard: "放弃草稿",
    preview: "AI 方案预览", saved: "AI 草稿尚未保存，不会覆盖现有数据",
    error: "AI 生成失败。请检查模型配置或尝试更具体的描述。",
    noAI: "请先在 AI 设置中配置模型后重试；也可以继续使用下方零代码模板。",
    invalid: "模型返回了不兼容的应用结构。请重新描述，已有数据没有变化。",
    destructive: "为了保护已有记录，AI 不能删除或更改现有字段类型。你可以通过可视化编辑器手动调整。",
    busy: "请求过于频繁，请稍后重试。", history: "版本历史", historyEmpty: "暂无已保存的历史版本",
    restore: "恢复此版本", restoreConfirm: "确认恢复这个历史版本吗？它将恢复当时的字段和记录，并保存为一个新版本。未保存的编辑会丢失。",
    latest: "当前版本", record: "条记录", field: "个字段", restored: "已恢复", restoreFailed: "恢复失败，可能当前版本已被其他设备修改，请刷新后重试。",
  },
  en: {
    ai: "AI App Builder", modify: "Edit with AI", helper: "Describe an app. Review the proposed design, then Save app to persist it.",
    external: "Only your request and field structure go to the configured AI provider—not records, notes, or API keys.",
    placeholder: "For example: a project board with tasks, priorities, owners and completion status",
    example: "Create a project tracker", improve: "Add an owner field and switch to cards",
    generate: "Generate preview", generating: "Generating…", accept: "Use this draft", discard: "Discard",
    preview: "AI draft", saved: "This is a preview; it will not overwrite saved data until you save.",
    error: "Could not generate a draft. Check your AI settings or refine the request.",
    noAI: "Configure an AI model in AI settings first, or use a no-code template.",
    invalid: "The provider returned an unsupported app design. Nothing was changed.",
    destructive: "AI cannot remove or retype existing fields. Edit them manually to protect records.",
    busy: "Too many requests; retry shortly.", history: "Version history", historyEmpty: "No saved versions yet",
    restore: "Restore version", restoreConfirm: "Restore this version, including its fields and records? Unsaved edits will be lost. A new revision will be created.",
    latest: "Current", record: "records", field: "fields", restored: "Restored", restoreFailed: "Restore failed, possibly because another device saved changes. Refresh and retry.",
  },
};
const action = "rounded-lg border border-app-border px-3 py-2 text-sm hover:bg-app-hover disabled:opacity-50";
const primary = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50";
function useLabels() { const { i18n } = useTranslation(); return i18n.language.startsWith("zh") ? copy.zh : copy.en; }

export function PersonalStudioAI({ spec, onAccept }: { spec: StudioSpec | null; onAccept: (proposal: StudioSpec) => void }) {
  const t = useLabels();
  const [prompt, setPrompt] = useState("");
  const [proposal, setProposal] = useState<StudioSpec | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setProposal(null);
    return () => request.current?.abort();
  }, [spec]);
  useEffect(() => {
    const cancel = () => { request.current?.abort(); setProposal(null); };
    window.addEventListener("nowen:token-changed", cancel);
    window.addEventListener("nowen:workspace-changed", cancel);
    return () => { request.current?.abort(); window.removeEventListener("nowen:token-changed", cancel); window.removeEventListener("nowen:workspace-changed", cancel); };
  }, []);
  const generate = async () => {
    if (!prompt.trim() || busy) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError(""); setProposal(null);
    try {
      const result = await pluginApi.previewPersonalAppAI(prompt.trim(), spec || undefined, controller.signal);
      if (request.current === controller && !controller.signal.aborted) setProposal(result.spec);
    } catch (err) {
      if (!controller.signal.aborted) {
        const code = (err as { code?: string }).code || "";
        setError(code === "STUDIO_AI_NOT_CONFIGURED" || code === "STUDIO_AI_UNAVAILABLE" ? t.noAI
          : code === "STUDIO_AI_DESTRUCTIVE_CHANGE" ? t.destructive
          : code === "STUDIO_AI_INVALID_OUTPUT" ? t.invalid
          : code === "STUDIO_AI_RATE_LIMIT" || code === "STUDIO_AI_BUSY" ? t.busy : t.error);
      }
    } finally {
      if (request.current === controller) { setBusy(false); request.current = null; }
    }
  };
  return <section aria-label={t.ai} className="space-y-3 rounded-2xl border border-accent-primary/30 bg-app-surface p-4">
    <div className="flex items-center gap-2"><Sparkles size={18} className="text-accent-primary"/><h2 className="font-semibold">{spec ? t.modify : t.ai}</h2></div>
    <p className="text-sm text-tx-secondary">{t.helper}</p>
    <label className="block">
      <span className="sr-only">{t.ai}</span>
      <textarea aria-label={t.ai} value={prompt} maxLength={1200} rows={3} className="w-full rounded-lg border border-app-border bg-app-surface p-3 text-sm focus:outline-none focus:ring-2 focus:ring-accent-primary/30" placeholder={spec ? t.improve : t.placeholder} onChange={e=>setPrompt(e.target.value)}/>
    </label>
    <div className="flex items-center justify-between gap-2">
      <p className="text-xs text-tx-secondary">{t.external}</p>
      <button type="button" disabled={busy || !prompt.trim()} className={primary} onClick={() => void generate()}><Send size={15}/>{busy?t.generating:t.generate}</button>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-500">{error}</p>}
    {proposal && <div className="space-y-3 rounded-xl border border-app-border p-3" role="region" aria-label={t.preview}>
      <div className="flex items-center gap-2"><Bot size={16}/><strong>{proposal.name}</strong></div>
      <p className="text-sm text-tx-secondary">{proposal.description}</p>
      <div className="flex flex-wrap gap-2">{proposal.fields.map(field=><span key={field.id} className="rounded-full border border-app-border px-2 py-1 text-xs">{field.label} · {field.type}</span>)}</div>
      <p className="text-xs text-tx-secondary">{t.saved}</p>
      <div className="flex justify-end gap-2">
        <button type="button" className={action} onClick={()=>setProposal(null)}>{t.discard}</button>
        <button type="button" className={primary} onClick={()=>{onAccept(proposal);setProposal(null);setPrompt("");}}>{t.accept}</button>
      </div>
    </div>}
  </section>;
}

export function PersonalStudioVersionHistory({ app, onRestored }: { app: StudioApp; onRestored: (app: StudioApp) => void }) {
  const t = useLabels();
  const [versions, setVersions] = useState<StudioVersion[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setVersions([]); setError("");
    void pluginApi.personalAppVersions(app.id).then(items => { if(active) setVersions(items); })
      .catch(()=>{ if(active) setError(t.restoreFailed); });
    return () => { active = false; };
  }, [app.id, app.revision]);
  const restore = async (revision: number) => {
    if (busy || !window.confirm(t.restoreConfirm)) return;
    setBusy(true); setError("");
    try {
      const next = await pluginApi.restorePersonalApp(app.id, revision, app.revision);
      setVersions([]); onRestored(next);
    } catch { setError(t.restoreFailed); }
    finally { setBusy(false); }
  };
  return <details className="rounded-xl border border-app-border bg-app-surface p-4">
    <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium"><Clock3 size={16}/>{t.history}</summary>
    {error && <p role="alert" className="mt-2 text-sm text-red-500">{error}</p>}
    {versions.length===0 ? <p className="mt-3 text-xs text-tx-secondary">{t.historyEmpty}</p> :
      <ol className="mt-3 space-y-2">{versions.map(v=><li key={v.revision} className="flex items-center justify-between gap-2 rounded-lg border border-app-border p-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">v{v.revision} · {v.name}</p>
          <p className="text-xs text-tx-secondary">{v.fieldCount} {t.field} · {v.itemCount} {t.record} · {new Date(v.createdAt).toLocaleString()}</p>
        </div>
        {v.revision===app.revision ? <span className="shrink-0 text-xs text-tx-secondary">{t.latest}</span> :
          <button type="button" disabled={busy} className={action+" inline-flex shrink-0 items-center gap-1"} onClick={()=>void restore(v.revision)}><RotateCcw size={13}/>{t.restore}</button>}
      </li>)}</ol>}
  </details>;
}
