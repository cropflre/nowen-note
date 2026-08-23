import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Code2, Loader2, PackagePlus, Play, RefreshCw, Trash2 } from "lucide-react";
import { pluginApi, type InstalledPlugin, type PluginAction } from "@/lib/pluginApi";

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

type PendingPackage = { file: File; manifest: any };

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
  const [executions, setExecutions] = useState<any[]>([]);
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); try { await operation(); await refresh(); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const toggleDetails = async () => { const next = !expanded; setExpanded(next); if (next) setExecutions(await pluginApi.executions(plugin.id).catch(() => [])); };
  return <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 p-4 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0"><h3 className="font-semibold text-zinc-900 dark:text-zinc-100">🧩 {plugin.name}</h3><p className="font-mono text-[11px] text-zinc-400 truncate">{plugin.id}</p><p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{plugin.description}</p></div>
      <span className={`shrink-0 rounded-full px-2 py-1 text-[11px] ${plugin.status === "enabled" ? "bg-emerald-500/15 text-emerald-600" : plugin.status === "error" ? "bg-red-500/15 text-red-600" : "bg-amber-500/15 text-amber-600"}`}>{statusLabel(plugin.status)}</span>
    </div>
    <div className="text-xs text-zinc-500">v{plugin.version} · {plugin.trustLevel} · {plugin.actions.length} Actions</div>
    <div className="flex flex-wrap gap-2">
      <button onClick={toggleDetails} className="inline-flex items-center gap-1 rounded-md border border-zinc-200 dark:border-zinc-700 px-2.5 py-1.5 text-xs">详情 {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button>
      {isAdmin && plugin.status === "enabled" && <button disabled={busy} onClick={() => act(() => pluginApi.disable(plugin.id))} className="rounded-md border px-2.5 py-1.5 text-xs">禁用</button>}
      {isAdmin && plugin.status !== "enabled" && <button disabled={busy} onClick={() => act(async () => { await pluginApi.grant(plugin.id, plugin.permissions.map((item) => item.permission)); await pluginApi.enable(plugin.id); })} className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs text-white">确认权限并启用</button>}
      {isAdmin && <button disabled={busy} onClick={() => act(() => pluginApi.reload(plugin.id))} className="rounded-md border px-2.5 py-1.5 text-xs disabled:opacity-40"><RefreshCw size={12} /></button>}
      {isAdmin && <button disabled={busy} onClick={() => window.confirm(`确定卸载 ${plugin.name}？`) && act(() => pluginApi.uninstall(plugin.id))} className="rounded-md border border-red-200 px-2.5 py-1.5 text-xs text-red-600"><Trash2 size={12} /></button>}
    </div>
    {expanded && <div className="space-y-4 border-t border-zinc-200 dark:border-zinc-800 pt-3">
      <div><h4 className="mb-2 text-xs font-semibold">权限</h4><ul className="space-y-1">{plugin.permissions.length ? plugin.permissions.map((item) => <li key={item.permission} className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">{item.granted ? <CheckCircle2 size={13} className="text-emerald-500" /> : <AlertTriangle size={13} className="text-amber-500" />}{permissionLabels[item.permission] || item.permission}<span className="ml-auto font-mono text-[10px] text-zinc-400">{item.permission}</span></li>) : <li className="text-xs text-zinc-500">不请求数据权限</li>}</ul></div>
      <div className="space-y-2"><h4 className="text-xs font-semibold">Actions</h4>{plugin.actions.map((action) => <ActionTester key={action.id} plugin={plugin} action={action} />)}</div>
      <div><h4 className="mb-2 text-xs font-semibold">最近执行</h4>{executions.length ? <div className="max-h-48 overflow-auto space-y-1">{executions.map((item) => <div key={item.id} className="rounded bg-zinc-100 dark:bg-zinc-900 p-2 text-[11px]"><span className="font-mono">{item.actionId}</span> · {item.status} · {item.durationMs ?? "—"}ms{item.errorMessage && <div className="mt-1 text-red-500">{item.errorMessage}</div>}</div>)}</div> : <p className="text-xs text-zinc-500">暂无执行记录</p>}</div>
    </div>}
  </div>;
}

export default function PluginSettingsTab({ isAdmin }: { isAdmin: boolean }) {
  const [plugins, setPlugins] = useState<InstalledPlugin[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<PendingPackage | null>(null);
  const [installing, setInstalling] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [developerModeAvailable, setDeveloperModeAvailable] = useState(false);
  const [devDirectory, setDevDirectory] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => { setPlugins(await pluginApi.list()); setLoading(false); }, []);
  useEffect(() => { void refresh().catch(() => setLoading(false)); if (isAdmin) void pluginApi.getDeveloperMode().then((value) => { setDeveloperMode(value.enabled); setDeveloperModeAvailable(value.available); }).catch(() => {}); }, [isAdmin, refresh]);
  const choosePackage = async (file?: File) => {
    if (!file) return;
    try {
      const zip = await JSZip.loadAsync(file);
      const manifestFile = zip.file("manifest.json");
      if (!manifestFile) throw new Error("插件包缺少 manifest.json");
      setPending({ file, manifest: JSON.parse(await manifestFile.async("string")) });
    } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); }
  };
  const install = async () => { if (!pending) return; setInstalling(true); try { await pluginApi.install(pending.file); setPending(null); await refresh(); } catch (error) { window.alert(error instanceof Error ? error.message : String(error)); } finally { setInstalling(false); } };
  return <div className="space-y-5">
    <div className="flex items-start justify-between gap-3"><div><h2 className="text-xl font-bold">插件</h2><p className="mt-1 text-sm text-zinc-500">服务端 Action 插件在独立进程中运行，移动端只会远程调用，不会在本机加载 Node 代码。</p></div>{isAdmin && <><input ref={inputRef} type="file" accept=".nowen-plugin" className="hidden" onChange={(event) => void choosePackage(event.target.files?.[0])} /><button onClick={() => inputRef.current?.click()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white"><PackagePlus size={14} />安装插件</button></>}</div>
    {loading ? <div className="flex items-center gap-2 py-12 text-sm text-zinc-500"><Loader2 className="animate-spin" size={16} />正在加载插件</div> : plugins.length ? <div className="grid gap-3">{plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} isAdmin={isAdmin} refresh={refresh} />)}</div> : <div className="rounded-xl border border-dashed border-zinc-300 dark:border-zinc-700 py-12 text-center text-sm text-zinc-500">尚未安装插件</div>}
    {isAdmin && developerModeAvailable && <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 space-y-3"><div className="flex items-center justify-between"><div><h3 className="flex items-center gap-2 text-sm font-semibold"><Code2 size={15} />开发者模式</h3><p className="mt-1 text-xs text-zinc-500">仅加载你信任的本地开发目录；开发插件不进入备份。</p></div><input type="checkbox" checked={developerMode} onChange={async (event) => { const enabled = event.target.checked; await pluginApi.setDeveloperMode(enabled); setDeveloperMode(enabled); }} /></div>{developerMode && <div className="flex gap-2"><input value={devDirectory} onChange={(event) => setDevDirectory(event.target.value)} placeholder="D:\\Projects\\nowen-plugin-test" className="min-w-0 flex-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-transparent px-3 py-2 text-xs" /><button onClick={async () => { await pluginApi.loadDevelopment(devDirectory); await refresh(); }} className="rounded-md border px-3 py-2 text-xs">加载开发插件</button></div>}</div>}
    {pending && <div className="fixed inset-0 z-[10001] flex items-center justify-center bg-black/60 p-4"><div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-950 p-5 shadow-2xl space-y-4"><div><h3 className="text-lg font-bold">安装 {pending.manifest.name || "社区插件"}</h3><p className="mt-1 font-mono text-xs text-zinc-500">{pending.manifest.id} · v{pending.manifest.version}</p></div><div className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm text-amber-800 dark:text-amber-300"><div className="flex gap-2"><AlertTriangle className="mt-0.5 shrink-0" size={16} /><span>此插件包含第三方可执行代码。Node 子进程提供故障隔离，但不是真正安全沙箱；请仅安装你信任的来源。</span></div></div><div><h4 className="mb-2 text-sm font-semibold">它希望获得：</h4><ul className="space-y-1 text-sm">{pending.manifest.permissions?.length ? pending.manifest.permissions.map((permission: string) => <li key={permission}>✓ {permissionLabels[permission] || permission}</li>) : <li className="text-zinc-500">不请求数据权限</li>}</ul>{pending.manifest.permissionConfig?.externalFetchHosts?.length > 0 && <p className="mt-2 text-xs text-zinc-500">网络访问：{pending.manifest.permissionConfig.externalFetchHosts.join(", ")}</p>}</div><p className="text-xs text-zinc-500">安装后默认进入隔离状态；你需要再次确认权限并启用。</p><div className="flex justify-end gap-2"><button onClick={() => setPending(null)} className="rounded-md border px-3 py-2 text-sm">取消</button><button disabled={installing} onClick={install} className="rounded-md bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50">{installing ? "正在验证" : "信任并安装"}</button></div></div></div>}
  </div>;
}
