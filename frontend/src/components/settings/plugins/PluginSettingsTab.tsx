import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "framer-motion";
import { formatAppDateTime } from "@/lib/dateTime";
import JSZip from "jszip";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Code2, KeyRound, Loader2, PackagePlus, Play, Puzzle, RefreshCw, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { pluginApi, type InstalledPlugin, type PluginAction, type PluginConnection, type PluginExecution, type PluginUpdate, type RegistrySource } from "@/lib/pluginApi";
import { getPluginRuntimePresentation } from "@/lib/pluginRuntimePresentation";
import { WechatCaptureSettings } from "./WechatCaptureSettings";
import { PluginInboundSettings } from "./PluginInboundSettings";
import { PluginRuntimePolicySettings } from "./PluginRuntimePolicySettings";

const permissionLabels: Record<string, string> = {
  "notes:read": "读取笔记", "notes:write": "创建和修改笔记",
  "notebooks:read": "读取笔记本", "notebooks:write": "创建和修改笔记本",
  "tags:read": "读取标签", "tags:write": "创建和修改标签",
  "tasks:read": "读取任务", "tasks:write": "创建和修改任务",
  "attachments:read": "读取附件信息", "attachments:write": "创建和修改附件",
  "plugin-storage:read": "读取插件自己的数据", "plugin-storage:write": "保存插件自己的数据",
  "capture:write": "抓取公网 HTTPS 文章和图片，保存到有写入权限的笔记本",
  "external:fetch": "访问声明的外部网络服务", "secrets:use": "使用你配置的连接密钥（插件看不到原值）",
  "diary:read": "读取日记", "diary:write": "创建和修改日记",
  "mindmaps:read": "读取思维导图", "mindmaps:write": "创建和修改思维导图",
};

type PendingManifest = {
  id?: string;
  name?: string;
  version?: string;
  apiVersion?: number;
  runtime?: string;
  executionMode?: string;
  permissions?: string[];
  permissionConfig?: { externalFetchHosts?: string[] };
};

type PendingPackage = { file: File; manifest: PendingManifest; nodeRuntimeConfirmationRequired: boolean };

function statusLabel(status: InstalledPlugin["status"]): string {
  return ({ quarantined: "待确认", disabled: "已禁用", enabled: "已启用", error: "运行错误", incompatible: "不兼容" })[status];
}

function ActionTester({ plugin, action }: { plugin: InstalledPlugin; action: PluginAction }) {
  const initial = useMemo(() => Object.fromEntries(Object.entries(action.input || {}).map(([key, field]) => [key, field.type === "boolean" ? false : field.type === "number" ? 0 : ""])), [action]);
  const [input, setInput] = useState(JSON.stringify(initial, null, 2));
  const [result, setResult] = useState("");
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true); setResult("");
    try { setResult(JSON.stringify(await pluginApi.execute(plugin.id, action.id, JSON.parse(input)), null, 2)); }
    catch (error) { setResult(error instanceof Error ? error.message : String(error)); }
    finally { setRunning(false); }
  };
  return <div className="space-y-2.5 rounded-xl border border-app-border/80 bg-app-surface/75 p-3.5">
    <div><div className="text-sm font-semibold text-tx-primary">{action.name}</div><div className="text-xs text-tx-secondary">{action.description || action.id}</div></div>
    <textarea value={input} onChange={(event) => setInput(event.target.value)} className="min-h-24 w-full rounded-xl border border-app-border/80 bg-app-elevated p-2.5 font-mono text-xs text-tx-primary outline-none focus:border-purple-400" aria-label={`${action.name} 参数`} />
    <button onClick={run} disabled={running || plugin.status !== "enabled"} className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition-all hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"><Play size={13} />{running ? "执行中" : "执行"}</button>
    {result && <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-xl border border-app-border/60 bg-app-elevated p-2.5 text-xs text-tx-primary">{result}</pre>}
  </div>;
}

function PluginCard({ plugin, isAdmin, refresh }: { plugin: InstalledPlugin; isAdmin: boolean; refresh: () => Promise<void> }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [executions, setExecutions] = useState<PluginExecution[]>([]);
  const [connections, setConnections] = useState<PluginConnection[]>([]);
  const [connectionValues, setConnectionValues] = useState<Record<string, string>>({});
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});
  const [settingDraft, setSettingDraft] = useState<Record<string, unknown>>({});
  const runtimePresentation = getPluginRuntimePresentation(plugin);
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); try { await operation(); await refresh(); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const toggleDetails = async () => {
    const next = !expanded; setExpanded(next);
    if (next) {
      const [runs, configured, settings] = await Promise.all([
        runtimePresentation.canExecuteActions ? pluginApi.executions(plugin.id).catch(() => []) : Promise.resolve([] as PluginExecution[]),
        runtimePresentation.canExecuteActions ? pluginApi.connections(plugin.id).catch(() => []) : Promise.resolve([] as PluginConnection[]),
        pluginApi.settings(plugin.id).catch(() => ({})),
      ]);
      setExecutions(runs); setConnections(configured); setSettingValues(settings);
    }
  };
  return <div className="space-y-3.5 rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm transition-all hover:border-purple-400/40 hover:shadow-sm">
    {plugin.id === "nowenlab.wechat-capture" && <WechatCaptureSettings />}
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-500/20 via-pink-400/18 to-violet-500/20 text-purple-600 ring-1 ring-purple-500/20 dark:text-purple-300">
          <Puzzle size={18} />
        </span>
        <div className="min-w-0">
          <h3 className="font-bold text-tx-primary">{plugin.id === "nowenlab.wechat-capture" ? t("wechatCapture.title") : plugin.name}</h3>
          <p className="truncate font-mono text-[11px] text-tx-tertiary">{plugin.id}</p>
          <p className="mt-1.5 text-xs leading-relaxed text-tx-secondary">{plugin.id === "nowenlab.wechat-capture" ? t("wechatCapture.cardDescription") : plugin.description}</p>
        </div>
      </div>
      <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${plugin.status === "enabled" ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : plugin.status === "error" ? "bg-rose-500/12 text-rose-600 dark:text-rose-300" : "bg-amber-500/12 text-amber-700 dark:text-amber-300"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${plugin.status === "enabled" ? "bg-emerald-500" : plugin.status === "error" ? "bg-rose-500" : "bg-amber-500"}`} />
        {statusLabel(plugin.status)}
      </span>
    </div>
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-tx-secondary">
      <span className="rounded-full bg-app-surface px-2.5 py-0.5 font-mono font-semibold ring-1 ring-app-border/60">v{plugin.version}</span>
      <span className="inline-flex items-center gap-1 rounded-full bg-app-surface px-2.5 py-0.5 font-medium ring-1 ring-app-border/60"><ShieldCheck size={11} className="text-purple-500" />{plugin.trustLevel}</span>
      {plugin.signatureState === "verified" && <span className="rounded-full bg-emerald-500/12 px-2.5 py-0.5 font-semibold text-emerald-700 dark:text-emerald-300">签名已验证</span>}
      {plugin.advisoryState && plugin.advisoryState !== "unknown" && <span className="rounded-full bg-rose-500/12 px-2.5 py-0.5 font-semibold text-rose-600 dark:text-rose-300">安全：{plugin.advisoryState}</span>}
      {runtimePresentation.declarative ? <>
        <span className="rounded-full bg-purple-500/12 px-2.5 py-0.5 font-medium text-purple-700 dark:text-purple-300">{runtimePresentation.runtimeLabel}</span>
        <span className="rounded-full bg-emerald-500/12 px-2.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">{runtimePresentation.executionLabel}</span>
        <span className="rounded-full bg-emerald-500/12 px-2.5 py-0.5 font-medium text-emerald-700 dark:text-emerald-300">{runtimePresentation.permissionLabel}</span>
      </> : <span className="rounded-full bg-app-surface px-2.5 py-0.5 ring-1 ring-app-border/60">{plugin.apiVersion === 3 ? t("pluginApps.executionLabel") : runtimePresentation.executionLabel}</span>}
    </div>
    {runtimePresentation.declarative && <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/[0.07] p-3 text-xs leading-relaxed text-emerald-800 dark:text-emerald-200"><div className="flex gap-2"><ShieldCheck className="mt-0.5 shrink-0 text-emerald-500" size={14} /><span>此扩展只注册声明式资源：不会启动 Worker / Node / QuickJS，不可执行 Action，也不能申请笔记、附件、网络或密钥数据权限。</span></div></div>}
    {plugin.nodeRuntimeConfirmedAt && <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-200">Node Runtime 已由 {plugin.nodeRuntimeConfirmedBy || "管理员"} 于 {formatAppDateTime(plugin.nodeRuntimeConfirmedAt)} 确认。</div>}
    {plugin.compatibility?.allowed === false && <div className="rounded-xl border border-rose-400/35 bg-rose-500/10 p-2.5 text-xs text-rose-700 dark:text-rose-300">兼容性拒绝：{plugin.compatibility.reason}（{plugin.compatibility.code}）</div>}
    {!!plugin.probationRemaining && <div className="rounded-xl border border-sky-400/35 bg-sky-500/10 p-2.5 text-xs text-sky-800 dark:text-sky-200">新版本安全试运行中：剩余 {plugin.probationRemaining} 次；崩溃将自动回滚。</div>}
    {!!plugin.permissionDiff?.added.length && <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-200">此更新新增权限：{plugin.permissionDiff.added.join("、")}，必须重新确认。</div>}
    <div className="flex flex-wrap gap-2">
      <button onClick={toggleDetails} className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-xl border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-semibold text-tx-primary transition-colors hover:border-purple-400/50 hover:text-purple-600 dark:hover:text-purple-300">详情 {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button>
      {isAdmin && plugin.status === "enabled" && <button disabled={busy} onClick={() => act(() => pluginApi.disable(plugin.id))} className="shrink-0 whitespace-nowrap rounded-xl border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-semibold text-tx-secondary transition-colors hover:bg-app-hover hover:text-tx-primary">禁用</button>}
      {isAdmin && plugin.status !== "enabled" && <button disabled={busy} onClick={() => act(async () => { if (runtimePresentation.requiresPermissionConfirmation) await pluginApi.grant(plugin.id, plugin.permissions.map((item) => item.permission)); await pluginApi.enable(plugin.id); })} className="shrink-0 whitespace-nowrap rounded-xl bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 px-3.5 py-1.5 text-xs font-semibold text-white shadow-xs transition-all hover:-translate-y-0.5">{runtimePresentation.enableLabel}</button>}
      {isAdmin && runtimePresentation.canExecuteActions && <button disabled={busy} onClick={() => act(() => pluginApi.reload(plugin.id))} aria-label={t("extensionCenter.action.reload")} className="rounded-xl border border-app-border/80 bg-app-surface px-2.5 py-1.5 text-xs text-tx-secondary transition-colors hover:border-purple-400/50 hover:text-purple-600 disabled:opacity-40"><RefreshCw size={12} /></button>}
      {isAdmin && plugin.previousVersion && <button disabled={busy} onClick={() => window.confirm(`回滚到 ${plugin.previousVersion}？插件数据不会回滚。`) && act(() => pluginApi.rollback(plugin.id, plugin.previousVersion || undefined))} className="inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded-xl border border-app-border/80 bg-app-surface px-3 py-1.5 text-xs font-semibold text-tx-secondary transition-colors hover:border-amber-400/50 hover:text-amber-600"><RotateCcw size={12} />回滚 {plugin.previousVersion}</button>}
      {isAdmin && <button disabled={busy} onClick={() => window.confirm(plugin.contributes?.appPages?.length ? t("pluginApps.uninstallRetain", { name: plugin.name }) : `确定卸载 ${plugin.name}？`) && act(() => pluginApi.uninstall(plugin.id, false, Boolean(plugin.contributes?.appPages?.length)))} aria-label={t(plugin.contributes?.appPages?.length ? "extensionCenter.action.uninstallRetain" : "extensionCenter.action.uninstall")} className="rounded-xl border border-rose-400/35 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-600 transition-colors hover:bg-rose-500/15 dark:text-rose-300"><Trash2 size={12} /></button>}
      {isAdmin && plugin.contributes?.appPages?.length && <button disabled={busy} onClick={() => window.confirm(t("pluginApps.uninstallData", { name: plugin.name })) && act(() => pluginApi.uninstall(plugin.id, true))} className="shrink-0 whitespace-nowrap rounded-xl border border-rose-400/35 bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-600 transition-colors hover:bg-rose-500/15 dark:text-rose-300">{t("pluginApps.deleteWithData")}</button>}
    </div>
    {expanded && <div className="space-y-4 border-t border-app-border/70 pt-3.5">
      {plugin.id !== "nowenlab.wechat-capture" && !!plugin.contributes?.inboundWebhooks?.length && <PluginInboundSettings plugin={plugin} />}
      <div><h4 className="mb-2 text-xs font-bold text-tx-primary">权限</h4><ul className="space-y-1.5">{plugin.permissions.length ? plugin.permissions.map((item) => <li key={item.permission} className="flex items-center gap-2 rounded-lg bg-app-surface/65 px-2.5 py-1.5 text-xs text-tx-secondary">{item.granted ? <CheckCircle2 size={13} className="shrink-0 text-emerald-500" /> : <AlertTriangle size={13} className="shrink-0 text-amber-500" />}{permissionLabels[item.permission] || item.permission}<span className="ml-auto font-mono text-[10px] text-tx-tertiary">{item.permission}</span></li>) : <li className="text-xs text-tx-tertiary">{runtimePresentation.declarative ? "零数据权限（Manifest 安装阶段强制）" : "不请求数据权限"}</li>}</ul></div>
      {plugin.id !== "nowenlab.wechat-capture" && (runtimePresentation.canExecuteActions ? <div className="space-y-2"><h4 className="text-xs font-bold text-tx-primary">Actions</h4>{plugin.actions.map((action) => <ActionTester key={action.id} plugin={plugin} action={action} />)}</div> : <div className="rounded-xl border border-app-border/70 bg-app-surface/65 p-3 text-xs text-tx-secondary">执行能力：无。声明式扩展不能执行 Action，也不会创建代码 Runner。</div>)}
      {plugin.id !== "nowenlab.wechat-capture" && !!connections.length && <div className="space-y-2"><h4 className="flex items-center gap-1.5 text-xs font-bold text-tx-primary"><KeyRound size={13} className="text-purple-500" />连接</h4>{connections.map((connection) => <div key={connection.id} className="rounded-xl border border-app-border/80 bg-app-surface/75 p-3"><div className="flex items-center justify-between text-xs"><span className="font-semibold text-tx-primary">{connection.name} · {connection.type}</span><span className={connection.configured ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-tx-tertiary"}>{connection.configured ? "已配置" : "未配置"}</span></div><div className="mt-2 flex gap-2"><input type="password" value={connectionValues[connection.id] || ""} onChange={(event) => setConnectionValues((current) => ({ ...current, [connection.id]: event.target.value }))} placeholder="密钥仅由 Host 加密保存并注入" className="min-w-0 flex-1 rounded-xl border border-app-border/80 bg-app-elevated px-3 py-1.5 text-xs text-tx-primary outline-none focus:border-purple-400" /><button onClick={() => act(async () => { await pluginApi.setConnection(plugin.id, connection.id, connectionValues[connection.id] || ""); setConnections(await pluginApi.connections(plugin.id)); setConnectionValues((current) => ({ ...current, [connection.id]: "" })); })} className="rounded-xl border border-app-border/80 bg-app-elevated px-3 text-xs font-semibold text-tx-primary hover:border-purple-400/50">保存</button>{connection.configured && <button onClick={() => act(async () => { await pluginApi.removeConnection(plugin.id, connection.id); setConnections(await pluginApi.connections(plugin.id)); })} className="rounded-xl border border-rose-400/35 px-3 text-xs font-semibold text-rose-500 hover:bg-rose-500/10">清除</button>}</div></div>)}</div>}
      {plugin.id !== "nowenlab.wechat-capture" && !!plugin.contributes?.settings?.length && <div className="space-y-2"><h4 className="text-xs font-bold text-tx-primary">插件设置</h4>{plugin.contributes.settings.map((setting) => <label key={setting.key} className="block rounded-xl border border-app-border/80 bg-app-surface/75 p-3 text-xs"><span className="font-semibold text-tx-primary">{setting.title}</span>{setting.description && <span className="ml-2 text-tx-secondary">{setting.description}</span>}{setting.type === "boolean" ? <input type="checkbox" className="ml-3 accent-purple-600" checked={Boolean(settingDraft[setting.key] ?? settingValues[setting.key] ?? setting.default)} onChange={(event) => setSettingDraft((current) => ({ ...current, [setting.key]: event.target.checked }))} /> : setting.type === "select" ? <select className="mt-2 block w-full rounded-xl border border-app-border/80 bg-app-elevated px-3 py-1.5 text-tx-primary outline-none" value={String(settingDraft[setting.key] ?? settingValues[setting.key] ?? setting.default ?? "")} onChange={(event) => setSettingDraft((current) => ({ ...current, [setting.key]: event.target.value }))}>{(setting.options || []).map((option) => <option key={String(option)} value={String(option)}>{option}</option>)}</select> : <input type={setting.secret ? "password" : setting.type === "number" ? "number" : "text"} className="mt-2 block w-full rounded-xl border border-app-border/80 bg-app-elevated px-3 py-1.5 text-tx-primary outline-none focus:border-purple-400" value={String(settingDraft[setting.key] ?? (setting.secret ? "" : settingValues[setting.key] ?? setting.default ?? ""))} placeholder={setting.secret && settingValues[setting.key] ? "已安全保存；输入新值以替换" : ""} onChange={(event) => setSettingDraft((current) => ({ ...current, [setting.key]: setting.type === "number" ? Number(event.target.value) : event.target.value }))} />}</label>)}<button disabled={!Object.keys(settingDraft).length} onClick={() => act(async () => { setSettingValues(await pluginApi.setSettings(plugin.id, settingDraft)); setSettingDraft({}); })} className="rounded-xl bg-gradient-to-r from-purple-500 to-pink-500 px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-40">保存设置</button></div>}
      {!!plugin.contributes?.automationTemplates?.length && <div className="space-y-2"><h4 className="text-xs font-bold text-tx-primary">Automation 模板</h4>{plugin.contributes.automationTemplates.map((template) => <div key={template.id} className="flex items-center justify-between gap-2 rounded-xl border border-app-border/80 bg-app-surface/75 p-3 text-xs"><div><div className="font-semibold text-tx-primary">{template.title}</div><div className="text-tx-secondary">{template.description || "安装后保持禁用，需在自动化中心确认"}</div></div><button onClick={() => act(() => pluginApi.installAutomationTemplate(plugin.id, template.id))} className="shrink-0 whitespace-nowrap rounded-xl border border-purple-500/30 bg-purple-500/10 px-3 py-1.5 font-semibold text-purple-700 hover:bg-purple-500/15 dark:text-purple-300">安装模板</button></div>)}</div>}
      <div><h4 className="mb-2 text-xs font-bold text-tx-primary">版本</h4><div className="flex flex-wrap gap-1.5">{plugin.versions?.map((version) => <span key={version.version} className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${version.version === plugin.version ? "bg-purple-500/15 text-purple-700 dark:text-purple-300" : "bg-app-surface text-tx-secondary ring-1 ring-app-border/60"}`}>{version.version}</span>)}</div></div>
      <div><h4 className="mb-2 text-xs font-bold text-tx-primary">最近执行</h4>{runtimePresentation.declarative ? <p className="text-xs text-tx-tertiary">声明式扩展没有执行进程或执行记录。</p> : executions.length ? <div className="max-h-48 space-y-1.5 overflow-auto">{executions.map((item) => { const progress = item.progressTotal ? Math.min(100, Math.round(((item.progressCurrent || 0) / item.progressTotal) * 100)) : null; return <div key={item.id} className="rounded-xl border border-app-border/60 bg-app-surface/75 p-2.5 text-[11px]"><span className="font-mono font-semibold text-tx-primary">{item.actionId}</span> · <span className="text-tx-secondary">{item.status} · {item.durationMs ?? "—"}ms</span>{progress !== null && <div className="mt-1.5"><div className="h-1.5 overflow-hidden rounded-full bg-app-hover"><div className="h-full rounded-full bg-gradient-to-r from-purple-500 to-pink-500" style={{ width: `${progress}%` }} /></div><div className="mt-1 text-tx-tertiary">{item.progressMessage || `${item.progressCurrent || 0} / ${item.progressTotal}`}</div></div>}{item.errorMessage && <div className="mt-1 text-rose-500">{item.errorMessage}</div>}</div>; })}</div> : <p className="text-xs text-tx-tertiary">暂无执行记录</p>}</div>
    </div>}
  </div>;
}

export default function PluginSettingsTab({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"installed" | "updates" | "developer">("installed");
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingPackage | null>(null);
  const [installing, setInstalling] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [developerModeAvailable, setDeveloperModeAvailable] = useState(false);
  const [devDirectory, setDevDirectory] = useState("");
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [newSourceKeyId, setNewSourceKeyId] = useState("");
  const [newSourcePublicKey, setNewSourcePublicKey] = useState("");
  const [updates, setUpdates] = useState<PluginUpdate[]>([]);
  const [updateSource, setUpdateSource] = useState("official-v2");
  const inputRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => { setPlugins(await pluginApi.list()); setLoading(false); }, []);
  useEffect(() => { void refresh().catch(() => setLoading(false)); if (isAdmin) void pluginApi.getDeveloperMode().then((value) => { setDeveloperMode(value.enabled); setDeveloperModeAvailable(value.available); }).catch(() => {}); }, [isAdmin, refresh]);
  // Browsing and installing from sources happens in the Extension Center's "Discover"; this page keeps the administrator tooling.
  useEffect(() => {
    if (tab !== "developer") return;
    void pluginApi.registrySources().then(setSources).catch(() => setSources([]));
  }, [tab]);
  const pendingRuntimePresentation = pending ? getPluginRuntimePresentation(pending.manifest) : null;
  const choosePackage = async (file?: File) => {
    if (!file) return;
    try {
      const zip = await JSZip.loadAsync(file);
      const manifestFile = zip.file("manifest.json");
      if (!manifestFile) throw new Error("插件包缺少 manifest.json");
      setPending({ file, manifest: JSON.parse(await manifestFile.async("string")) as PendingManifest, nodeRuntimeConfirmationRequired: false });
    } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
  };
  const install = async () => {
    if (!pending) return;
    setInstalling(true);
    try {
      await pluginApi.install(pending.file, pending.nodeRuntimeConfirmationRequired);
      setPending(null);
      if (inputRef.current) inputRef.current.value = "";
      await refresh();
    } catch (error) {
      const coded = error as Error & { code?: string; confirmNodeRuntimeAllowed?: boolean };
      if (coded.code === "PLUGIN_NODE_RUNTIME_CONFIRMATION_REQUIRED" && coded.confirmNodeRuntimeAllowed) {
        setPending((current) => current ? { ...current, nodeRuntimeConfirmationRequired: true } : current);
      } else {
        window.alert(coded.message || String(error));
      }
    } finally {
      setInstalling(false);
    }
  };
  const loadDevelopment = async () => {
    try {
      await pluginApi.loadDevelopment(devDirectory);
    } catch (error) {
      const coded = error as Error & { code?: string; confirmNodeRuntimeAllowed?: boolean };
      if (coded.code !== "PLUGIN_NODE_RUNTIME_CONFIRMATION_REQUIRED" || !coded.confirmNodeRuntimeAllowed) throw error;
      const confirmed = window.confirm("此 V2 开发插件将在独立 Node 进程中运行，不能由 QuickJS/WASM Sandbox 隔离，并可使用获准的文件系统与网络权限。确认信任并继续加载？");
      if (!confirmed) return;
      await pluginApi.loadDevelopment(devDirectory, true);
    }
    await refresh();
    setTab("installed");
  };
  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-2xl border border-app-border/80 bg-gradient-to-br from-purple-500/[0.08] via-app-elevated/85 to-pink-500/[0.07] p-5 shadow-xs backdrop-blur-sm">
        <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-pink-400/15 blur-2xl" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3.5">
            <motion.span
              whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
              transition={{ duration: 0.45 }}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-purple-500/20 via-pink-400/18 to-violet-500/20 text-purple-600 shadow-xs ring-1 ring-purple-500/25 dark:text-purple-300"
            >
              <Puzzle size={20} />
            </motion.span>
            <div>
              <h2 className="text-base font-bold tracking-tight text-tx-primary">{t("extensionCenter.advanced.title")}</h2>
              <p className="mt-0.5 text-xs leading-relaxed text-tx-secondary">{t("extensionCenter.advanced.description")}</p>
            </div>
          </div>
          {isAdmin && tab === "installed" && (
            <>
              <input ref={inputRef} type="file" accept=".nowen-plugin" className="hidden" onChange={(event) => void choosePackage(event.target.files?.[0])} />
              <button
                onClick={() => inputRef.current?.click()}
                className="inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 rounded-xl bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 px-4 py-2 text-xs font-semibold text-white shadow-sm shadow-purple-500/20 transition-all hover:-translate-y-0.5 hover:shadow-md"
              >
                <PackagePlus size={14} />{t("pluginApps.install")}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex gap-1 rounded-2xl border border-app-border/80 bg-app-surface/80 p-1 shadow-xs">
        {(["installed", "updates", "developer"] as const).map((item) => (
          <button
            key={item}
            onClick={() => setTab(item)}
            className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold transition-all ${tab === item ? "bg-app-elevated text-purple-600 shadow-xs dark:text-purple-300" : "text-tx-secondary hover:text-tx-primary"}`}
          >
            {item === "installed" ? "调试与恢复" : item === "updates" ? "更新与安全" : "来源与开发者"}
          </button>
        ))}
      </div>

      {isAdmin && tab === "installed" && <PluginRuntimePolicySettings />}

      {tab === "installed" && (
        loading ? (
          <div className="flex items-center justify-center gap-2 rounded-2xl border border-app-border/70 bg-app-elevated/60 py-12 text-sm text-tx-tertiary">
            <Loader2 className="animate-spin text-purple-500" size={16} />正在加载插件
          </div>
        ) : plugins.length ? (
          <div className="grid gap-3.5">{plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} isAdmin={isAdmin} refresh={refresh} />)}</div>
        ) : (
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-app-border/80 bg-app-elevated/55 py-12 text-center">
            <span className="mb-2.5 flex h-11 w-11 items-center justify-center rounded-2xl bg-purple-500/10 text-purple-500">
              <Puzzle size={22} />
            </span>
            <p className="text-sm font-medium text-tx-secondary">尚未安装插件</p>
          </div>
        )
      )}

      {tab === "updates" && (
        <div className="space-y-3.5 rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm">
          <div>
            <h3 className="text-sm font-bold text-tx-primary">更新与安全</h3>
            <p className="mt-1 text-xs text-tx-secondary">仅接受签名 Registry 的不可变版本；新增权限、Runtime 或 API 变化必须人工确认。</p>
          </div>
          <div className="flex gap-2">
            <input
              value={updateSource}
              onChange={(event) => setUpdateSource(event.target.value)}
              placeholder="V2 Registry Source ID"
              className="min-w-0 flex-1 rounded-xl border border-app-border/80 bg-app-surface px-3.5 py-2 text-xs text-tx-primary outline-none focus:border-purple-400 focus:ring-2 focus:ring-purple-500/15"
            />
            <button
              disabled={!isAdmin}
              onClick={async () => { try { setUpdates(await pluginApi.checkUpdates(updateSource)); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); } }}
              className="shrink-0 whitespace-nowrap rounded-xl bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-all hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
            >
              检查更新
            </button>
          </div>
          {updates.length ? (
            <div className="space-y-2">
              {updates.map((update) => (
                <div key={update.pluginId} className="rounded-xl border border-app-border/75 bg-app-surface/75 p-3.5 text-xs">
                  <div className="font-mono font-semibold text-tx-primary">{update.pluginId}</div>
                  <div className="mt-1 text-tx-secondary">{update.currentVersion} → {update.availableVersion}</div>
                  {update.permissionDiff.added.length > 0 && <div className="mt-1 text-amber-600 dark:text-amber-400">新增权限：{update.permissionDiff.added.join("、")}</div>}
                  <div className="mt-1 text-tx-tertiary">{update.confirmationRequired ? "需要管理员确认" : "符合自动更新条件"}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-tx-tertiary">尚未检查，或没有可用更新。</p>
          )}
        </div>
      )}

      {tab === "developer" && (
        isAdmin && developerModeAvailable ? (
          <div className="space-y-3.5 rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-bold text-tx-primary"><Code2 size={15} className="text-purple-500" />开发者模式</h3>
                <p className="mt-1 text-xs text-tx-secondary">本地目录仍需 Validate、Preflight 和权限确认；开发插件不进入备份。</p>
              </div>
              <input
                type="checkbox"
                checked={developerMode}
                onChange={async (event) => { const enabled = event.target.checked; await pluginApi.setDeveloperMode(enabled); setDeveloperMode(enabled); }}
                className="h-4 w-4 rounded accent-purple-600"
              />
            </div>
            {developerMode && (
              <div className="flex gap-2">
                <input
                  value={devDirectory}
                  onChange={(event) => setDevDirectory(event.target.value)}
                  placeholder="D:\\Projects\\nowen-plugin-test"
                  className="min-w-0 flex-1 rounded-xl border border-app-border/80 bg-app-surface px-3.5 py-2 text-xs text-tx-primary outline-none focus:border-purple-400"
                />
                <button
                  onClick={() => void loadDevelopment().catch((error) => window.alert(error instanceof Error ? error.message : String(error)))}
                  className="shrink-0 whitespace-nowrap rounded-xl border border-purple-500/35 bg-purple-500/10 px-3.5 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-500/15 dark:text-purple-300"
                >
                  Validate & Load
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-dashed border-app-border/80 bg-app-elevated/55 py-10 text-center text-sm text-tx-tertiary">
            开发者模式仅对管理员和本地 Desktop Backend 开放。
          </div>
        )
      )}

      {tab === "developer" && isAdmin && (
        <div className="rounded-2xl border border-app-border/80 bg-app-elevated/80 p-5 shadow-xs backdrop-blur-sm">
          <h3 className="text-sm font-bold text-tx-primary">Registry 来源与国内镜像</h3>
          <p className="mt-1 text-xs text-tx-secondary">官方源使用客户端内置 Ed25519 信任根；自定义源必须提供 HTTPS Index 和管理员固定的 Registry 公钥。</p>
          <div className="mt-3 space-y-1.5">
            {sources.map((source) => (
              <div key={source.id} className="rounded-xl border border-app-border/70 bg-app-surface/75 px-3 py-2 text-[11px]">
                <div className="truncate font-semibold text-tx-primary">{source.name} · {source.indexUrl}</div>
                <div className="mt-0.5 text-tx-tertiary">{source.official ? "客户端内置信任根" : `Pinned key: ${source.registryKeyId}`}</div>
              </div>
            ))}
          </div>
          <div className="mt-3.5 grid gap-2.5 sm:grid-cols-2">
            <input value={newSourceName} onChange={(event) => setNewSourceName(event.target.value)} placeholder="镜像名称" className="rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-xs text-tx-primary outline-none focus:border-purple-400" />
            <input value={newSourceUrl} onChange={(event) => setNewSourceUrl(event.target.value)} placeholder="https://mirror.example/v2/index.json" className="rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-xs text-tx-primary outline-none focus:border-purple-400" />
            <input value={newSourceKeyId} onChange={(event) => setNewSourceKeyId(event.target.value)} placeholder="Registry Key ID" className="rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 text-xs text-tx-primary outline-none focus:border-purple-400" />
            <textarea value={newSourcePublicKey} onChange={(event) => setNewSourcePublicKey(event.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" className="min-h-20 rounded-xl border border-app-border/80 bg-app-surface px-3 py-2 font-mono text-xs text-tx-primary outline-none focus:border-purple-400" />
          </div>
          <button
            onClick={async () => {
              const id = `mirror-${Date.now().toString(36)}`;
              const updated = await pluginApi.setRegistrySource({ id, name: newSourceName || "Custom Registry", indexUrl: newSourceUrl, registryKeyId: newSourceKeyId, registryPublicKey: newSourcePublicKey });
              setSources(updated); setNewSourceName(""); setNewSourceUrl(""); setNewSourceKeyId(""); setNewSourcePublicKey("");
            }}
            className="mt-3 rounded-xl border border-purple-500/35 bg-purple-500/10 px-4 py-2 text-xs font-semibold text-purple-700 transition-colors hover:bg-purple-500/15 dark:text-purple-300"
          >
            添加自定义源
          </button>
        </div>
      )}

      {pending && pendingRuntimePresentation && (
        <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg space-y-4 rounded-2xl border border-app-border/80 bg-app-elevated p-5 shadow-2xl">
            <div>
              <h3 className="text-base font-bold text-tx-primary">安装 {pending.manifest.name || "社区插件"}</h3>
              <p className="mt-1 font-mono text-xs text-tx-tertiary">{pending.manifest.id} · v{pending.manifest.version}</p>
            </div>
            {pendingRuntimePresentation.declarative ? (
              <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-800 dark:text-emerald-200">
                <div className="flex gap-2"><ShieldCheck className="mt-0.5 shrink-0 text-emerald-500" size={16} /><span>这是声明式零代码扩展：不会运行 JS / WASM / Node，不执行 Action，也不能请求笔记、附件、网络或密钥数据权限。安装仍会校验签名、校验和与兼容性。</span></div>
              </div>
            ) : (
              <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
                <div className="flex gap-2"><AlertTriangle className="mt-0.5 shrink-0 text-amber-500" size={16} /><span>{pending.nodeRuntimeConfirmationRequired ? "此 V2 插件将在独立 Node 进程中执行二进制/Node 代码，可使用获准的文件系统与网络权限，且不能由 QuickJS/WASM Sandbox 隔离。请仅在完全信任来源时继续。" : "此插件包含第三方可执行代码；安装前将校验兼容性、信任等级和 Runtime 策略。"}</span></div>
              </div>
            )}
            <div>
              <h4 className="mb-2 text-xs font-bold text-tx-primary">权限与执行边界：</h4>
              <ul className="space-y-1 text-xs text-tx-secondary">{pending.manifest.permissions?.length ? pending.manifest.permissions.map((permission: string) => <li key={permission}>✓ {permissionLabels[permission] || permission}</li>) : <li className="text-tx-tertiary">{pendingRuntimePresentation.declarative ? "零数据权限（由 Manifest 校验强制保证）" : "不请求数据权限"}</li>}</ul>
              {(pending.manifest.permissionConfig?.externalFetchHosts?.length ?? 0) > 0 && <p className="mt-2 text-xs text-tx-tertiary">网络访问：{pending.manifest.permissionConfig?.externalFetchHosts?.join(", ")}</p>}
            </div>
            <p className="text-xs text-tx-secondary">{pendingRuntimePresentation.declarative ? "安装后默认进入隔离状态；启用只会注册声明资源，不会启动代码 Runner。" : pending.nodeRuntimeConfirmationRequired ? "确认后将使用同一文件重新提交；取消则不会安装。" : "安装后默认进入隔离状态；你需要再次确认权限并启用。"}</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setPending(null); if (inputRef.current) inputRef.current.value = ""; }} className="rounded-xl border border-app-border/80 bg-app-surface px-4 py-2 text-xs font-semibold text-tx-secondary hover:bg-app-hover">取消</button>
              <button disabled={installing} onClick={install} className="rounded-xl bg-gradient-to-r from-purple-500 via-fuchsia-500 to-pink-500 px-4 py-2 text-xs font-semibold text-white shadow-sm disabled:opacity-50">{installing ? "正在验证" : pendingRuntimePresentation.declarative ? "安装声明式扩展" : pending.nodeRuntimeConfirmationRequired ? "确认 Node 风险并安装" : "继续安装"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
