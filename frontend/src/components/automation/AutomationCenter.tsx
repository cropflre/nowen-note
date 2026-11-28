import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { ChevronDown, CircleStop, Clock3, GitBranch, Loader2, Play, Plus, RefreshCw, Sparkles, Trash2, Zap } from "lucide-react";
import { automationApi, type AutomationRun, type AutomationStep, type AutomationWorkflow } from "@/lib/automationApi";
import { formatAppDateTime, getEffectiveTimeZone } from "@/lib/dateTime";
import { pluginApi, type PluginAction } from "@/lib/pluginApi";
import TaskDigestSettings from "./TaskDigestSettings";

const eventOptions = ["note.created", "note.updated", "task.created", "task.completed", "attachment.created", "diary.created", "mindmap.created"];
type ActionOption = PluginAction & { pluginId: string; actionId: string };

function RunHistory({ workflow }: { workflow: AutomationWorkflow }) {
  const { t, i18n } = useTranslation();
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  useEffect(() => { void automationApi.runs(workflow.id).then(setRuns); }, [workflow.id]);
  return (
    <div className="mt-3.5 border-t border-app-border/70 pt-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-tx-tertiary">{t("automation.recentRuns")}</p>
      {runs.length ? (
        <div className="space-y-1.5">
          {runs.slice(0, 5).map((run) => (
            <div key={run.id} className="flex items-center justify-between rounded-xl border border-app-border/60 bg-app-bg/75 px-3 py-2 text-xs">
              <span className="tabular-nums text-tx-secondary">{formatAppDateTime(run.createdAt, undefined, undefined, i18n.resolvedLanguage || i18n.language)}</span>
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                run.status === "completed"
                  ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300"
                  : run.status === "failed"
                    ? "bg-rose-500/12 text-rose-600 dark:text-rose-300"
                    : "bg-amber-500/12 text-amber-700 dark:text-amber-300"
              }`}>
                {t(`automation.statuses.${run.status}`, { defaultValue: run.status })}{run.errorCode ? ` · ${run.errorCode}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-tx-tertiary">{t("automation.noRuns")}</p>
      )}
    </div>
  );
}

export default function AutomationCenter() {
  const { t, i18n } = useTranslation();
  const [workflows, setWorkflows] = useState<AutomationWorkflow[]>([]);
  const [actions, setActions] = useState<ActionOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [triggerType, setTriggerType] = useState<"event" | "schedule" | "webhook" | "manual">("event");
  const [eventType, setEventType] = useState("note.created");
  const [cron, setCron] = useState("0 8 * * *");
  const [timezone, setTimezone] = useState(() => getEffectiveTimeZone() || "Asia/Shanghai");
  const [steps, setSteps] = useState<AutomationStep[]>([]);
  const [credentials, setCredentials] = useState<{ token: string; secret?: string } | null>(null);
  const refresh = async () => { setLoading(true); try { setWorkflows(await automationApi.list()); setActions(await pluginApi.actions()); } finally { setLoading(false); } };
  useEffect(() => { void refresh(); }, []);
  const actionGroups = useMemo(() => new Map(actions.map((action) => [`${action.pluginId}:${action.actionId}`, action])), [actions]);
  const addStep = (type: AutomationStep["type"]) => {
    const id = `${type}-${steps.length + 1}`;
    const first = actions[0];
    const step: AutomationStep = type === "action" ? { id, type, pluginId: first?.pluginId || "", actionId: first?.actionId || "", input: {} }
      : type === "condition" ? { id, type, if: { left: "{{event.data.title}}", operator: "contains", right: "日报" } }
        : type === "delay" ? { id, type, seconds: 60 }
          : type === "transform" ? { id, type, output: { resourceId: "{{event.resource.id}}" } }
            : { id, type, reason: "stop" };
    setSteps((current) => [...current, step]);
  };
  const save = async () => {
    const trigger = triggerType === "event" ? { type: "event", event: eventType } : triggerType === "schedule" ? { type: "schedule", cron, timezone } : triggerType === "webhook" ? { type: "webhook", requireSignature: true } : { type: "manual" };
    const created = await automationApi.create({ name: name ?? t("automation.defaultName"), description: t("automation.createdDescription"), definition: { version: 1, trigger, steps }, ignoreSync: true, ignoreBulk: true });
    setCredentials(created.webhookCredentials || null); setEditing(false); setSteps([]); await refresh();
  };

  return (
    <div className="max-w-3xl space-y-5">
      <TaskDigestSettings />

      {/* 灵动自动化流程横幅 */}
      <div className="relative overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-br from-amber-500/[0.08] via-app-elevated/92 to-indigo-500/[0.08] p-5 shadow-xs backdrop-blur-md">
        <div aria-hidden="true" className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-amber-400/15 blur-2xl" />
        <div aria-hidden="true" className="pointer-events-none absolute right-5 top-4 font-mono text-5xl font-black text-amber-500/[0.08] dark:text-amber-300/[0.08]">
          {t("automation.flow")}
        </div>
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <motion.span
              whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
              transition={{ duration: 0.4 }}
              className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 via-orange-500 to-rose-500 text-white shadow-md shadow-amber-500/20"
            >
              <Zap size={20} />
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sky-300 text-sky-900 shadow-xs">
                <Sparkles size={8} />
              </span>
            </motion.span>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-600 dark:text-amber-300">{t("automation.rail")}</p>
              <h2 className="mt-0.5 text-lg font-bold tracking-tight text-tx-primary">{t("automation.title")}</h2>
              <p className="mt-1 max-w-xl text-xs leading-5 text-tx-secondary">{t("automation.description")}</p>
            </div>
          </div>
          <motion.button
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.96 }}
            onClick={() => setEditing(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 px-3.5 py-2 text-xs font-semibold text-white shadow-sm shadow-amber-500/25 transition-all hover:brightness-105"
          >
            <Plus size={14} />{t("automation.newWorkflow")}
          </motion.button>
        </div>
      </div>

      {credentials && (
        <div className="rounded-2xl border border-amber-400/40 bg-amber-500/[0.09] p-4 text-xs text-amber-900 dark:text-amber-200">
          <strong>{t("automation.credentialsOnce")}</strong>
          <div className="mt-1.5 break-all rounded-xl bg-app-surface/80 p-2.5 font-mono">
            {t("automation.token")}: {credentials.token}
            {credentials.secret ? <><br />{t("automation.secret")}: {credentials.secret}</> : null}
          </div>
          <button className="mt-2 font-semibold underline" onClick={() => setCredentials(null)}>{t("automation.credentialsSaved")}</button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 rounded-2xl border border-app-border/75 bg-app-elevated/70 p-6 text-xs text-tx-secondary">
          <Loader2 className="animate-spin text-amber-500" size={16} />{t("automation.loading")}
        </div>
      ) : workflows.length ? (
        <div className="space-y-3">
          {workflows.map((workflow) => (
            <div
              key={workflow.id}
              className="rounded-2xl border border-app-border/80 bg-app-elevated/85 p-4 shadow-xs backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:border-amber-400/35 hover:shadow-md"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/14 text-amber-600 ring-1 ring-amber-500/20 dark:text-amber-300">
                    <Zap size={17} />
                  </div>
                  <div>
                    <h3 className="text-sm font-bold text-tx-primary">{workflow.name}</h3>
                    <p className="mt-0.5 text-xs text-tx-secondary">
                      {t(`automation.triggers.${workflow.triggerType}`)}
                      {workflow.schedule?.nextRunAt ? ` · ${t("automation.nextRun", { time: formatAppDateTime(workflow.schedule.nextRunAt, undefined, undefined, i18n.resolvedLanguage || i18n.language) })}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={async () => { await automationApi.enable(workflow.id, !workflow.enabled); await refresh(); }}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-all active:scale-95 ${
                      workflow.enabled
                        ? "bg-emerald-500/14 text-emerald-700 ring-1 ring-emerald-500/25 dark:text-emerald-300"
                        : "bg-app-hover text-tx-tertiary"
                    }`}
                  >
                    {workflow.enabled ? t("automation.enabled") : t("automation.disabled")}
                  </button>
                  <button
                    aria-label={t("automation.run")}
                    onClick={async () => { await automationApi.run(workflow.id); setExpanded(workflow.id); }}
                    className="rounded-xl border border-app-border/80 bg-app-surface p-2 text-tx-secondary transition-colors hover:border-amber-400/40 hover:text-amber-600 active:scale-95"
                  >
                    <Play size={13} />
                  </button>
                  <button
                    aria-label={t("automation.history")}
                    onClick={() => setExpanded(expanded === workflow.id ? null : workflow.id)}
                    className="rounded-xl border border-app-border/80 bg-app-surface p-2 text-tx-secondary transition-colors hover:border-accent-primary/40 hover:text-tx-primary active:scale-95"
                  >
                    <ChevronDown size={13} className={`transition-transform duration-200 ${expanded === workflow.id ? "rotate-180" : ""}`} />
                  </button>
                  <button
                    aria-label={t("common.delete")}
                    onClick={async () => { if (confirm(t("automation.deleteConfirm", { name: workflow.name }))) { await automationApi.remove(workflow.id); await refresh(); } }}
                    className="rounded-xl border border-rose-500/25 bg-rose-500/8 p-2 text-rose-500 transition-colors hover:bg-rose-500/16 active:scale-95"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              {expanded === workflow.id && (
                <>
                  <div className="mt-4 flex items-center gap-2 overflow-x-auto pb-1">
                    {workflow.definition.steps.map((step, index) => (
                      <div key={step.id} className="flex items-center gap-2">
                        <div className="min-w-32 rounded-xl border border-app-border/75 bg-app-surface/90 px-3 py-2 text-xs shadow-xs">
                          <span className="font-mono text-[10px] text-tx-tertiary">#{index + 1}</span>
                          <p className="mt-0.5 font-semibold text-tx-primary">
                            {t(`automation.stepTypes.${step.type}`)}
                            {step.type === "action" ? ` · ${String(step.actionId)}` : ""}
                          </p>
                        </div>
                        {index < workflow.definition.steps.length - 1 && <span className="text-amber-500">→</span>}
                      </div>
                    ))}
                  </div>
                  <RunHistory workflow={workflow} />
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-app-border/80 bg-app-elevated/55 px-6 py-12 text-center">
          <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/12 text-amber-500 ring-1 ring-amber-500/20">
            <Zap size={22} />
          </span>
          <p className="text-xs font-medium text-tx-secondary">{t("automation.empty")}</p>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-app-border/80 bg-app-elevated/95 p-6 shadow-2xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-tx-primary">{t("automation.createTitle")}</h3>
              <button aria-label={t("common.close")} onClick={() => setEditing(false)} className="rounded-xl p-1.5 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary">×</button>
            </div>
            <label className="mt-4 block text-xs font-semibold text-tx-secondary">
              {t("automation.name")}
              <input value={name ?? t("automation.defaultName")} onChange={e => setName(e.target.value)} className="mt-1.5 w-full rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary" />
            </label>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-xs font-semibold text-tx-secondary">
                {t("automation.triggerType")}
                <select value={triggerType} onChange={e => setTriggerType(e.target.value as typeof triggerType)} className="mt-1.5 w-full rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary">
                  <option value="event">{t("automation.triggers.event")}</option>
                  <option value="schedule">{t("automation.triggers.schedule")}</option>
                  <option value="webhook">{t("automation.triggers.webhook")}</option>
                  <option value="manual">{t("automation.triggers.manual")}</option>
                </select>
              </label>
              {triggerType === "event" && (
                <label className="text-xs font-semibold text-tx-secondary">
                  {t("automation.event")}
                  <select value={eventType} onChange={e => setEventType(e.target.value)} className="mt-1.5 w-full rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary">
                    {eventOptions.map(event => <option key={event} value={event}>{t(`automation.events.${event}`)}</option>)}
                  </select>
                </label>
              )}
              {triggerType === "schedule" && (
                <>
                  <label className="text-xs font-semibold text-tx-secondary">
                    {t("automation.cron")}
                    <input value={cron} onChange={e => setCron(e.target.value)} className="mt-1.5 w-full rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary" />
                  </label>
                  <label className="text-xs font-semibold text-tx-secondary">
                    {t("automation.timezone")}
                    <input value={timezone} onChange={e => setTimezone(e.target.value)} className="mt-1.5 w-full rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:border-accent-primary" />
                  </label>
                </>
              )}
            </div>
            <div className="mt-5 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-tx-tertiary">{t("automation.steps")}</p>
              {steps.map((step, index) => (
                <div key={step.id} className="flex items-center gap-2 rounded-xl border border-app-border/75 bg-app-surface/90 p-3">
                  <span className="font-mono text-xs text-tx-tertiary">{index + 1}</span>
                  <span className="rounded-full bg-amber-500/12 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300">{t(`automation.stepTypes.${step.type}`)}</span>
                  {step.type === "action" && (
                    <select value={`${step.pluginId}:${step.actionId}`} onChange={e => { const [pluginId, ...rest] = e.target.value.split(":"); const actionId = rest.join(":"); setSteps(s => s.map(x => x.id === step.id ? { ...x, pluginId, actionId } : x)); }} className="min-w-0 flex-1 rounded-xl border border-app-border bg-app-bg px-2.5 py-1.5 text-xs">
                      {[...actionGroups].map(([key, action]) => <option key={key} value={key}>{action.pluginId} · {action.name}</option>)}
                    </select>
                  )}
                  {step.type === "delay" && (
                    <input type="number" value={Number(step.seconds)} onChange={e => setSteps(s => s.map(x => x.id === step.id ? { ...x, seconds: Number(e.target.value) } : x))} className="w-24 rounded-xl border border-app-border bg-app-bg px-2.5 py-1 text-xs" />
                  )}
                  <button aria-label={t("automation.removeStep")} onClick={() => setSteps(s => s.filter(x => x.id !== step.id))} className="ml-auto rounded-lg p-1 text-rose-500 hover:bg-rose-500/10">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {([["action", Play], ["condition", GitBranch], ["delay", Clock3], ["transform", RefreshCw], ["stop", CircleStop]] as const).map(([type, Icon]) => (
                <button key={type} onClick={() => addStep(type)} className="inline-flex items-center gap-1.5 rounded-full border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-medium text-tx-secondary transition-all hover:border-amber-400/45 hover:text-tx-primary active:scale-95">
                  <Icon size={12} />{t(`automation.stepTypes.${type}`)}
                </button>
              ))}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditing(false)} className="rounded-xl border border-app-border/80 px-3.5 py-2 text-xs font-medium text-tx-secondary hover:bg-app-hover">{t("common.cancel")}</button>
              <button disabled={!steps.length} onClick={save} className="rounded-xl bg-gradient-to-r from-amber-500 to-rose-500 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:brightness-105 disabled:opacity-40">{t("automation.saveDisabled")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
