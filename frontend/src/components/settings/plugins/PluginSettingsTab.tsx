import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Code2, Download, KeyRound, Loader2, PackagePlus, Play, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { pluginApi, type InstalledPlugin, type PluginAction, type PluginConnection, type PluginExecution, type PluginUpdate, type RegistryPlugin, type RegistrySource } from "@/lib/pluginApi";

const permissionLabels: Record<string, string> = {
  "notes:read": "读取笔记", "notes:write": "创建和修改笔记",
  "notebooks:read": "读取笔记本", "notebooks:write": "创建和修改笔记本",
  "tags:read": "读取标签", "tags:write": "创建和修改标签",
  "tasks:read": "读取任务", "tasks:write": "创建和修改任务",
  "attachments:read": "读取附件信息", "attachments:write": "创建和修改附件",
  "plugin-storage:read": "读取插件自己的数据", "plugin-storage:write": "保存插件自己的数据",
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
  return <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 space-y-2">
    <div><div className="text-sm font-medium">{action.name}</div><div className="text-xs text-zinc-500">{action.description || action.id}</div></div>
    <textarea value={input} onChange={(event) => setInput(event.target.value)} className="w-full min-h-24 rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent p-2 font-mono text-xs" aria-label={`${action.name} 参数`} />
    <button onClick={run} disabled={running || plugin.status !== "enabled"} className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"><Play size={13} />{running ? "执行中" : "执行"}</button>
    {result && <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-100 dark:bg-zinc-900 p-2 text-xs">{result}</pre>}
  </div>;
}

function PluginCard({ plugin, isAdmin, refresh }: { plugin: InstalledPlugin; isAdmin: boolean; refresh: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [executions, setExecutions] = useState<PluginExecution[]>([]);
  const [connections, setConnections] = useState<PluginConnection[]>([]);
  const [connectionValues, setConnectionValues] = useState<Record<string, string>>({});
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});
  const [settingDraft, setSettingDraft] = useState<Record<string, unknown>>({});
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); try { await operation(); await refresh(); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const toggleDetails = async () => {
    const next = !expanded; setExpanded(next);
    if (next) {
      const [runs, configured, settings] = await Promise.all([pluginApi.executions(plugin.id).catch(() => []), pluginApi.connections(plugin.id).catch(() => []), pluginApi.settings(plugin.id).catch(() => ({}))]);
      setExecutions(runs); setConnections(configured); setSettingValues(settings);
    }
  };
  return <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><h3 className="font-semibold text-zinc-900 dark:text-zinc-100">🧩 {plugin.name}</h3><p className="font-mono text-[11px] text-zinc-400 truncate">{plugin.id}</p><p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{plugin.description}</p></div>
      <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${plugin.status === "enabled" ? "bg-emerald-500/15 text-emerald-600" : plugin.status === "error" ? "bg-red-500/15 text-red-600" : "bg-amber-500/15 text-amber-600"}`}>{statusLabel(plugin.status)}</span>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500"><span>v{plugin.version}</span><span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 dark:bg-zinc-900"><ShieldCheck size={11} />{plugin.trustLevel}</span>{plugin.signatureState === "verified" && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-600">签名已验证</span>}{plugin.advisoryState && plugin.advisoryState !== "unknown" && <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-red-600">安全：{plugin.advisoryState}</span>}<span>{plugin.actions.length} Actions</span></div>
    {plugin.nodeRuntimeConfirmedAt && <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-950/20 dark:text-amber-300">Node Runtime 已由 {plugin.nodeRuntimeConfirmedBy || "管理员"} 于 {new Date(plugin.nodeRuntimeConfirmedAt).toLocaleString()} 确认。</div>}
    {plugin.compatibility?.allowed === false && <div className="rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/20 dark:text-red-300">兼容性拒绝：{plugin.compatibility.reason}（{plugin.compatibility.code}）</div>}
    {!!plugin.probationRemaining && <div className="rounded-md bg-sky-50 p-2 text-xs text-sky-700 dark:bg-sky-950/20 dark:text-sky-300">新版本安全试运行中：剩余 {plugin.probationRemaining} 次；崩溃将自动回滚。</div>}
    {!!plugin.permissionDiff?.added.length && <div className="rounded-md bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-950/20 dark:text-amber-300">此更新新增权限：{plugin.permissionDiff.added.join("、")}，必须重新确认。</div>}
    <div className="flex flex-wrap gap-2">
      <button onClick={toggleDetails} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs">详情 {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button>
      {isAdmin && plugin.status === "enabled" && <button disabled={busy} onClick={() => act(() => pluginApi.disable(plugin.id))} className="rounded-md border px-2.5 py-1.5 text-xs">禁用</button>}
      {isAdmin && plugin.status !== "enabled" && <button disabled={busy} onClick={() => act(async () => { await pluginApi.grant(plugin.id, plugin.permissions.map((item) => item.permission)); await pluginApi.enable(plugin.id); })} className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs text-white">确认权限并启用</button>}
      {isAdmin && <button disabled={busy} onClick={() => act(() => pluginApi.reload(plugin.id))} className="rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-40"><RefreshCw size={12} /></button>}
      {isAdmin && plugin.previousVersion && <button disabled={busy} onClick={() => window.confirm(`回滚到 ${plugin.previousVersion}？插件数据不会回滚。`) && act(() => pluginApi.rollback(plugin.id, plugin.previousVersion || undefined))} className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs"><RotateCcw size={12} />回滚 {plugin.previousVersion}</button>}
      {isAdmin && <button disabled={busy} onClick={() => window.confirm(`确定卸载 ${plugin.name}？`) && act(() => pluginApi.uninstall(plugin.id))} className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-600"><Trash2 size={12} /></button>}
    </div>
    {expanded && <div className="space-y-4 border-t border-zinc-200 dark:border-zinc-800 pt-3">
      <div><h4 className="mb-2 text-xs font-semibold">权限</h4><ul className="space-y-1">{plugin.permissions.length ? plugin.permissions.map((item) => <li key={item.permission} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">{item.granted ? <CheckCircle2 size={13} className="text-emerald-500" /> : <AlertTriangle size={13} className="text-amber-500" />}{permissionLabels[item.permission] || item.permission}<span className="ml-auto font-mono text-[10px] text-zinc-400">{item.permission}</span></li>) : <li className="text-xs text-zinc-500">不请求数据权限</li>}</ul></div>
      <div className="space-y-2"><h4 className="text-xs font-semibold">Actions</h4>{plugin.actions.map((action) => <ActionTester key={action.id} plugin={plugin} action={action} />)}</div>
      {!!connections.length && <div className="space-y-2"><h4 className="flex items-center gap-1.5 text-xs font-semibold"><KeyRound size={13} />连接</h4>{connections.map((connection) => <div key={connection.id} className="rounded-lg border border-zinc-200 p-2 dark:border-zinc-800"><div className="flex items-center justify-between text-xs"><span>{connection.name} · {connection.type}</span><span className={connection.configured ? "text-emerald-600" : "text-zinc-400"}>{connection.configured ? "已配置" : "未配置"}</span></div><div className="mt-2 flex gap-2"><input type="password" value={connectionValues[connection.id] || ""} onChange={(event) => setConnectionValues((current) => ({ ...current, [connection.id]: event.target.value }))} placeholder="密钥仅由 Host 加密保存并注入" className="min-w-0 flex-1 rounded-md border bg-transparent px-2 py-1.5 text-xs dark:border-zinc-700" /><button onClick={() => act(async () => { await pluginApi.setConnection(plugin.id, connection.id, connectionValues[connection.id] || ""); setConnections(await pluginApi.connections(plugin.id)); setConnectionValues((current) => ({ ...current, [connection.id]: "" })); })} className="rounded-md border px-2 text-xs">保存</button>{connection.configured && <button onClick={() => act(async () => { await pluginApi.removeConnection(plugin.id, connection.id); setConnections(await pluginApi.connections(plugin.id)); })} className="rounded-md border px-2 text-xs text-red-600">清除</button>}</div></div>)}</div>}
      {!!plugin.contributes?.settings?.length && <div className="space-y-2"><h4 className="text-xs font-semibold">插件设置</h4>{plugin.contributes.settings.map((setting) => <label key={setting.key} className="block rounded-lg border p-2 text-xs dark:border-zinc-800"><span className="font-medium">{setting.title}</span>{setting.description && <span className="ml-2 text-zinc-500">{setting.description}</span>}{setting.type === "boolean" ? <input type="checkbox" className="ml-3" checked={Boolean(settingDraft[setting.key] ?? settingValues[setting.key] ?? setting.default)} onChange={(event) => setSettingDraft((current) => ({ ...current, [setting.key]: event.target.checked }))} /> : setting.type === "select" ? <select className="mt-2 block w-full rounded border bg-transparent p-1.5 dark:border-zinc-700" value={String(settingDraft[setting.key] ?? settingValues[setting.key] ?? setting.default ?? "")} onChange={(event) => setSettingDraft((current) => ({ ...current, [setting.key]: event.target.value }))}>{(setting.options || []).map((option) => <option key={String(option)} value={String(option)}>{option}</option>)}</select> : <input type={setting.secret ? "password" : setting.type === "number" ? "number" : "text"} className="mt-2 block w-full rounded border bg-transparent p-1.5 dark:border-zinc-700" value={String(settingDraft[setting.key] ?? (setting.secret ? "" : settingValues[setting.key] ?? setting.default ?? ""))} placeholder={setting.secret && settingValues[setting.key] ? "已安全保存；输入新值以替换" : ""} onChange={(event) => setSettingDraft((current) => ({ ...current, [setting.key]: setting.type === "number" ? Number(event.target.value) : event.target.value }))} />}</label>)}<button disabled={!Object.keys(settingDraft).length} onClick={() => act(async () => { setSettingValues(await pluginApi.setSettings(plugin.id, settingDraft)); setSettingDraft({}); })} className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs text-white disabled:opacity-40">保存设置</button></div>}
      {!!plugin.contributes?.automationTemplates?.length && <div className="space-y-2"><h4 className="text-xs font-semibold">Automation 模板</h4>{plugin.contributes.automationTemplates.map((template) => <div key={template.id} className="flex items-center justify-between rounded-lg border p-2 text-xs dark:border-zinc-800"><div><div className="font-medium">{template.title}</div><div className="text-zinc-500">{template.description || "安装后保持禁用，需在自动化中心确认"}</div></div><button onClick={() => act(() => pluginApi.installAutomationTemplate(plugin.id, template.id))} className="rounded-md border px-2 py-1">安装模板</button></div>)}</div>}
      <div><h4 className="mb-2 text-xs font-semibold">版本</h4><div className="flex flex-wrap gap-1">{plugin.versions?.map((version) => <span key={version.version} className={`rounded px-2 py-1 font-mono text-[10px] ${version.version === plugin.version ? "bg-indigo-500/15 text-indigo-600" : "bg-zinc-100 dark:bg-zinc-900"}`}>{version.version}</span>)}</div></div>
      <div><h4 className="mb-2 text-xs font-semibold">最近执行</h4>{executions.length ? <div className="max-h-48 overflow-auto space-y-1">{executions.map((item) => { const progress = item.progressTotal ? Math.min(100, Math.round(((item.progressCurrent || 0) / item.progressTotal) * 100)) : null; return <div key={item.id} className="rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-[11px]"><span className="font-mono">{item.actionId}</span> · {item.status} · {item.durationMs ?? "—"}ms{progress !== null && <div className="mt-1"><div className="h-1.5 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800"><div className="h-full bg-indigo-500" style={{ width: `${progress}%` }} /></div><div className="mt-1 text-zinc-500">{item.progressMessage || `${item.progressCurrent || 0} / ${item.progressTotal}`}</div></div>}{item.errorMessage && <div className="mt-1 text-red-500">{item.errorMessage}</div>}</div>; })}</div> : <p className="text-xs text-zinc-500">暂无执行记录</p>}</div>
    </div>}
  </div>;
}

export default function PluginSettingsTab({ isAdmin }: { isAdmin: boolean }) {
  const [tab, setTab] = useState<"installed" | "discover" | "updates" | "developer">("installed");
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingPackage | null>(null);
  const [installing, setInstalling] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [developerModeAvailable, setDeveloperModeAvailable] = useState(false);
  const [devDirectory, setDevDirectory] = useState("");
  const [sources, setSources] = useState<RegistrySource[]>([]);
  const [sourceId, setSourceId] = useState("official-v2");
  const [catalog, setCatalog] = useState<RegistryPlugin[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [newSourceName, setNewSourceName] = useState("");
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [newSourceKeyId, setNewSourceKeyId] = useState("");
  const [newSourcePublicKey, setNewSourcePublicKey] = useState("");
  const [updates, setUpdates] = useState<PluginUpdate[]>([]);
  const [updateSource, setUpdateSource] = useState("official-v2");
  const inputRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => { setPlugins(await pluginApi.list()); setLoading(false); }, []);
  useEffect(() => { void refresh().catch(() => setLoading(false)); if (isAdmin) void pluginApi.getDeveloperMode().then((value) => { setDeveloperMode(value.enabled); setDeveloperModeAvailable(value.available); }).catch(() => {}); }, [isAdmin, refresh]);
  useEffect(() => {
    if (tab === "installed" || tab === "updates") return;
    void pluginApi.registrySources().then((next) => {
      setSources(next);
      if (!next.some((source) => source.id === sourceId) && next[0]) setSourceId(next[0].id);
    }).catch(() => setSources([]));
    if (tab !== "discover") return;
    setCatalogLoading(true);
    void pluginApi.registryCatalog(sourceId).then(setCatalog).catch((error) => {
      setCatalog([]);
      window.alert(error instanceof Error ? error.message : String(error));
    }).finally(() => setCatalogLoading(false));
  }, [sourceId, tab]);
  const visibleCatalog = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return catalog.filter((plugin) => !needle || `${plugin.name} ${plugin.id} ${plugin.description || ""} ${(plugin.keywords || []).join(" ")}`.toLowerCase().includes(needle));
  }, [catalog, search]);
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
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-xl font-bold">扩展生态</h2><p className="mt-1 text-sm text-zinc-500">V2 社区插件默认运行在 QuickJS/WASM 沙箱；签名、权限变化和安全公告会在安装前核验。</p></div>{isAdmin && tab === "installed" && <><input ref={inputRef} type="file" accept=".nowen-plugin" className="hidden" onChange={(event) => void choosePackage(event.target.files?.[0])} /><button onClick={() => inputRef.current?.click()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white"><PackagePlus size={14} />安装插件</button></>}</div>
    <div className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">{(["installed", "discover", "updates", "developer"] as const).map((item) => <button key={item} onClick={() => setTab(item)} className={`flex-1 rounded-md px-3 py-2 text-xs font-medium ${tab === item ? "bg-white shadow-sm dark:bg-zinc-800" : "text-zinc-500"}`}>{item === "installed" ? "已安装" : item === "discover" ? "市场" : item === "updates" ? "更新与安全" : "开发者"}</button>)}</div>
    {tab === "installed" && (loading ? <div className="flex items-center gap-2 py-12 text-sm text-zinc-500"><Loader2 className="animate-spin" size={16} />正在加载插件</div> : plugins.length ? <div className="grid gap-3">{plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} isAdmin={isAdmin} refresh={refresh} />)}</div> : <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 py-12 text-center text-sm text-zinc-500">尚未安装插件</div>)}
    {tab === "updates" && <div className="space-y-3 rounded-xl border p-4 dark:border-zinc-800"><div><h3 className="text-sm font-semibold">更新与安全</h3><p className="mt-1 text-xs text-zinc-500">仅接受签名 Registry 的不可变版本；新增权限、Runtime 或 API 变化必须人工确认。</p></div><div className="flex gap-2"><input value={updateSource} onChange={(event) => setUpdateSource(event.target.value)} placeholder="V2 Registry Source ID" className="min-w-0 flex-1 rounded-md border bg-transparent px-3 py-2 text-xs dark:border-zinc-700" /><button disabled={!isAdmin} onClick={async () => { try { setUpdates(await pluginApi.checkUpdates(updateSource)); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); } }} className="rounded-md bg-indigo-600 px-3 py-2 text-xs text-white disabled:opacity-50">检查更新</button></div>{updates.length ? <div className="space-y-2">{updates.map((update) => <div key={update.pluginId} className="rounded-lg bg-zinc-100 p-3 text-xs dark:bg-zinc-900"><div className="font-mono">{update.pluginId}</div><div className="mt-1">{update.currentVersion} → {update.availableVersion}</div>{update.permissionDiff.added.length > 0 && <div className="mt-1 text-amber-600">新增权限：{update.permissionDiff.added.join("、")}</div>}<div className="mt-1 text-zinc-500">{update.confirmationRequired ? "需要管理员确认" : "符合自动更新条件"}</div></div>)}</div> : <p className="text-xs text-zinc-500">尚未检查，或没有可用更新。</p>}</div>}
    {tab === "discover" && <div className="space-y-3"><div className="flex gap-2"><div className="relative flex-1"><Search size={14} className="absolute left-3 top-2.5 text-zinc-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索插件、分类或关键词" className="w-full rounded-lg border bg-transparent py-2 pl-9 pr-3 text-sm dark:border-zinc-700" /></div><select value={sourceId} onChange={(event) => setSourceId(event.target.value)} className="rounded-lg border bg-transparent px-2 text-xs dark:border-zinc-700">{sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></div>{catalogLoading ? <div className="flex items-center gap-2 py-10 text-sm text-zinc-500"><Loader2 size={15} className="animate-spin" />加载 Registry</div> : visibleCatalog.length ? <div className="grid gap-3 md:grid-cols-2">{visibleCatalog.map((plugin) => <div key={plugin.id} className="rounded-xl border p-4 dark:border-zinc-800"><div className="flex items-start justify-between gap-2"><div><h3 className="font-semibold">{plugin.name}</h3><p className="font-mono text-[10px] text-zinc-400">{plugin.id}</p></div><span className="rounded-full bg-zinc-100 px-2 py-1 text-[10px] dark:bg-zinc-900">{plugin.trustLevel || "community"}</span></div><p className="mt-2 text-xs text-zinc-500">{plugin.description || "暂无说明"}</p><div className="mt-3 flex items-center justify-between text-xs"><span>v{plugin.latestVersion}</span>{isAdmin && <button onClick={async () => { await pluginApi.installFromRegistry(sourceId, plugin.id); setTab("installed"); await refresh(); }} className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-white"><Download size={12} />安装</button>}</div></div>)}</div> : <div className="rounded-xl border border-dashed py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">Registry 暂无可显示插件，或当前来源不可访问。</div>}</div>}
    {tab === "developer" && (isAdmin && developerModeAvailable ? <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3"><div className="flex items-center justify-between"><div><h3 className="flex items-center gap-2 text-sm font-semibold"><Code2 size={15} />开发者模式</h3><p className="mt-1 text-xs text-zinc-500">本地目录仍需 Validate、Preflight 和权限确认；开发插件不进入备份。</p></div><input type="checkbox" checked={developerMode} onChange={async (event) => { const enabled = event.target.checked; await pluginApi.setDeveloperMode(enabled); setDeveloperMode(enabled); }} /></div>{developerMode && <div className="flex gap-2"><input value={devDirectory} onChange={(event) => setDevDirectory(event.target.value)} placeholder="D:\\Projects\\nowen-plugin-test" className="min-w-0 flex-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-xs" /><button onClick={() => void loadDevelopment().catch((error) => window.alert(error instanceof Error ? error.message : String(error)))} className="rounded-md border px-3 py-2 text-xs">Validate & Load</button></div>}</div> : <div className="rounded-xl border border-dashed py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">开发者模式仅对管理员和本地 Desktop Backend 开放。</div>)}
    {tab === "developer" && isAdmin && <div className="rounded-xl border p-4 dark:border-zinc-800">
      <h3 className="text-sm font-semibold">Registry 来源与国内镜像</h3>
      <p className="mt-1 text-xs text-zinc-500">官方源使用客户端内置 Ed25519 信任根；自定义源必须提供 HTTPS Index 和管理员固定的 Registry 公钥。</p>
      <div className="mt-3 space-y-1">{sources.map((source) => <div key={source.id} className="rounded bg-zinc-100 px-2 py-1.5 text-[11px] dark:bg-zinc-900"><div className="truncate">{source.name} · {source.indexUrl}</div><div className="mt-0.5 text-zinc-400">{source.official ? "客户端内置信任根" : `Pinned key: ${source.registryKeyId}`}</div></div>)}</div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <input value={newSourceName} onChange={(event) => setNewSourceName(event.target.value)} placeholder="镜像名称" className="rounded-md border bg-transparent px-2 py-1.5 text-xs dark:border-zinc-700" />
        <input value={newSourceUrl} onChange={(event) => setNewSourceUrl(event.target.value)} placeholder="https://mirror.example/v2/index.json" className="rounded-md border bg-transparent px-2 py-1.5 text-xs dark:border-zinc-700" />
        <input value={newSourceKeyId} onChange={(event) => setNewSourceKeyId(event.target.value)} placeholder="Registry Key ID" className="rounded-md border bg-transparent px-2 py-1.5 text-xs dark:border-zinc-700" />
        <textarea value={newSourcePublicKey} onChange={(event) => setNewSourcePublicKey(event.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" className="min-h-20 rounded-md border bg-transparent px-2 py-1.5 font-mono text-xs dark:border-zinc-700" />
      </div>
      <button onClick={async () => {
        const id = `mirror-${Date.now().toString(36)}`;
        const updated = await pluginApi.setRegistrySource({ id, name: newSourceName || "Custom Registry", indexUrl: newSourceUrl, registryKeyId: newSourceKeyId, registryPublicKey: newSourcePublicKey });
        setSources(updated); setNewSourceName(""); setNewSourceUrl(""); setNewSourceKeyId(""); setNewSourcePublicKey("");
      }} className="mt-2 rounded-md border px-3 py-1.5 text-xs">添加自定义源</button>
    </div>}
    {pending && <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-950 p-5 shadow-2xl space-y-4"><div><h3 className="text-lg font-bold">安装 {pending.manifest.name || "社区插件"}</h3><p className="mt-1 font-mono text-xs text-zinc-500">{pending.manifest.id} · v{pending.manifest.version}</p></div><div className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-800 dark:text-amber-300"><div className="flex gap-2"><AlertTriangle className="mt-0.5 shrink-0" size={16} /><span>{pending.nodeRuntimeConfirmationRequired ? "此 V2 插件将在独立 Node 进程中执行二进制/Node 代码，可使用获准的文件系统与网络权限，且不能由 QuickJS/WASM Sandbox 隔离。请仅在完全信任来源时继续。" : "此插件包含第三方可执行代码；安装前将校验兼容性、信任等级和 Runtime 策略。"}</span></div></div><div><h4 className="mb-2 text-sm font-semibold">它希望获得：</h4><ul className="space-y-1 text-sm">{pending.manifest.permissions?.length ? pending.manifest.permissions.map((permission: string) => <li key={permission}>✓ {permissionLabels[permission] || permission}</li>) : <li className="text-zinc-500">不请求数据权限</li>}</ul>{(pending.manifest.permissionConfig?.externalFetchHosts?.length ?? 0) > 0 && <p className="mt-2 text-xs text-zinc-500">网络访问：{pending.manifest.permissionConfig?.externalFetchHosts?.join(", ")}</p>}</div><p className="text-xs text-zinc-500">{pending.nodeRuntimeConfirmationRequired ? "确认后将使用同一文件重新提交；取消则不会安装。" : "安装后默认进入隔离状态；你需要再次确认权限并启用。"}</p><div className="flex justify-end gap-2"><button onClick={() => { setPending(null); if (inputRef.current) inputRef.current.value = ""; }} className="rounded-md border px-3 py-2 text-sm">取消</button><button disabled={installing} onClick={install} className="rounded-md bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50">{installing ? "正在验证" : pending.nodeRuntimeConfirmationRequired ? "确认 Node 风险并安装" : "继续安装"}</button></div></div></div>}
  </div>;
}
