import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { collaborationScope } from "@/lib/aiCollaboration";
import { confirm } from "@/components/ui/confirm";

export type PersonalSkill = Awaited<ReturnType<typeof api.aiPrompts.list>>["items"][number];
export default function PersonalSkillsEditor({ items, onChanged, scope }: { items: PersonalSkill[]; onChanged: (items: PersonalSkill[]) => void; scope: string }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState("");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = () => collaborationScope() === scope;
  const clear = () => { setEditing(""); setName(""); setPrompt(""); setError(""); };
  const save = async () => {
    if (busy || !current()) return;
    setBusy(true); setError("");
    try {
      const skill = editing ? await api.aiPrompts.update(editing, { name, prompt }) : await api.aiPrompts.create({ name, prompt });
      if (!current()) return;
      onChanged([...items.filter(item => item.id !== skill.id), skill]); clear();
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) setBusy(false); }
  };
  const remove = async (skill: PersonalSkill) => {
    if (busy || !await confirm({ title: t("aiCollaboration.deleteSkill", { name: skill.name }), danger: true }) || !current()) return;
    setBusy(true); setError("");
    try { await api.aiPrompts.remove(skill.id); if (current()) { onChanged(items.filter(item => item.id !== skill.id)); if (editing === skill.id) clear(); } }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (current()) setBusy(false); }
  };
  const field = "w-full min-w-0 rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary";
  return <details className="rounded-lg border border-app-border p-3">
    <summary className="cursor-pointer text-xs font-medium">{t("aiCollaboration.manageSkills")}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs text-tx-tertiary">{t("aiCollaboration.personalHint")}</p>
      <ul className="max-h-36 space-y-1 overflow-y-auto">{items.map(skill => <li key={skill.id} className="flex min-w-0 items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate">{skill.name}</span>
        <button disabled={busy} className="shrink-0 px-2 text-accent-primary" onClick={() => { setEditing(skill.id); setName(skill.name); setPrompt(skill.prompt); }}>{t("aiCollaboration.editSkill")}</button>
        <button disabled={busy} className="shrink-0 px-2 text-red-500" onClick={() => void remove(skill)}>{t("common.delete")}</button>
      </li>)}</ul>
      <label className="block space-y-1 text-xs">{t("aiCollaboration.skillName")}<input aria-label={t("aiCollaboration.skillName")} value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} className={field} /></label>
      <label className="block space-y-1 text-xs">{t("aiCollaboration.skillPrompt")}<textarea aria-label={t("aiCollaboration.skillPrompt")} value={prompt} maxLength={4000} rows={4} disabled={busy} onChange={event => setPrompt(event.target.value)} className={field} /></label>
      <label className="block text-xs text-accent-primary">{t("aiCollaboration.importSkill")}<input aria-label={t("aiCollaboration.importSkill")} className="mt-1 block max-w-full text-xs" type="file" accept=".md,.txt,text/plain,text/markdown" disabled={busy} onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        if (file.size > 20000) { setError(t("aiCollaboration.importLimit")); return; }
        const text = await file.text(); if (!current()) return;
        if (text.length > 4000) { setError(t("aiCollaboration.importLimit")); return; }
        setName((text.match(/^#\s+(.+)$/m)?.[1] || file.name.replace(/\.[^.]+$/, "")).slice(0, 80)); setPrompt(text); setEditing(""); setError("");
      }} /></label>
      {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
      <div className="flex flex-wrap gap-2"><button disabled={busy || !name.trim() || !prompt.trim()} onClick={() => void save()} className="rounded-md bg-accent-primary px-3 py-2 text-xs text-white disabled:opacity-40">{t(editing ? "aiCollaboration.updateSkill" : "aiCollaboration.addSkill")}</button>{editing && <button disabled={busy} onClick={clear} className="px-2 text-xs">{t("common.cancel")}</button>}</div>
    </div>
  </details>;
}
