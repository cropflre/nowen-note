import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  ExternalLink,
  FileText,
  FolderOpen,
  FolderSync,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  SkipForward,
  Trash2,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { confirm } from "@/components/ui/confirm";
import { runFolderSyncOnce } from "@/lib/folderSyncRunner";
import {
  getFolderSyncPreferences,
  pushFolderSyncPreferences,
  sanitizeFolderSyncExcludePatterns,
  type FolderSyncPreferences,
} from "@/lib/folderSyncPreferences";
import type {
  FolderSyncConfig,
  FolderSyncIndexItem,
  FolderSyncLogItem,
  FolderSyncScanResult,
} from "@/lib/desktopBridge";

const FILE_TYPES = [".md", ".markdown", ".txt", ".html", ".htm", ".pdf", ".docx"];
const INTERVALS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "仅手动" },
  { value: 10, label: "每 10 分钟" },
  { value: 30, label: "每 30 分钟" },
  { value: 60, label: "每小时" },
  { value: 360, label: "每 6 小时" },
  { value: 1440, label: "每天" },
];

type NotebookOption = { id: string; label: string; scope: string };
type IndexFilter = "all" | "conflict" | "error" | "skipped" | "deleted";

function getFolderSync() {
  return (window as any).nowenDesktop?.folderSync as import("@/lib/desktopBridge").FolderSyncAPI | undefined;
}

function isDesktop(): boolean {
  return !!(window as any).nowenDesktop?.isDesktop && !!getFolderSync();
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    new: "新增",
    changed: "变更",
    renamed: "重命名",
    synced: "已同步",
    unchanged: "未变化",
    deleted: "源文件已删除",
    skipped: "已跳过",
    error: "失败",
    conflict: "冲突保护",
  };
  return labels[status] || status;
}

function conflictPolicyLabel(policy: FolderSyncPreferences["conflictPolicy"]): string {
  if (policy === "copy") return "保留副本";
  if (policy === "overwrite") return "源文件覆盖";
  if (policy === "detach") return "保留编辑并停止跟踪";
  return "停止覆盖";
}

function StatusIcon({ status }: { status: string }) {
  if (status === "conflict") return <ShieldAlert size={12} className="text-amber-500" />;
  if (status === "error" || status === "deleted") return <XCircle size={12} className={status === "error" ? "text-red-500" : "text-orange-500"} />;
  if (status === "skipped") return <SkipForward size={12} className="text-zinc-400" />;
  if (status === "new") return <Plus size={12} className="text-emerald-500" />;
  if (status === "changed" || status === "renamed") return <AlertTriangle size={12} className="text-amber-500" />;
  return <CheckCircle2 size={12} className="text-emerald-500" />;
}

function parsePatterns(value: string): string[] {
  return sanitizeFolderSyncExcludePatterns(value.split(/[\n,]/));
}

function ConfigCard({
  config,
  notebookOptions,
  busy,
  scanResult,
  onRun,
  onRemove,
  onSave,
  onOpenNote,
}: {
  config: FolderSyncConfig;
  notebookOptions: NotebookOption[];
  busy: boolean;
  scanResult: FolderSyncScanResult | null;
  onRun: () => Promise<void>;
  onRemove: () => Promise<void>;
  onSave: (basic: Partial<FolderSyncConfig>, preferences: FolderSyncPreferences) => Promise<void>;
  onOpenNote: (noteId: string) => void;
}) {
  const configWithAdvanced = config as FolderSyncConfig & Partial<FolderSyncPreferences>;
  const [editing, setEditing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [logs, setLogs] = useState<FolderSyncLogItem[]>([]);
  const [index, setIndex] = useState<FolderSyncIndexItem[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [filter, setFilter] = useState<IndexFilter>("all");

  const [targetNotebookId, setTargetNotebookId] = useState(config.targetNotebookId || "");
  const [includeSubfolders, setIncludeSubfolders] = useState(config.includeSubfolders);
  const [fileTypes, setFileTypes] = useState(config.fileTypes);
  const [enabled, setEnabled] = useState(config.enabled);
  const [intervalMinutes, setIntervalMinutes] = useState<number | null>(config.intervalMinutes ?? null);
  const [preferences, setPreferences] = useState<FolderSyncPreferences>(() =>
    getFolderSyncPreferences(config.folderId, configWithAdvanced),
  );
  const [excludeText, setExcludeText] = useState(() => preferences.excludePatterns.join("\n"));

  useEffect(() => {
    setTargetNotebookId(config.targetNotebookId || "");
    setIncludeSubfolders(config.includeSubfolders);
    setFileTypes(config.fileTypes);
    setEnabled(config.enabled);
    setIntervalMinutes(config.intervalMinutes ?? null);
    const next = getFolderSyncPreferences(config.folderId, config as FolderSyncConfig & Partial<FolderSyncPreferences>);
    setPreferences(next);
    setExcludeText(next.excludePatterns.join("\n"));
  }, [config]);

  const stats = (scanResult?.ok ? scanResult : config.lastScanStats) as any;
  const targetLabel = notebookOptions.find((option) => option.id === config.targetNotebookId)?.label || "未选择";

  const counts = useMemo(() => {
    const result: Record<IndexFilter, number> = { all: index.length, conflict: 0, error: 0, skipped: 0, deleted: 0 };
    for (const item of index) {
      if (item.status in result) result[item.status as IndexFilter] += 1;
    }
    return result;
  }, [index]);

  const filteredIndex = useMemo(
    () => filter === "all" ? index : index.filter((item) => item.status === filter),
    [filter, index],
  );

  const loadDetails = useCallback(async () => {
    const bridge = getFolderSync();
    if (!bridge) return;
    setDetailsLoading(true);
    try {
      const [nextIndex, nextLogs] = await Promise.all([
        bridge.getIndex(config.folderId),
        bridge.getLogs(config.folderId),
      ]);
      setIndex(Array.isArray(nextIndex) ? nextIndex : []);
      setLogs(Array.isArray(nextLogs) ? nextLogs : []);
    } finally {
      setDetailsLoading(false);
    }
  }, [config.folderId]);

  const toggleDetails = async () => {
    const next = !detailsOpen;
    setDetailsOpen(next);
    if (next) await loadDetails();
  };

  const save = async () => {
    const nextPreferences: FolderSyncPreferences = {
      ...preferences,
      excludePatterns: parsePatterns(excludeText),
    };
    await onSave({
      targetNotebookId: targetNotebookId || null,
      includeSubfolders,
      fileTypes,
      enabled: !!targetNotebookId && enabled,
      intervalMinutes,
    }, nextPreferences);
    setPreferences(nextPreferences);
    setExcludeText(nextPreferences.excludePatterns.join("\n"));
    setEditing(false);
  };

  return (
    <article className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <FolderOpen size={15} className="shrink-0 text-accent-primary" />
              <h4 className="truncate text-sm font-semibold text-tx-primary" title={config.folderPath}>{config.folderPath}</h4>
            </div>
            <p className="mt-1 truncate text-xs text-tx-tertiary">目标：{targetLabel}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px]">
              <span className={cn("rounded-full px-2 py-0.5", config.enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-zinc-500/10 text-zinc-500")}>{config.enabled ? "已启用" : "已停用"}</span>
              <span className="rounded-full bg-app-bg px-2 py-0.5 text-tx-tertiary">{INTERVALS.find((item) => item.value === (config.intervalMinutes ?? null))?.label || "自定义"}</span>
              <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-amber-600">冲突：{conflictPolicyLabel(preferences.conflictPolicy)}</span>
              <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-sky-600">删除：{preferences.deletionPolicy === "keep" ? "保留笔记" : preferences.deletionPolicy === "trash" ? "移入回收站" : "停止跟踪"}</span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={onRun} disabled={busy} className="rounded-lg p-2 text-accent-primary hover:bg-accent-primary/10 disabled:opacity-50" title="立即扫描并同步">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            </button>
            <button type="button" onClick={() => setEditing((value) => !value)} className="rounded-lg p-2 text-tx-secondary hover:bg-app-hover" title="编辑配置">
              {editing ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
            </button>
            <button type="button" onClick={onRemove} disabled={busy} className="rounded-lg p-2 text-tx-tertiary hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50" title="移除同步目录">
              <Trash2 size={15} />
            </button>
          </div>
        </div>

        {(config.lastScanAt || config.lastSyncedAt) && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-tx-tertiary">
            {config.lastScanAt && <span><Clock size={10} className="mr-1 inline" />扫描：{new Date(config.lastScanAt).toLocaleString()}</span>}
            {config.lastSyncedAt && <span><CheckCircle2 size={10} className="mr-1 inline" />同步：{new Date(config.lastSyncedAt).toLocaleString()}</span>}
          </div>
        )}

        {stats && (
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {[
              ["文件", stats.total || 0],
              ["新增", stats.added || 0],
              ["变更", stats.changed || 0],
              ["删除", stats.deleted || 0],
              ["跳过", stats.skipped || 0],
              ["错误", stats.errors || 0],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-app-bg px-2 py-1.5 text-center">
                <div className="text-sm font-semibold text-tx-primary">{value}</div>
                <div className="text-[10px] text-tx-tertiary">{label}</div>
              </div>
            ))}
          </div>
        )}

        <button type="button" onClick={toggleDetails} className="mt-3 flex items-center gap-1.5 text-xs text-tx-secondary hover:text-tx-primary">
          <FileText size={13} />{detailsOpen ? "收起扫描报告" : "查看扫描报告与错误"}
        </button>
      </div>

      {editing && (
        <div className="space-y-4 border-t border-app-border bg-app-bg/40 p-4">
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-amber-700 dark:text-amber-300">
            <div className="mb-1 flex items-center gap-2 font-medium"><ShieldAlert size={14} />单向同步与冲突保护</div>
            本地文件夹是数据源。Nowen 不会反向修改本地文件；检测到同步笔记在 Nowen 内被编辑时，默认停止覆盖并在报告中标记冲突。
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-tx-secondary">目标空间 / 笔记本</span>
            <select value={targetNotebookId} onChange={(event) => setTargetNotebookId(event.target.value)} className="w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary outline-none focus:ring-2 focus:ring-accent-primary/30">
              <option value="">请选择目标笔记本</option>
              {notebookOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-tx-secondary">扫描频率</span>
              <select value={intervalMinutes ?? ""} onChange={(event) => setIntervalMinutes(event.target.value ? Number(event.target.value) : null)} className="w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary">
                {INTERVALS.map((item) => <option key={String(item.value)} value={item.value ?? ""}>{item.label}</option>)}
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-tx-secondary">Nowen 编辑冲突</span>
              <select value={preferences.conflictPolicy} onChange={(event) => setPreferences((current) => ({ ...current, conflictPolicy: event.target.value as FolderSyncPreferences["conflictPolicy"] }))} className="w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary">
                <option value="protect">停止覆盖并提示（推荐）</option>
                <option value="copy">先保留 Nowen 副本，再用源文件更新</option>
                <option value="overwrite">始终由源文件覆盖</option>
                <option value="detach">保留 Nowen 编辑，并停止跟踪该文件</option>
              </select>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-tx-secondary">源文件删除后</span>
              <select value={preferences.deletionPolicy} onChange={(event) => setPreferences((current) => ({ ...current, deletionPolicy: event.target.value as FolderSyncPreferences["deletionPolicy"] }))} className="w-full rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm text-tx-primary">
                <option value="keep">保留 Nowen 笔记</option>
                <option value="trash">移入 Nowen 回收站</option>
                <option value="detach">保留内容并停止跟踪</option>
              </select>
            </label>
            <div className="space-y-2 rounded-xl border border-app-border bg-app-surface p-3">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-tx-secondary">
                <input type="checkbox" checked={includeSubfolders} onChange={(event) => setIncludeSubfolders(event.target.checked)} />扫描子文件夹
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-tx-secondary">
                <input type="checkbox" checked={preferences.preserveHierarchy} disabled={!includeSubfolders}
                  onChange={(event) => setPreferences((current) => ({ ...current, preserveHierarchy: event.target.checked }))} />
                保留本地子文件夹层级（新建对应的笔记本）
              </label>
              {preferences.preserveHierarchy && (
                <p className="text-[11px] leading-5 text-amber-600 dark:text-amber-400">
                  开启后，下一次同步会把已同步笔记整理到对应子笔记本（不改正文，不删除源文件）；默认关闭以保护旧配置。手动移动或删除的目录不会自动覆盖。
                </p>
              )}
              <label className="flex cursor-pointer items-center gap-2 text-xs text-tx-secondary">
                <input type="checkbox" checked={preferences.extractAttachmentText} onChange={(event) => setPreferences((current) => ({ ...current, extractAttachmentText: event.target.checked }))} />提取 PDF / DOCX 文本用于搜索
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-tx-secondary">
                <input type="checkbox" checked={enabled} disabled={!targetNotebookId} onChange={(event) => setEnabled(event.target.checked)} />启用自动同步
              </label>
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-tx-secondary">文件类型</div>
            <div className="flex flex-wrap gap-2">
              {FILE_TYPES.map((extension) => (
                <button key={extension} type="button" onClick={() => setFileTypes((current) => current.includes(extension) ? current.filter((item) => item !== extension) : [...current, extension])} className={cn("rounded-lg border px-2.5 py-1 text-xs", fileTypes.includes(extension) ? "border-accent-primary/40 bg-accent-primary/10 text-accent-primary" : "border-app-border text-tx-tertiary hover:text-tx-secondary")}>{extension}</button>
              ))}
            </div>
          </div>

          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-tx-secondary">排除规则</span>
            <textarea value={excludeText} onChange={(event) => setExcludeText(event.target.value)} rows={4} placeholder={"每行一条，例如：\n**/draft/**\n*.tmp\nprivate-*"} className="w-full resize-y rounded-xl border border-app-border bg-app-surface px-3 py-2 font-mono text-xs text-tx-primary outline-none focus:ring-2 focus:ring-accent-primary/30" />
            <span className="text-[10px] text-tx-tertiary">支持 *、**、?；也可在同步根目录创建 .nowenignore。最多 10 条自定义规则。选择“停止跟踪”后，发生冲突的精确路径会自动加入此列表。</span>
          </label>

          <button type="button" onClick={save} disabled={busy || !fileTypes.length} className="flex items-center gap-2 rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}保存同步策略
          </button>
        </div>
      )}

      {detailsOpen && (
        <div className="space-y-4 border-t border-app-border p-4">
          {detailsLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-tx-tertiary"><Loader2 size={14} className="animate-spin" />正在加载扫描报告…</div>
          ) : (
            <>
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h5 className="text-xs font-semibold text-tx-secondary">文件状态（{index.length}）</h5>
                  <div className="flex flex-wrap gap-1">
                    {(["all", "conflict", "error", "skipped", "deleted"] as IndexFilter[]).map((item) => (
                      <button key={item} type="button" onClick={() => setFilter(item)} className={cn("rounded-md px-2 py-1 text-[10px]", filter === item ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:bg-app-hover")}>{item === "all" ? "全部" : statusLabel(item)} {counts[item] || ""}</button>
                    ))}
                  </div>
                </div>
                <div className="max-h-64 overflow-y-auto rounded-xl border border-app-border">
                  {filteredIndex.length === 0 ? <p className="p-4 text-center text-xs text-tx-tertiary">暂无匹配记录</p> : filteredIndex.map((item) => (
                    <div key={item.relativePath} className="group flex items-center gap-2 border-b border-app-border/60 px-3 py-2 text-xs last:border-0">
                      <StatusIcon status={item.status} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-tx-secondary" title={item.relativePath}>{item.relativePath}</div>
                        {item.error && <div className="truncate text-[10px] text-red-500" title={item.error}>{item.error}</div>}
                      </div>
                      <span className="shrink-0 text-[10px] text-tx-tertiary">{statusLabel(item.status)}</span>
                      <span className="w-14 shrink-0 text-right text-[10px] text-tx-tertiary">{formatBytes(item.size || 0)}</span>
                      {item.noteId && (
                        <button type="button" onClick={() => onOpenNote(item.noteId!)} className="rounded p-1 text-accent-primary opacity-70 hover:bg-accent-primary/10 hover:opacity-100" title="打开对应笔记"><ExternalLink size={11} /></button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h5 className="mb-2 text-xs font-semibold text-tx-secondary">最近日志</h5>
                <div className="max-h-40 overflow-y-auto rounded-xl bg-app-bg p-2 font-mono text-[10px]">
                  {logs.length === 0 ? <p className="p-2 text-tx-tertiary">暂无日志</p> : logs.slice().reverse().slice(0, 30).map((log) => (
                    <div key={log.id} className="flex gap-2 py-1">
                      <span className="shrink-0 text-tx-tertiary">{new Date(log.createdAt).toLocaleTimeString()}</span>
                      <span className={cn("shrink-0", log.type.includes("failed") || log.type === "error" ? "text-red-500" : log.type.includes("warn") ? "text-amber-500" : "text-accent-primary")}>[{log.type}]</span>
                      <span className="break-all text-tx-secondary">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </article>
  );
}

export default function FolderSyncSettings() {
  const [configs, setConfigs] = useState<FolderSyncConfig[]>([]);
  const [notebookOptions, setNotebookOptions] = useState<NotebookOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [lastScanResults, setLastScanResults] = useState<Record<string, FolderSyncScanResult>>({});

  const loadConfigs = useCallback(async () => {
    const bridge = getFolderSync();
    if (!bridge) return;
    try {
      setConfigs(await bridge.getConfigs());
    } catch (error) {
      console.warn("[FolderSyncSettings] unable to load configs", error);
    }
  }, []);

  const loadNotebookOptions = useCallback(async () => {
    const options: NotebookOption[] = [];
    const seen = new Set<string>();
    const add = (items: any[], scope: string) => {
      for (const notebook of items || []) {
        if (!notebook?.id || seen.has(notebook.id)) continue;
        seen.add(notebook.id);
        options.push({ id: notebook.id, label: `${scope} / ${notebook.name}`, scope });
      }
    };

    try {
      const personal = await api.getNotebooks("personal");
      add(personal, "个人空间");
    } catch {
      try { add(await api.getNotebooks(), "当前空间"); } catch { /* ignore */ }
    }
    try {
      const workspaces = await api.getWorkspaces();
      for (const workspace of workspaces) {
        try { add(await api.getNotebooks(workspace.id), workspace.name); } catch { /* one inaccessible workspace must not block others */ }
      }
    } catch { /* workspace list is optional */ }
    setNotebookOptions(options);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    await Promise.all([loadConfigs(), loadNotebookOptions()]);
    setLoading(false);
  }, [loadConfigs, loadNotebookOptions]);

  useEffect(() => { void reload(); }, [reload]);

  const selectFolder = async () => {
    const bridge = getFolderSync();
    if (!bridge) return;
    if (!notebookOptions.length) {
      toast.error("请先创建一个有写入权限的笔记本");
      return;
    }
    const selected = await bridge.selectFolder();
    if (selected.cancelled || !selected.path) return;
    if (configs.some((config) => config.folderPath === selected.path)) {
      toast.error("该文件夹已经配置过同步");
      return;
    }

    setBusyKey("create");
    try {
      const result = await bridge.saveConfig({
        folderPath: selected.path,
        targetNotebookId: notebookOptions[0].id,
        includeSubfolders: true,
        fileTypes: [".md", ".txt", ".html", ".pdf", ".docx"],
        enabled: false,
        intervalMinutes: null,
      });
      if (!result.ok) throw new Error((result as any).error || "创建同步配置失败");
      const preferences = getFolderSyncPreferences(result.config.folderId, result.config as any);
      await pushFolderSyncPreferences(bridge, result.config.folderId, preferences);
      await loadConfigs();
      toast.success("已添加同步文件夹，请确认策略后启用");
    } catch (error: any) {
      toast.error(error?.message || "创建同步配置失败");
    } finally {
      setBusyKey(null);
    }
  };

  const runNow = async (folderId: string) => {
    setBusyKey(`run:${folderId}`);
    try {
      const result = await runFolderSyncOnce(folderId, { reason: "manual" });
      if (result.scanResult?.ok) setLastScanResults((current) => ({ ...current, [folderId]: result.scanResult! }));
      if (!result.ok) throw new Error(result.error || "同步失败");
      const message = `同步完成：新增 ${result.imported}，更新 ${result.updated}，删除处理 ${result.deleted}，停止跟踪 ${result.detached}，跳过 ${result.skipped}，冲突 ${result.conflicts}，失败 ${result.failed}`;
      if (result.conflicts || result.failed) toast.warning(message);
      else toast.success(message);
      await loadConfigs();
    } catch (error: any) {
      toast.error(error?.message || "同步失败");
    } finally {
      setBusyKey(null);
    }
  };

  const save = async (folderId: string, basic: Partial<FolderSyncConfig>, preferences: FolderSyncPreferences) => {
    const bridge = getFolderSync();
    if (!bridge) return;
    setBusyKey(`save:${folderId}`);
    try {
      const result = await bridge.saveConfig({ folderId, ...basic });
      if (!result.ok) throw new Error((result as any).error || "保存失败");
      await pushFolderSyncPreferences(bridge, folderId, preferences);
      await loadConfigs();
      toast.success("同步策略已保存");
    } catch (error: any) {
      toast.error(error?.message || "保存失败");
      throw error;
    } finally {
      setBusyKey(null);
    }
  };

  const remove = async (folderId: string) => {
    if (!await confirm({ title: "移除该同步文件夹？", description: "只删除本机同步配置和索引，不会删除本地文件，也不会自动删除已导入的 Nowen 笔记。", danger: true })) return;
    const bridge = getFolderSync();
    if (!bridge) return;
    setBusyKey(`remove:${folderId}`);
    try {
      await bridge.removeConfig(folderId);
      await loadConfigs();
      toast.success("同步配置已移除");
    } finally {
      setBusyKey(null);
    }
  };

  if (!isDesktop()) {
    return (
      <div className="flex flex-col items-center justify-center py-14 text-center text-tx-tertiary">
        <FolderSync size={34} className="mb-3 opacity-40" />
        <p className="text-sm font-medium text-tx-secondary">文件夹同步仅支持 Electron 桌面端</p>
        <p className="mt-1 text-xs">Web 与移动端不会获得本机文件系统访问权限。</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <FolderSync size={18} className="text-accent-primary" />
            <h3 className="text-lg font-bold text-tx-primary">本地文件夹同步</h3>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-tx-tertiary">把本地或已挂载目录安全地单向投影到个人空间或工作区笔记本。支持增量扫描、重命名识别、排除规则、删除策略和编辑冲突保护。</p>
        </div>
        <button type="button" onClick={selectFolder} disabled={busyKey === "create"} className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-accent-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busyKey === "create" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}添加文件夹
        </button>
      </div>

      <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3 text-xs leading-5 text-sky-700 dark:text-sky-300">
        安全边界：拒绝系统根目录、用户主目录、符号链接/目录联接和越界路径；单文件最多 50MB，单轮最多 10,000 个文件、累计读取最多 1GB。达到限制时会停止本轮并保留旧索引，不会误判大批文件已删除。
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-tx-tertiary"><Loader2 size={16} className="animate-spin" />正在加载同步配置…</div>
      ) : configs.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-app-border py-12 text-center">
          <FolderOpen size={30} className="mb-3 text-tx-tertiary opacity-40" />
          <p className="text-sm font-medium text-tx-secondary">尚未配置同步文件夹</p>
          <p className="mt-1 text-xs text-tx-tertiary">添加后默认关闭自动同步，确认目标与安全策略后再启用。</p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => (
            <ConfigCard
              key={config.folderId}
              config={config}
              notebookOptions={notebookOptions}
              busy={busyKey?.includes(config.folderId) === true}
              scanResult={lastScanResults[config.folderId] || null}
              onRun={() => runNow(config.folderId)}
              onRemove={() => remove(config.folderId)}
              onSave={(basic, preferences) => save(config.folderId, basic, preferences)}
              onOpenNote={(noteId) => window.dispatchEvent(new CustomEvent("nowen:open-note", { detail: { noteId } }))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
