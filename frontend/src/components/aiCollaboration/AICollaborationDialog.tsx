import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Capacitor } from "@capacitor/core";
import { Loader2, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/store/AppContext";
import type { Notebook, Note } from "@/types";
import { pluginApi } from "@/lib/pluginApi";
import { listPluginPrompts, renderPluginPrompt, replacePluginPrompts, type RegisteredPluginPrompt } from "@/lib/pluginPromptRegistry";
import { registerMobileBackHandler } from "@/lib/mobileBackNavigation";
import { isMobileLocalMode } from "@/lib/mobileLocalMode";
import { pushNoteAppPath } from "@/lib/noteDeepLink";
import {
  collaborationDraftKey, collaborationRequest, collaborationScope, emptyCollaborationDraft,
  makeCollaborationSave, readCollaborationDraft, saveCollaborationNote, suggestSkills,
  type CollaborationDraft, type CollaborationResult, type FolderSkill, type SkillRequest,
} from "@/lib/aiCollaboration";
import PersonalSkillsEditor, { type PersonalSkill } from "./PersonalSkillsEditor";

interface SkillChoice { key: string; name: string; source: "builtin" | "personal" | "note" | "plugin"; request: SkillRequest; plugin?: RegisteredPluginPrompt }
function notebookPath(rows: Notebook[], row: Notebook): string {
  const path = [row.name]; const seen = new Set([row.id]); let parent = row.parentId;
  while (parent && !seen.has(parent)) { seen.add(parent); const item = rows.find(entry => entry.id === parent); if (!item) break; path.unshift(item.name); parent = item.parentId; }
  return path.join(" / ");
}
export default function AICollaborationDialog({ scope, onClose }: { scope: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { state } = useApp();
  const restoreFailed = useRef(false);
  const [draft, setDraft] = useState<CollaborationDraft>(() => {
    try { return readCollaborationDraft(scope); } catch { restoreFailed.current = true; return emptyCollaborationDraft(); }
  });
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [personal, setPersonal] = useState<PersonalSkill[]>([]);
  const [plugins, setPlugins] = useState<RegisteredPluginPrompt[]>([]);
  const [folderSkills, setFolderSkills] = useState<FolderSkill[]>([]);
  const [libraryError, setLibraryError] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryLimited, setLibraryLimited] = useState(false);
  const [parameters, setParameters] = useState<Record<string, string | number | boolean>>({});
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [savedNote, setSavedNote] = useState<Note | null>(null);
  const alive = useRef(true);
  const operation = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const optionsRef = useRef<HTMLDetailsElement>(null);
  const current = useCallback(() => alive.current && collaborationScope() === scope, [scope]);
  const deviceOnly = isMobileLocalMode();
  const persist = useCallback((value: CollaborationDraft) => {
    if (restoreFailed.current) { setStorageError(true); return; }
    try { localStorage.setItem(collaborationDraftKey(scope), JSON.stringify(value)); setStorageError(false); }
    catch { setStorageError(true); }
  }, [scope]);
  const update = (patch: Partial<CollaborationDraft>) => { setSavedNote(null); setDraft(previous => ({ ...previous, ...(patch.input !== undefined ? { output: "", references: [], truncated: false } : {}), ...patch })); };
  useEffect(() => { persist(draft); }, [draft, persist]); // The captured scope never changes when an account switches.
  useEffect(() => {
    alive.current = true;
    const before = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { alive.current = false; controller.current?.abort(); if (before?.isConnected) before.focus(); };
  }, []);
  useEffect(() => registerMobileBackHandler("sheet", () => { if (!operation.current || !saving) onClose(); return true; }), [onClose, saving]);
  useEffect(() => {
    let active = true;
    void (async () => {
      void api.getNotebooks().then(rows => {
        if (!active || !current()) return;
        setNotebooks(rows);
        setDraft(value => ({ ...value, targetId: rows.find(row => row.id === (value.targetId || state.selectedNotebookId) && (!row.permission || ["write", "manage"].includes(row.permission)))?.id || rows.find(row => !row.permission || ["write", "manage"].includes(row.permission))?.id || "" }));
      }).catch(cause => { if (active && current()) setError(cause instanceof Error ? cause.message : String(cause)); })
        .finally(() => { if (active && current()) setLoading(false); });
      const results = await Promise.allSettled([deviceOnly ? Promise.resolve({ items: [] }) : api.aiPrompts.list(), deviceOnly ? Promise.resolve([]) : pluginApi.contributions()]);
      if (!active || !current()) return;
      if (results[0].status === "fulfilled") setPersonal(results[0].value.items);
      if (results[1].status === "fulfilled") {
        replacePluginPrompts(results[1].value);
        const platform = Capacitor.isNativePlatform() ? Capacitor.getPlatform() as "android" | "ios" : (window as Window & { nowenDesktop?: { isDesktop?: boolean } }).nowenDesktop?.isDesktop ? "desktop" : "web";
        setPlugins(listPluginPrompts(platform));
      }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) setError(failures.map(result => result.reason instanceof Error ? result.reason.message : String(result.reason)).join("; "));
    })();
    return () => { active = false; };
  }, [scope, current, deviceOnly, state.selectedNotebookId]);
  useEffect(() => {
    let active = true; setFolderSkills([]); setLibraryError(""); setLibraryLimited(false);
    if (!draft.libraryId || deviceOnly) { setLibraryLoading(false); return; }
    const abort = new AbortController(); setLibraryLoading(true);
    collaborationRequest<{ items: FolderSkill[]; limited: boolean }>(`skills?notebookId=${encodeURIComponent(draft.libraryId)}`, undefined, abort.signal)
      .then(result => { if (active && current()) { setFolderSkills(result.items); setLibraryLimited(result.limited); } })
      .catch(cause => { if (active && current()) setLibraryError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active && current()) setLibraryLoading(false); });
    return () => { active = false; abort.abort(); };
  }, [draft.libraryId, scope, current, deviceOnly]);
  const skills = useMemo<SkillChoice[]>(() => [
    ...(["capture", "brief", "meeting"] as const).map(id => ({ key: `builtin:${id}`, name: t(`aiCollaboration.${id}Skill`), source: "builtin" as const,
      request: { kind: "prompt" as const, name: t(`aiCollaboration.${id}Skill`), prompt: t(`aiCollaboration.${id}Prompt`) } })),
    ...personal.map(item => ({ key: `personal:${item.id}`, name: item.name, source: "personal" as const, request: { kind: "personal" as const, id: item.id } })),
    ...folderSkills.map(item => ({ key: `note:${item.id}`, name: item.name, source: "note" as const, request: { kind: "note" as const, id: item.id, notebookId: draft.libraryId } })),
    ...plugins.map(item => ({ key: `plugin:${item.runtimeId}`, name: item.name, source: "plugin" as const, plugin: item,
      request: { kind: "prompt" as const, name: item.name, prompt: item.prompt } })),
  ], [personal, folderSkills, plugins, draft.libraryId, t]);
  const automaticSkills = skills.filter(item => !item.plugin?.inputs?.some(param => param.required && param.default === undefined))
    .sort((a, b) => Number(a.source === "builtin") - Number(b.source === "builtin"));
  const automatic = suggestSkills(draft.input, automaticSkills)[0] || skills[0];
  const selected = skills.find(item => item.key === draft.skillKey) || automatic;
  const suggestions = suggestSkills(draft.input, skills).filter(item => item.key !== selected?.key);
  const locked = generating || saving || !!draft.saveRequest;
  const chooseSkill = (key: string) => { update({ skillKey: key }); setParameters({}); };
  const generate = async () => {
    if (operation.current || !selected || !draft.input.trim() || !current()) return;
    operation.current = true; setGenerating(true); setError(""); setSavedNote(null);
    controller.current = new AbortController();
    try {
      const missing = selected.plugin?.inputs?.find(param => param.required && (parameters[param.id] ?? param.default) === undefined);
      if (missing) { if (optionsRef.current) optionsRef.current.open = true; setError(t("aiCollaboration.missingInput", { name: missing.label || missing.id })); return; }
      const skill = selected.plugin ? { kind: "prompt" as const, name: selected.name, prompt: renderPluginPrompt(selected.plugin, parameters) } : selected.request;
      const result = await collaborationRequest<CollaborationResult>("compose", { input: draft.input, intent: selected.key === "builtin:capture" ? "capture" : "draft",
        ...(draft.projectId ? { notebookId: draft.projectId } : {}), skill }, controller.current.signal);
      if (!current() || controller.current.signal.aborted) return;
      // Do not erase a previous preview on failure or cancellation.
      setDraft(value => ({ ...value, output: result.content, references: result.references, truncated: result.truncated }));
    } catch (cause) { if (current() && !(cause instanceof Error && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operation.current = false; if (current()) setGenerating(false); }
  };
  const save = async (raw = false) => {
    if (operation.current || !current()) return;
    operation.current = true; setSaving(true); setError("");
    try {
      let targetId = draft.targetId;
      if (!draft.saveRequest && !targetId) {
        const rows = await api.getNotebooks();
        if (!current()) return;
        let target = rows.find(row => !row.permission || ["write", "manage"].includes(row.permission));
        if (!target) target = await api.createNotebook({ name: t("aiCollaboration.quickFolder") });
        if (!current()) return;
        targetId = target.id;
        setNotebooks(rows.some(row => row.id === target!.id) ? rows : [...rows, target]);
      }
      const request = draft.saveRequest || makeCollaborationSave({ ...draft, targetId }, t("aiCollaboration.original"), t("aiCollaboration.references"), raw);
      const pending = { ...draft, targetId, saveRequest: request }; persist(pending); setDraft(pending);
      const note = await saveCollaborationNote(request, scope);
      if (!current()) return;
      setSavedNote(note);
      const cleared = { ...emptyCollaborationDraft(), targetId, libraryId: draft.libraryId, projectId: draft.projectId, skillKey: draft.skillKey };
      persist(cleared); setDraft(cleared);
      window.dispatchEvent(new CustomEvent("nowen:knowledge-tree-changed", { detail: { reason: "ai-note-created" } }));
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operation.current = false; if (current()) setSaving(false); }
  };
  const field = "w-full min-w-0 max-w-full rounded-lg border border-app-border bg-app-bg px-3 py-2 text-sm text-tx-primary disabled:opacity-60";
  const folders = notebooks.map(row => <option key={row.id} value={row.id}>{notebookPath(notebooks, row)}</option>);
  return <div className="fixed inset-0 z-[100] flex min-h-0 items-center justify-center bg-black/40 p-0 sm:p-4" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (!saving) onClose(); } }} data-swipe-blocker="ai-collaboration">
    <section role="dialog" aria-modal="true" aria-labelledby="ai-collaboration-title" className="flex h-[100dvh] min-h-0 w-full max-w-2xl flex-col overflow-hidden bg-app-surface text-tx-primary shadow-xl sm:h-auto sm:max-h-[90dvh] sm:rounded-2xl">
      <header className="flex shrink-0 items-center gap-2 border-b border-app-border px-3 py-2" style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)" }}>
        <Sparkles size={18} className="shrink-0 text-accent-primary" /><h2 id="ai-collaboration-title" className="min-w-0 flex-1 truncate text-sm font-semibold">{t("aiCollaboration.title")}</h2>
        <button aria-label={t("common.close")} disabled={saving} onClick={onClose} className="rounded p-2"><X size={16} /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3 sm:p-5">
        <p className="text-xs text-tx-tertiary">{t("aiCollaboration.simpleHint")}</p>
        {storageError && <p role="alert" className="text-xs text-red-500">{t("aiCollaboration.storageError")}</p>}
        {!draft.output ? <textarea ref={inputRef} aria-label={t("aiCollaboration.idea")} value={draft.input} disabled={locked} maxLength={8000} rows={6} placeholder={t("aiCollaboration.ideaPlaceholder")} onChange={event => update({ input: event.target.value })} className={`${field} resize-none text-base leading-7`} /> : <>
          <input aria-label={t("aiCollaboration.noteTitle")} value={draft.title} disabled={locked} maxLength={120} placeholder={draft.output.split("\n").find(line => line.trim())?.replace(/^#+\s*/, "") || t("aiCollaboration.titlePlaceholder")} onChange={event => update({ title: event.target.value })} className={`${field} font-medium`} />
          <textarea aria-label={t("aiCollaboration.preview")} rows={10} value={draft.output} disabled={locked} onChange={event => update({ output: event.target.value })} className={`${field} leading-7`} />
          <details className="text-xs text-tx-tertiary"><summary className="cursor-pointer">{t("aiCollaboration.original")}</summary><textarea aria-label={t("aiCollaboration.idea")} value={draft.input} disabled={locked} maxLength={8000} rows={3} onChange={event => update({ input: event.target.value })} className={`mt-2 ${field}`} /></details>
          {!!draft.references.length && <details className="text-xs text-tx-secondary"><summary className="cursor-pointer">{t("aiCollaboration.references")} · {draft.references.length}</summary><ul className="mt-2 max-h-28 list-inside list-disc overflow-y-auto">{draft.references.map(ref => <li key={ref.id} className="truncate" title={ref.title}>{ref.title}</li>)}</ul></details>}
          {draft.truncated && <p className="text-xs text-amber-600">{t("aiCollaboration.truncated")}</p>}
        </>}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-tx-tertiary">
          <span className="min-w-0 truncate">{t("aiCollaboration.usingMethod", { name: selected?.name || "" })}</span>
          <button disabled={locked} onClick={() => { if (optionsRef.current) optionsRef.current.open = true; optionsRef.current?.scrollIntoView({ block: "nearest" }); }} className="max-w-full truncate text-accent-primary">{t("aiCollaboration.savingTo", { name: notebooks.find(row => row.id === draft.targetId)?.name || t("aiCollaboration.quickFolder") })}</button>
        </div>
        {draft.projectId && <p className="text-xs text-tx-secondary">{t("aiCollaboration.usingProject", { name: notebooks.find(row => row.id === draft.projectId)?.name || "" })}</p>}
        <details ref={optionsRef} className="rounded-lg border border-app-border p-3">
          <summary className="cursor-pointer text-xs text-tx-secondary">{t("aiCollaboration.moreOptions")}</summary>
          <div className="mt-4 space-y-3">
            <label className="block space-y-1 text-xs">{t("aiCollaboration.project")}<select aria-label={t("aiCollaboration.project")} disabled={locked || deviceOnly} value={draft.projectId} onChange={event => update({ projectId: event.target.value })} className={field}><option value="">{t("aiCollaboration.noProject")}</option>{folders}</select></label>
            <label className="block space-y-1 text-xs">{t("aiCollaboration.skill")}<select aria-label={t("aiCollaboration.skill")} disabled={locked || libraryLoading} value={draft.skillKey} onChange={event => chooseSkill(event.target.value)} className={field}>
              <option value="auto">{t("aiCollaboration.autoMethod")}</option>
              {!skills.some(item => item.key === draft.skillKey) && draft.skillKey !== "auto" && <option value={draft.skillKey}>{t("aiCollaboration.skillUnavailable")}</option>}
              {(["builtin", "personal", "note", "plugin"] as const).map(source => <optgroup key={source} label={t(`aiCollaboration.source_${source}`)}>{skills.filter(item => item.source === source).map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</optgroup>)}
            </select></label>
            {!!suggestions.length && <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs"><span className="text-tx-tertiary">{t("aiCollaboration.suggestions")}</span>{suggestions.map(item => <button key={item.key} disabled={locked} title={item.name} onClick={() => chooseSkill(item.key)} className="min-w-0 max-w-full truncate rounded-md border border-app-border px-2 py-1 text-accent-primary">{item.name}</button>)}</div>}
            {selected?.plugin?.inputs?.map(param => <label key={`${selected.key}:${param.id}`} className="block space-y-1 text-xs">{param.label || param.id}{param.required ? " *" : ""}{param.type === "boolean" ? <input type="checkbox" aria-label={param.label || param.id} disabled={locked} checked={Boolean(parameters[param.id] ?? param.default)} onChange={event => setParameters(values => ({ ...values, [param.id]: event.target.checked }))} /> : <input aria-label={param.label || param.id} disabled={locked} type={param.type === "number" ? "number" : "text"} value={String(parameters[param.id] ?? param.default ?? "")} onChange={event => setParameters(values => ({ ...values, [param.id]: param.type === "number" ? Number(event.target.value) : event.target.value }))} className={field} />}</label>)}
            <label className="block space-y-1 text-xs">{t("aiCollaboration.target")}<select aria-label={t("aiCollaboration.target")} value={draft.targetId} disabled={locked || loading} onChange={event => update({ targetId: event.target.value })} className={field}><option value="">{t("aiCollaboration.quickFolder")}</option>{notebooks.filter(row => !row.permission || ["write", "manage"].includes(row.permission)).map(row => <option key={row.id} value={row.id}>{notebookPath(notebooks, row)}</option>)}</select></label>
            <details className="text-xs"><summary className="cursor-pointer text-tx-secondary">{t("aiCollaboration.templateSettings")}</summary><div className="mt-3 space-y-3">
              <label className="block space-y-1">{t("aiCollaboration.library")}<select aria-label={t("aiCollaboration.library")} disabled={locked || deviceOnly} value={draft.libraryId} onChange={event => { update({ libraryId: event.target.value, skillKey: "auto" }); setParameters({}); }} className={field}><option value="">{t("aiCollaboration.noLibrary")}</option>{folders}</select></label>
              <p className="text-tx-tertiary">{t("aiCollaboration.libraryHint")}</p>
              {libraryError && <p role="alert" className="text-red-500">{libraryError}</p>}
              {libraryLimited && <p className="text-amber-600">{t("aiCollaboration.libraryLimited")}</p>}
              {!deviceOnly && <PersonalSkillsEditor items={personal} onChanged={setPersonal} scope={scope} />}
            </div></details>
          </div>
        </details>
        {deviceOnly && <p className="text-xs text-tx-tertiary">{t("aiCollaboration.deviceOnly")}</p>}
        {draft.saveRequest && <p role="status" className="text-xs text-amber-600">{t("aiCollaboration.retryHint")}</p>}
        {error && <p role="alert" className="break-words text-xs text-red-500">{error}</p>}
        {savedNote && <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-accent-primary"><span>{t("aiCollaboration.saved")}</span><button className="underline" onClick={() => { pushNoteAppPath(savedNote.id); onClose(); }}>{t("aiCollaboration.openNote")}</button></div>}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-app-border px-3 py-3" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)" }}>
        {generating ? <button onClick={() => controller.current?.abort()} className="px-3 py-2 text-xs">{t("aiCollaboration.stop")}</button>
          : <button disabled={saving || loading || !draft.input.trim() || !!draft.saveRequest} onClick={() => draft.output ? void generate() : void save(true)} className="rounded-lg px-3 py-2 text-xs text-tx-secondary disabled:opacity-40">{t(draft.output ? "aiCollaboration.regenerate" : "aiCollaboration.saveOriginal")}</button>}
        <button disabled={saving || generating || ((!!draft.output || !!draft.saveRequest) && loading) || !draft.input.trim() || (!draft.output && !draft.saveRequest && deviceOnly)} onClick={() => draft.output || draft.saveRequest ? void save() : void generate()} className="inline-flex items-center gap-2 rounded-lg bg-accent-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{(saving || generating) && <Loader2 size={14} className="animate-spin" />}{t(draft.saveRequest ? "aiCollaboration.retrySave" : draft.output ? "aiCollaboration.saveDraft" : "aiCollaboration.generate")}</button>
      </footer>
    </section>
  </div>;
}
