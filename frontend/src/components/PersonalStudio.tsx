import { useEffect, useState } from "react";
import { ArrowLeft, Check, LayoutGrid, List, Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { pushAppPathState } from "@/lib/appPathNavigation";
import { pluginApi } from "@/lib/pluginApi";
import { addStudioField, addStudioItem, removeStudioField, updateStudioItem, newStudioId, newStudioSpec, type StudioApp, type StudioField, type StudioSpec, type StudioTemplate } from "@/lib/personalApps";

const UI = {
  zh: { back: "返回我的应用", create: "创建自己的应用", template: "选择一个模板开始，无需编写代码", checklist: "待办清单", records: "个人资料库", tracker: "项目进度板", edit: "可视化编辑", name: "应用名称", description: "用途说明", layout: "展示方式", list: "列表", board: "卡片", fields: "记录字段", field: "新字段名称", text: "文本", checkbox: "勾选", addField: "添加字段", preview: "实时预览", save: "保存应用", saving: "正在保存…", saved: "保存成功", error: "操作失败，请核对数据后重试。若出现版本冲突，请刷新页面后检查最新内容。", addRecord: "添加记录", empty: "还没有记录，试着添加第一条", deleted: "删除应用", deleteConfirm: "确定删除这个应用及全部记录吗？删除后无法恢复。", editApp: "编辑应用", personal: "仅自己可见 · 保存在当前服务器，暂不参与 Sync V2 离线同步", count: "最多 8 个字段、100 条记录", noCode: "安全声明式应用：不会运行自定义 JavaScript，也不会自动访问 Nowen 笔记或任务", view: "打开应用", busy: "正在加载…", failed: "无法加载应用，请重新登录或重试", remove: "删除", close: "取消", required: "请填写应用名称与字段名称", limit: "字段已达上限", maxItems: "记录已达上限" },
  en: { back: "Back to my apps", create: "Create your own app", template: "Choose a template—no coding needed", checklist: "Checklist", records: "Personal records", tracker: "Project tracker", edit: "Visual editor", name: "App name", description: "Description", layout: "Layout", list: "List", board: "Cards", fields: "Fields", field: "New field", text: "Text", checkbox: "Checkbox", addField: "Add field", preview: "Live preview", save: "Save app", saving: "Saving…", saved: "Saved", error: "Could not save. If another device changed this app, reload and review its latest version.", addRecord: "Add record", empty: "No records yet—add your first one", deleted: "Delete app", deleteConfirm: "Delete this app and all its records permanently?", editApp: "Edit app", personal: "Private to your account · Saved on this server; offline Sync V2 is not supported", count: "Up to 8 fields and 100 records", noCode: "Declarative app: no custom JavaScript or access to your Nowen notes/tasks", view: "Open app", busy: "Loading…", failed: "Unable to load the app. Sign in again or retry.", remove: "Remove", close: "Cancel", required: "Enter an app and field name", limit: "Field limit reached", maxItems: "Record limit reached" },
} as const;
function useCopy() { const { i18n } = useTranslation(); return i18n.language.startsWith("zh") ? UI.zh : UI.en; }
const inputClass = "w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary focus:outline-none focus:ring-2 focus:ring-accent-primary/40";
const actionClass = "rounded-lg border border-app-border px-3 py-2 text-sm hover:bg-app-hover disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass = "inline-flex items-center justify-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50";

export function StudioSpecPreview({ spec, onChange, disabled = false }: { spec: StudioSpec; onChange?: (next: StudioSpec) => void; disabled?: boolean }) {
  const t = useCopy();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const commit = (next: StudioSpec) => { if (!disabled) onChange?.(next); };
  const add = () => {
    if (!onChange || disabled || spec.items.length >= 100) return;
    commit(addStudioItem(spec, draft, newStudioId()));
    setDraft({});
  };
  return <div className="space-y-4">
    <header className="space-y-1"><h2 className="text-lg font-semibold text-tx-primary">{spec.name || "Untitled"}</h2><p className="text-sm text-tx-secondary">{spec.description}</p></header>
    {onChange && <div className="rounded-xl border border-app-border p-3">
      <div className="grid gap-2 sm:grid-cols-2">{spec.fields.map(field => <label key={field.id} className="block text-xs text-tx-secondary">{field.label}
        {field.type === "checkbox" ? <input className="ml-2 mt-2" type="checkbox" checked={draft[field.id] === true} onChange={e => setDraft(v => ({ ...v, [field.id]: e.target.checked }))} /> :
          <input className={inputClass + " mt-1"} maxLength={240} value={String(draft[field.id] || "")} onChange={e => setDraft(v => ({ ...v, [field.id]: e.target.value }))} />}
      </label>)}</div>
      <button type="button" onClick={add} disabled={disabled || spec.items.length >= 100} className={primaryClass + " mt-3"}><Plus size={15}/>{t.addRecord}</button>
    </div>}
    <div className={spec.layout === "board" ? "grid gap-3 sm:grid-cols-2 xl:grid-cols-3" : "space-y-2"}>
      {spec.items.map(item => <div key={item.id} className="flex items-start justify-between gap-2 rounded-xl border border-app-border bg-app-surface p-3">
        <div className="min-w-0 flex-1 space-y-2">{spec.fields.map(field => <div key={field.id} className="text-sm">
          {field.type === "checkbox" ? <label className="flex items-center gap-2"><input type="checkbox" disabled={!onChange || disabled} checked={item.values[field.id] === true} onChange={e => commit(updateStudioItem(spec, item.id, field.id, e.target.checked))}/><span>{field.label}</span></label>
            : <div><span className="text-xs text-tx-secondary">{field.label}</span><p className="break-words text-tx-primary">{String(item.values[field.id] || "—")}</p></div>}
        </div>)}</div>
        {onChange && <button type="button" className="rounded p-1 text-tx-secondary hover:text-red-500" aria-label={pendingDelete === item.id ? t.remove + "?" : t.remove} disabled={disabled} onClick={() => {
          if (pendingDelete !== item.id) { setPendingDelete(item.id); return; }
          commit({ ...spec, items: spec.items.filter(row => row.id !== item.id) }); setPendingDelete(null);
        }}><Trash2 size={15}/>{pendingDelete === item.id && <span className="ml-1 text-xs">{t.remove}?</span>}</button>}
      </div>)}
    </div>
    {spec.items.length === 0 && <p className="rounded-xl border border-dashed border-app-border p-8 text-center text-sm text-tx-secondary">{t.empty}</p>}
    <p className="text-xs text-tx-secondary">{spec.items.length}/100</p>
  </div>;
}

export function PersonalStudio({ appId }: { appId?: string }) {
  const t = useCopy();
  const [spec, setSpec] = useState<StudioSpec | null>(null);
  const [app, setApp] = useState<StudioApp | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [newField, setNewField] = useState("");
  const [newType, setNewType] = useState<StudioField["type"]>("text");
  const [loading, setLoading] = useState(Boolean(appId));
  useEffect(() => {
    if (!appId) return;
    let active = true;
    setLoading(true); setError(""); setSpec(null);
    void pluginApi.personalApp(appId).then(value => { if (active) { setApp(value); setSpec(value.spec); } }).catch(() => { if (active) setError(t.failed); }).finally(() => { if (active) setLoading(false); });
    const leave = () => { active = false; setSpec(null); pushAppPathState("/apps"); };
    window.addEventListener("nowen:token-changed", leave);
    return () => { active = false; window.removeEventListener("nowen:token-changed", leave); };
  }, [appId]);
  const save = async () => {
    if (!spec || !spec.name.trim() || spec.fields.some(f => !f.label.trim())) { setError(t.required); return; }
    setBusy(true); setError("");
    try {
      const result = app ? await pluginApi.updatePersonalApp(app.id, app.revision, spec) : await pluginApi.createPersonalApp(spec);
      setApp(result); setSpec(result.spec); pushAppPathState("/apps/personal/" + result.id);
    } catch (e) { setError(e instanceof Error ? e.message : t.error); }
    finally { setBusy(false); }
  };
  if (loading) return <div role="status" className="p-8">{t.busy}</div>;
  if (!spec) return <section className="mx-auto max-w-4xl space-y-5 p-4 sm:p-8">
    <button className={actionClass} onClick={() => pushAppPathState("/apps")}><ArrowLeft size={15} className="inline"/> {t.back}</button>
    <div><h1 className="text-2xl font-semibold">{t.create}</h1><p className="mt-2 text-sm text-tx-secondary">{t.template}</p></div>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {!appId && <div className="grid gap-3 sm:grid-cols-3">{(["checklist","records","tracker"] as StudioTemplate[]).map(template => <button type="button" key={template} className="min-h-32 rounded-2xl border border-app-border bg-app-surface p-5 text-left hover:border-accent-primary hover:bg-app-hover" onClick={() => { setSpec(newStudioSpec(template)); setError(""); }}>
      <LayoutGrid size={24} className="mb-4 text-accent-primary"/><strong className="block">{t[template]}</strong><span className="mt-2 block text-xs text-tx-secondary">{newStudioSpec(template).description}</span>
    </button>)}</div>}
  </section>;
  return <section className="mx-auto w-full max-w-6xl space-y-5 p-4 pb-14 sm:p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><button className={actionClass} onClick={() => pushAppPathState(app ? "/apps/personal/" + app.id : "/apps")}><ArrowLeft size={15} className="inline"/> {t.back}</button><div className="flex items-center gap-2"><span className="text-xs text-tx-secondary">{t.personal}</span><button className={primaryClass} disabled={busy} onClick={() => void save()}><Save size={16}/>{busy ? t.saving : t.save}</button></div></div>
    <div><h1 className="text-xl font-semibold">{t.edit}</h1><p className="mt-1 text-sm text-tx-secondary">{t.noCode}</p></div>
    {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-500">{error}</p>}
    <div className="grid gap-5 lg:grid-cols-[minmax(0,380px)_1fr]">
      <div className="space-y-4 rounded-2xl border border-app-border bg-app-surface p-4">
        <label className="block text-sm">{t.name}<input className={inputClass + " mt-1"} maxLength={64} value={spec.name} onChange={e => setSpec(s => s ? { ...s, name: e.target.value } : s)} /></label>
        <label className="block text-sm">{t.description}<textarea className={inputClass + " mt-1"} maxLength={200} rows={2} value={spec.description} onChange={e => setSpec(s => s ? { ...s, description: e.target.value } : s)} /></label>
        <fieldset><legend className="mb-2 text-sm">{t.layout}</legend><div className="flex gap-2">
          {(["list","board"] as const).map(layout => <button type="button" key={layout} aria-pressed={spec.layout === layout} className={actionClass + (spec.layout === layout ? " border-accent-primary text-accent-primary" : "")} onClick={() => setSpec(s => s ? { ...s, layout } : s)}>{layout === "list" ? <List size={14} className="mr-1 inline"/> : <LayoutGrid size={14} className="mr-1 inline"/>}{t[layout]}</button>)}</div></fieldset>
        <div><h2 className="font-medium">{t.fields}</h2><p className="mb-2 text-xs text-tx-secondary">{t.count}</p>
          <div className="space-y-2">{spec.fields.map(field => <div key={field.id} className="flex items-center gap-2">
            <input aria-label={t.fields + " " + field.id} className={inputClass} maxLength={40} value={field.label} onChange={e => setSpec(s => s ? { ...s, fields: s.fields.map(f => f.id === field.id ? { ...f, label: e.target.value } : f) } : s)}/>
            <span className="shrink-0 text-xs text-tx-secondary">{t[field.type]}</span>
            <button type="button" className="rounded p-2 text-tx-secondary hover:text-red-500 disabled:opacity-30" disabled={spec.fields.length <= 1} aria-label={t.remove + " " + field.label} onClick={() => setSpec(s => s ? removeStudioField(s, field.id) : s)}><Trash2 size={15}/></button>
          </div>)}</div>
          <div className="mt-3 flex flex-wrap gap-2"><input aria-label={t.field} placeholder={t.field} maxLength={40} className={inputClass + " min-w-0 flex-1"} value={newField} onChange={e => setNewField(e.target.value)}/>
            <select className={actionClass} value={newType} onChange={e => setNewType(e.target.value as StudioField["type"])}><option value="text">{t.text}</option><option value="checkbox">{t.checkbox}</option></select>
            <button className={actionClass} disabled={!newField.trim() || spec.fields.length >= 8} onClick={() => { setSpec(s => s ? addStudioField(s, newField, newType, "f_" + newStudioId().slice(0, 8)) : s); setNewField(""); }}><Plus size={15} className="inline"/> {t.addField}</button>
          </div>
        </div>
      </div>
      <div className="min-w-0 space-y-3 rounded-2xl border border-app-border bg-app-surface p-4">
        <div className="flex items-center gap-2 text-sm font-medium"><Check size={15} className="text-accent-primary"/>{t.preview}</div>
        <StudioSpecPreview key={app?.id || "draft"} spec={spec} onChange={setSpec}/>
      </div>
    </div>
  </section>;
}

export function PersonalStudioRuntime({ appId }: { appId: string }) {
  const t = useCopy();
  const [app, setApp] = useState<StudioApp | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setApp(null); setError("");
    void pluginApi.personalApp(appId).then(result => { if (active) setApp(result); }).catch(() => { if (active) setError(t.failed); });
    const leave = () => { active = false; setApp(null); pushAppPathState("/apps"); };
    window.addEventListener("nowen:token-changed", leave);
    return () => { active = false; window.removeEventListener("nowen:token-changed", leave); };
  }, [appId]);
  const change = async (spec: StudioSpec) => {
    if (!app || busy) return;
    setBusy(true); setError("");
    try { setApp(await pluginApi.updatePersonalApp(app.id, app.revision, spec)); }
    catch { setError(t.error); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!app || busy || !window.confirm(t.deleteConfirm)) return;
    setBusy(true);
    try { await pluginApi.deletePersonalApp(app.id, app.revision); pushAppPathState("/apps"); }
    catch { setError(t.error); }
    finally { setBusy(false); }
  };
  if (!app) return <div role={error ? "alert" : "status"} className="p-8">{error || t.busy}</div>;
  return <section className="mx-auto w-full max-w-5xl space-y-5 p-4 pb-16 sm:p-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><button className={actionClass} onClick={() => pushAppPathState("/apps")}><ArrowLeft size={15} className="inline"/> {t.back}</button><div className="flex gap-2">
      <button className={actionClass} onClick={() => pushAppPathState("/apps/studio/" + app.id)}><Pencil size={14} className="mr-1 inline"/>{t.editApp}</button>
      <button className={actionClass} disabled={busy} onClick={() => void remove()}><Trash2 size={14} className="mr-1 inline"/>{t.deleted}</button>
    </div></div>
    <p className="text-xs text-tx-secondary">{t.personal}</p>
    {error && <p role="alert" className="rounded-lg bg-red-500/10 p-3 text-sm text-red-500">{error}</p>}
    <StudioSpecPreview spec={app.spec} onChange={change} disabled={busy}/>
  </section>;
}


export function PersonalStudioLibrary() {
  const t = useCopy();
  const [apps, setApps] = useState<StudioApp[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true, revision = 0;
    const load = () => {
      const request = ++revision;
      setLoading(true); setApps([]); setError("");
      void pluginApi.personalApps().then(items => {
        if (active && revision === request) setApps(items);
      }).catch(() => {
        if (active && revision === request) setError(t.failed);
      }).finally(() => {
        if (active && revision === request) setLoading(false);
      });
    };
    const reset = () => { revision++; setApps([]); load(); };
    load();
    window.addEventListener("nowen:token-changed", reset);
    return () => { active = false; revision++; window.removeEventListener("nowen:token-changed", reset); };
  }, []);
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="text-lg font-semibold">{t.create}</h2><p className="text-xs text-tx-secondary">{t.personal}</p></div>
      <button type="button" className={primaryClass} onClick={() => pushAppPathState("/apps/studio")}><Plus size={16}/>{t.create}</button>
    </div>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
    {loading ? <p role="status" className="text-sm text-tx-secondary">{t.busy}</p> : apps.length > 0 ? (
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {apps.map(app => <li key={app.id} className="rounded-xl border border-app-border bg-app-surface p-4">
          <button className="block w-full text-left" onClick={() => pushAppPathState("/apps/personal/" + app.id)} aria-label={app.spec.name}>
            <div className="flex items-center gap-2"><LayoutGrid size={18} className="text-accent-primary"/><strong className="truncate">{app.spec.name}</strong></div>
            <p className="mt-2 line-clamp-2 text-sm text-tx-secondary">{app.spec.description || t.noCode}</p>
            <p className="mt-2 text-xs text-tx-secondary">{app.spec.items.length} / 100</p>
          </button>
          <div className="mt-3 flex justify-end gap-2">
            <button className={actionClass} onClick={() => pushAppPathState("/apps/studio/" + app.id)}><Pencil size={14} className="mr-1 inline"/>{t.editApp}</button>
            <button className={actionClass} onClick={() => pushAppPathState("/apps/personal/" + app.id)}>{t.view}</button>
          </div>
        </li>)}
      </ul>
    ) : <button type="button" onClick={() => pushAppPathState("/apps/studio")} className="flex min-h-28 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-app-border text-sm text-tx-secondary hover:bg-app-hover"><Plus size={18}/>{t.template}</button>}
  </section>;
}
