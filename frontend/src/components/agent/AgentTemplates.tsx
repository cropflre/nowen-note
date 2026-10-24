import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { getTaskComposerContext, isTaskComposerContextCurrent } from "@/lib/taskComposerApi";
import type { AgentTemplate, AgentTemplateConfig, AgentExtension, AgentConnection, AgentAutomation } from "@/lib/agentTemplates";
import type { Notebook } from "@/types";
import { Button } from "@/components/ui/button";

const fieldClass = "block w-full rounded border border-app-border bg-app-bg p-2 text-sm";
export default function AgentTemplates({ workspaceId, books, onUse }: { workspaceId: string; books: Notebook[]; onUse: (value: AgentTemplate) => void }) {
  const { t, i18n } = useTranslation();
  const [context] = useState(getTaskComposerContext), alive = useRef(true), locked = useRef(false);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]), [tools, setTools] = useState<AgentExtension[]>([]), [connections, setConnections] = useState<AgentConnection[]>([]);
  const [automations, setAutomations] = useState<AgentAutomation[]>([]), [prompts, setPrompts] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<AgentTemplate | null>(null);
  const empty = (): AgentTemplateConfig => ({ name: "", input: { notebookId: books[0]?.id || "", instruction: "", includeChildren: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, lang: i18n.language.startsWith("zh") ? "zh-CN" : "en" }, allowNote: false, allowTasks: false, toolIds: [] });
  const [draft, setDraft] = useState(empty), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [connectionName, setConnectionName] = useState(""), [url, setUrl] = useState(""), [token, setToken] = useState(""), [names, setNames] = useState("");
  const [trigger, setTrigger] = useState("daily"), [time, setTime] = useState("09:00"), [weekday, setWeekday] = useState("1"), [event, setEvent] = useState("note.created");
  const [credentials, setCredentials] = useState("");
  const current = useCallback(() => alive.current && isTaskComposerContextCurrent(context), [context]);
  const read = useCallback(<T,>(path: string, method = "GET", body?: unknown) => api.agentLibrary.request<T>(workspaceId, path, method, body), [workspaceId]);
  const refresh = useCallback(async () => {
    const [list, catalog, links, jobs, savedPrompts] = await Promise.all([read<AgentTemplate[]>("/templates"), read<AgentExtension[]>("/tools"), read<AgentConnection[]>("/connections"), read<AgentAutomation[]>("/automations"), read<Array<{ id: string; name: string }>>("/prompts")]);
    if (current()) { setTemplates(list); setTools(catalog); setConnections(links); setAutomations(jobs); setPrompts(savedPrompts); }
  }, [read, current]);
  const displayError = useCallback((error: unknown) => t(`agent.errors.${(error as { code?: string }).code || (error as Error).message}`, { defaultValue: t("agent.errors.AGENT_REQUEST_FAILED") }), [t]);
  useEffect(() => { alive.current = true; void refresh().catch(e => { if (current()) setError(displayError(e)); }); return () => { alive.current = false; }; }, [refresh, current, displayError]);
  async function perform(action: () => Promise<void>) {
    if (locked.current || !current()) return;
    locked.current = true; setBusy(true); setError("");
    try { await action(); if (current()) await refresh(); }
    catch (e) { if (current()) setError(displayError(e)); }
    finally { locked.current = false; if (current()) setBusy(false); }
  }
  function choose(template: AgentTemplate | null) { setSelected(template); setDraft(template?.config || empty()); setCredentials(""); }
  const label = (key: string) => t(`agent.templates.${key}`);
  return <section aria-label={label("title")} className="space-y-3 rounded border border-app-border p-3">
    <h3 className="font-medium">{label("title")}</h3>
    <p className="text-xs text-tx-secondary">{label("boundary")}</p>
    <select aria-label={label("select")} className={fieldClass} disabled={busy} value={selected?.id || ""} onChange={e => choose(templates.find(v => v.id === e.target.value) || null)}><option value="">{label("new")}</option>{templates.map(v => <option value={v.id} key={v.id}>{v.name}</option>)}</select>
    <label className="block text-sm">{label("fromPrompt")}<select aria-label={label("fromPrompt")} className={fieldClass} disabled={busy} value="" onChange={e => { const id = e.target.value; if (id) void perform(async () => { const prompt = await read<{ name: string; instruction: string }>(`/prompts/${encodeURIComponent(id)}`); if (current()) { setSelected(null); setDraft({ ...empty(), name: prompt.name, input: { ...empty().input, instruction: prompt.instruction } }); } }); }}><option value="">{label("choosePrompt")}</option>{prompts.map(v => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label>
    <label className="block text-sm">{label("name")}<input aria-label={label("name")} className={fieldClass} maxLength={120} value={draft.name} disabled={busy} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
    <label className="block text-sm">{t("agent.workflow.notebook")}<select aria-label={label("scope")} className={fieldClass} disabled={busy} value={draft.input.notebookId} onChange={e => setDraft({ ...draft, input: { ...draft.input, notebookId: e.target.value } })}>{books.map(v => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy} checked={draft.input.includeChildren} onChange={e => setDraft({ ...draft, input: { ...draft.input, includeChildren: e.target.checked } })} />{t("agent.workflow.children")}</label>
    <label className="block text-sm">{label("instruction")}<textarea aria-label={label("instruction")} className={fieldClass} rows={3} maxLength={4000} disabled={busy} value={draft.input.instruction} onChange={e => setDraft({ ...draft, input: { ...draft.input, instruction: e.target.value } })} /></label>
    <fieldset className="space-y-2" disabled={busy}><legend className="text-sm font-medium">{label("permissions")}</legend>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.allowNote} onChange={e => setDraft({ ...draft, allowNote: e.target.checked })} />{label("allowNote")}</label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.allowTasks} onChange={e => setDraft({ ...draft, allowTasks: e.target.checked })} />{label("allowTasks")}</label>
      {tools.map(tool => <label key={tool.id} className="block break-words text-sm"><input type="checkbox" checked={draft.toolIds.includes(tool.id)} onChange={e => setDraft({ ...draft, toolIds: e.target.checked ? [...draft.toolIds, tool.id] : draft.toolIds.filter(id => id !== tool.id) })} /> {tool.name} · {tool.destination}</label>)}
    </fieldset>
    <div className="flex flex-wrap gap-2"><Button disabled={busy || !draft.name.trim() || !draft.input.instruction.trim() || !draft.input.notebookId} onClick={() => void perform(async () => { const saved = selected ? await read<AgentTemplate>(`/templates/${selected.id}`, "PUT", { revision: selected.revision, config: draft }) : await read<AgentTemplate>("/templates", "POST", draft); if (current()) choose(saved); })}>{label("save")}</Button>
      {selected && <><Button variant="outline" disabled={busy} onClick={() => onUse(selected)}>{label("use")}</Button><Button variant="outline" disabled={busy} onClick={() => void perform(async () => { await read(`/templates/${selected.id}`, "DELETE"); if (current()) choose(null); })}>{label("remove")}</Button></>}
    </div>
    {selected && <div className="space-y-2 border-t border-app-border pt-3">
      <h4 className="text-sm font-medium">{label("recurring")}</h4>
      <select aria-label={label("trigger")} className={fieldClass} value={trigger} disabled={busy} onChange={e => setTrigger(e.target.value)}>{["daily", "weekly", "event", "webhook"].map(v => <option value={v} key={v}>{label(v)}</option>)}</select>
      {["daily", "weekly"].includes(trigger) && <><input type="time" aria-label={label("time")} className={fieldClass} value={time} disabled={busy} onChange={e => setTime(e.target.value)} /><label className="block text-sm">{label("timezone")}<input aria-label={label("timezone")} className={fieldClass} value={draft.input.timezone} disabled={busy} onChange={e => setDraft({ ...draft, input: { ...draft.input, timezone: e.target.value } })} /></label></>}
      {trigger === "weekly" && <select aria-label={label("weekday")} className={fieldClass} value={weekday} disabled={busy} onChange={e => setWeekday(e.target.value)}>{[1, 2, 3, 4, 5, 6, 0].map(v => <option value={v} key={v}>{new Intl.DateTimeFormat(i18n.language, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2026, 9, 18 + v)))}</option>)}</select>}
      {trigger === "event" && <select aria-label={label("event")} className={fieldClass} value={event} disabled={busy} onChange={e => setEvent(e.target.value)}>{["note.created", "note.updated", "task.completed"].map(v => <option value={v} key={v}>{t(`automation.events.${v}`, { defaultValue: label(v.replace(".", "_")) })}</option>)}</select>}
      <Button variant="outline" disabled={busy || !time} onClick={() => void perform(async () => { const [hour, minute] = time.split(":"); const config = trigger === "event" ? { type: "event", event } : trigger === "webhook" ? { type: "webhook", requireSignature: true } : { type: "schedule", cron: `${Number(minute)} ${Number(hour)} * * ${trigger === "weekly" ? weekday : "*"}`, timezone: draft.input.timezone }; const result = await read<{ webhookCredentials?: { token: string; secret: string } }>(`/templates/${selected.id}/automations`, "POST", { revision: selected.revision, trigger: config }); if (current()) setCredentials(result.webhookCredentials ? JSON.stringify(result.webhookCredentials, null, 2) : ""); })}>{label("createAutomation")}</Button>
      {credentials && <div className="text-sm"><p>{label("credentials")}</p><pre className="whitespace-pre-wrap break-all">{credentials}</pre></div>}
    </div>}
    {automations.map(job => <div key={job.id} className="flex flex-wrap items-center gap-2 text-sm"><span>{job.name} · {label(job.enabled ? "enabled" : "disabled")}</span><Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => { await read(`/automations/${job.id}/enabled`, "POST", { enabled: !job.enabled }); })}>{label(job.enabled ? "disable" : "enable")}</Button></div>)}
    <details><summary className="cursor-pointer text-sm">{label("connections")}</summary><div className="mt-3 space-y-2">
      <p className="text-xs text-tx-secondary">{label("mcpBoundary")}</p>
      <label className="block text-sm">{label("connectionName")}<input aria-label={label("connectionName")} className={fieldClass} maxLength={100} disabled={busy} value={connectionName} onChange={e => setConnectionName(e.target.value)} /></label>
      <label className="block text-sm">{label("url")}<input aria-label={label("url")} className={fieldClass} type="url" disabled={busy} value={url} onChange={e => setUrl(e.target.value)} /></label>
      <label className="block text-sm">{label("token")}<input aria-label={label("token")} className={fieldClass} type="password" autoComplete="off" disabled={busy} value={token} onChange={e => setToken(e.target.value)} /></label>
      <label className="block text-sm">{label("toolNames")}<input aria-label={label("toolNames")} className={fieldClass} disabled={busy} value={names} onChange={e => setNames(e.target.value)} /></label>
      <Button variant="outline" disabled={busy || !connectionName || !url || !names} onClick={() => void perform(async () => { await read("/connections", "POST", { name: connectionName, url, ...(token ? { token } : {}), allowedTools: names.split(",").map(v => v.trim()).filter(Boolean) }); if (current()) { setToken(""); setConnectionName(""); setUrl(""); setNames(""); } })}>{label("saveConnection")}</Button>
      {connections.map(link => <div className="space-y-1 break-all text-sm" key={link.id}><p>{link.name} · {link.url}</p><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => { await read(`/connections/${link.id}/discover`, "POST"); })}>{label("discover")}</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => void perform(async () => { await read(`/connections/${link.id}`, "DELETE"); })}>{label("revoke")}</Button></div></div>)}
    </div></details>
    {error && <p role="alert" className="text-sm text-red-500">{error}</p>}
  </section>;
}
