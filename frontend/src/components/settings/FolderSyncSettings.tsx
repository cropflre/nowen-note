import React, { useState, useEffect, useCallback } from "react";
import { FolderSync, FolderOpen, Plus, Trash2, Loader2, RefreshCw, ChevronDown, ChevronUp, Save, FileText, AlertCircle, CheckCircle2, SkipForward, XCircle, Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { api } from "@/lib/api";
import type { FolderSyncConfig, FolderSyncScanResult, FolderSyncLogItem, FolderSyncIndexItem } from "@/lib/desktopBridge";
import type { Notebook } from "@/types";
import { confirm } from "@/components/ui/confirm";

const DEFAULT_FILE_TYPES = [".md", ".txt", ".html", ".pdf", ".docx"];

function isDesktop(): boolean {
  return !!(window as any).nowenDesktop?.isDesktop;
}

function getFolderSync() {
  return (window as any).nowenDesktop?.folderSync as import("@/lib/desktopBridge").FolderSyncAPI | undefined;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 单个配置卡片 */
function ConfigCard({
  config,
  notebooks,
  saving,
  onRunNow,
  onRemove,
  onUpdate,
  runLoading,
  lastScanResult,
}: {
  config: FolderSyncConfig;
  notebooks: Notebook[];
  saving: boolean;
  onRunNow: () => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<FolderSyncConfig>) => void;
  runLoading: boolean;
  lastScanResult: FolderSyncScanResult | null;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<FolderSyncLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [index, setIndex] = useState<FolderSyncIndexItem[]>([]);
  const [indexLoading, setIndexLoading] = useState(false);

  const [editNotebook, setEditNotebook] = useState(config.targetNotebookId || "");
  const [editSubfolders, setEditSubfolders] = useState(config.includeSubfolders);
  const [editFileTypes, setEditFileTypes] = useState<string[]>(config.fileTypes);
  const [editEnabled, setEditEnabled] = useState(config.enabled);

  const nbName = notebooks.find((n) => n.id === config.targetNotebookId)?.name || "—";
  const stats = lastScanResult?.ok ? lastScanResult : config.lastScanStats;

  const loadLogs = useCallback(async () => {
    const fs = getFolderSync();
    if (!fs) return;
    setLogsLoading(true);
    try {
      const data = await fs.getLogs(config.folderId);
      setLogs(data);
    } catch { /* ignore */ }
    setLogsLoading(false);
  }, [config.folderId]);

  const loadIndex = useCallback(async () => {
    const fs = getFolderSync();
    if (!fs) return;
    setIndexLoading(true);
    try {
      const data = await fs.getIndex(config.folderId);
      setIndex(data);
    } catch { /* ignore */ }
    setIndexLoading(false);
  }, [config.folderId]);

  const toggleLogs = () => {
    if (!showLogs) { loadLogs(); loadIndex(); }
    setShowLogs(!showLogs);
  };

  const handleSave = () => {
    onUpdate({
      targetNotebookId: editNotebook || null,
      includeSubfolders: editSubfolders,
      fileTypes: editFileTypes,
      enabled: editNotebook ? editEnabled : false,
    });
  };

  const toggleFileType = (ext: string) => {
    setEditFileTypes((prev) => prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext]);
  };

  const statusIcon = (s: string) => {
    switch (s) {
      case "new": return <Plus size={10} className="text-green-500" />;
      case "changed": return <AlertCircle size={10} className="text-amber-500" />;
      case "unchanged": return <CheckCircle2 size={10} className="text-tx-tertiary" />;
      case "deleted": return <XCircle size={10} className="text-red-400" />;
      case "skipped": return <SkipForward size={10} className="text-tx-tertiary" />;
      case "error": return <XCircle size={10} className="text-red-500" />;
      default: return null;
    }
  };

  return (
    <div className="rounded-xl border border-app-border bg-app-surface overflow-hidden">
      {/* 头部 */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-tx-primary truncate" title={config.folderPath}>
              {config.folderPath}
            </p>
            <p className="text-xs text-tx-tertiary mt-1">
              {t("folderSync.targetNotebook")}: {nbName}
            </p>
            {config.lastScanAt && (
              <p className="text-xs text-tx-tertiary">
                <Clock size={10} className="inline mr-1" />
                {t("folderSync.lastScan")}: {new Date(config.lastScanAt).toLocaleString()}
              </p>
            )}
          </div>
          <span className={cn(
            "text-[10px] px-1.5 py-0.5 rounded-full shrink-0",
            config.enabled ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-zinc-500/10 text-zinc-500"
          )}>
            {config.enabled ? t("folderSync.enabled") : t("folderSync.disabled")}
          </span>
        </div>

        {/* 扫描统计 */}
        {stats && (
          <div className="flex flex-wrap gap-2 mt-2">
            {stats.added > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600">+{stats.added} {t("folderSync.statAdded")}</span>}
            {stats.changed > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">~{stats.changed} {t("folderSync.statChanged")}</span>}
            {stats.deleted > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500">-{stats.deleted} {t("folderSync.statDeleted")}</span>}
            {stats.skipped > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-500">{stats.skipped} {t("folderSync.statSkipped")}</span>}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-app-bg text-tx-tertiary">={stats.unchanged} {t("folderSync.statUnchanged")}</span>
            <span className="text-[10px] text-tx-tertiary">{stats.total} {t("folderSync.statTotal")}</span>
            {stats.durationMs != null && <span className="text-[10px] text-tx-tertiary">{formatDuration(stats.durationMs)}</span>}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={onRunNow}
            disabled={runLoading}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-tx-secondary hover:text-accent-primary hover:bg-accent-primary/5 transition-colors disabled:opacity-50"
          >
            {runLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {t("folderSync.runNow")}
          </button>
          <button type="button" onClick={toggleLogs}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors">
            <FileText size={12} />
            {showLogs ? t("folderSync.hideLogs") : t("folderSync.showLogs")}
          </button>
          <button type="button" onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors">
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? t("common.cancel") : t("folderSync.editConfig")}
          </button>
          <button type="button" onClick={onRemove}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-tx-tertiary hover:text-red-500 hover:bg-red-500/5 transition-colors ml-auto">
            <Trash2 size={12} />
            {t("folderSync.removeConfig")}
          </button>
        </div>
      </div>

      {/* 日志面板 */}
      {showLogs && (
        <div className="px-4 pb-3 border-t border-app-border/50 pt-3">
          <p className="text-xs font-medium text-tx-tertiary mb-2">{t("folderSync.recentLogs")}</p>
          {logsLoading ? (
            <div className="flex items-center gap-2 text-xs text-tx-tertiary"><Loader2 size={12} className="animate-spin" /> Loading...</div>
          ) : logs.length === 0 ? (
            <p className="text-xs text-tx-tertiary">{t("folderSync.noLogs")}</p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {logs.slice().reverse().map((log) => (
                <div key={log.id} className="flex items-start gap-2 text-[11px]">
                  <span className="text-tx-tertiary shrink-0">{new Date(log.createdAt).toLocaleTimeString()}</span>
                  <span className={cn(
                    "shrink-0",
                    log.type.includes("error") || log.type.includes("failed") ? "text-red-500" :
                    log.type.includes("completed") ? "text-green-600" : "text-tx-tertiary"
                  )}>
                    [{log.type}]
                  </span>
                  <span className="text-tx-secondary truncate">{log.message}</span>
                </div>
              ))}
            </div>
          )}
          {/* 文件索引摘要 */}
          {index.length > 0 && (
            <div className="mt-2 pt-2 border-t border-app-border/30">
              <p className="text-xs font-medium text-tx-tertiary mb-1">
                {t("folderSync.indexedFiles")} ({index.length})
              </p>
              <div className="max-h-32 overflow-y-auto space-y-0.5">
                {index.slice(0, 20).map((item) => (
                  <div key={item.relativePath} className="flex items-center gap-1.5 text-[10px]">
                    {statusIcon(item.status)}
                    <span className="text-tx-secondary truncate flex-1">{item.relativePath}</span>
                    <span className="text-tx-tertiary shrink-0">{(item.size / 1024).toFixed(0)}KB</span>
                  </div>
                ))}
                {index.length > 20 && <p className="text-[10px] text-tx-tertiary">... {index.length - 20} more</p>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 编辑面板 */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-app-border/50 pt-3">
          <div>
            <label className="block text-xs text-tx-tertiary mb-1">{t("folderSync.targetNotebook")}</label>
            <select value={editNotebook} onChange={(e) => setEditNotebook(e.target.value)}
              className="w-full text-sm rounded-lg border border-app-border bg-app-bg text-tx-primary px-3 py-1.5 outline-none focus:ring-2 focus:ring-accent-primary/30">
              <option value="">{t("folderSync.selectNotebook")}</option>
              {notebooks.map((nb) => <option key={nb.id} value={nb.id}>{nb.name}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={editSubfolders} onChange={(e) => setEditSubfolders(e.target.checked)}
              className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30" />
            <span className="text-xs text-tx-secondary">{t("folderSync.includeSubfolders")}</span>
          </label>
          <div>
            <label className="block text-xs text-tx-tertiary mb-1.5">{t("folderSync.fileTypes")}</label>
            <div className="flex flex-wrap gap-2">
              {DEFAULT_FILE_TYPES.map((ext) => (
                <button key={ext} type="button" onClick={() => toggleFileType(ext)}
                  className={cn("px-2 py-0.5 text-[11px] rounded-md border transition-colors",
                    editFileTypes.includes(ext) ? "bg-accent-primary/10 border-accent-primary/30 text-accent-primary" : "border-app-border text-tx-tertiary hover:text-tx-secondary")}>
                  {ext}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={editEnabled} onChange={(e) => setEditEnabled(e.target.checked)}
              disabled={!editNotebook}
              className="rounded border-app-border text-accent-primary focus:ring-accent-primary/30 disabled:opacity-40" />
            <span className={cn("text-xs", editNotebook ? "text-tx-secondary" : "text-tx-tertiary")}>
              {t("folderSync.enableSync")}
              {!editNotebook && ` (${t("folderSync.selectNotebookFirst")})`}
            </span>
          </label>
          <button type="button" onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-accent-primary text-white hover:opacity-90 disabled:opacity-50 transition-colors">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {t("folderSync.saveConfig")}
          </button>
        </div>
      )}
    </div>
  );
}

export default function FolderSyncSettings() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<FolderSyncConfig[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [lastScanResults, setLastScanResults] = useState<Record<string, FolderSyncScanResult>>({});

  const loadConfigs = useCallback(async () => {
    const fs = getFolderSync();
    if (!fs) return;
    try { setLoading(true); setConfigs(await fs.getConfigs()); }
    catch (e) { console.warn("[FolderSyncSettings] load failed:", e); }
    finally { setLoading(false); }
  }, []);

  const loadNotebooks = useCallback(async () => {
    try { setNotebooks(await api.getNotebooks()); } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadConfigs(); loadNotebooks(); }, [loadConfigs, loadNotebooks]);

  const handleSelectFolder = useCallback(async () => {
    const fs = getFolderSync();
    if (!fs) return;
    if (notebooks.length === 0) { toast.error(t("folderSync.noNotebooks")); return; }
    try {
      const result = await fs.selectFolder();
      if (result.cancelled || !result.path) return;
      if (configs.some((c) => c.folderPath === result.path)) { toast.error(t("folderSync.duplicatePath")); return; }
      setActionLoading("save");
      const res = await fs.saveConfig({
        folderPath: result.path,
        targetNotebookId: notebooks[0]?.id || null,
        includeSubfolders: true,
        fileTypes: DEFAULT_FILE_TYPES,
        enabled: false,
      });
      if (res.ok) { toast.success(t("folderSync.configCreated")); await loadConfigs(); }
    } catch (e: any) { toast.error(e?.message || "Failed to save config"); }
    finally { setActionLoading(null); }
  }, [notebooks, configs, loadConfigs, t]);

  const handleRemove = useCallback(async (folderId: string) => {
    if (!await confirm({ title: t("folderSync.removeConfirm"), danger: true })) return;
    const fs = getFolderSync();
    if (!fs) return;
    try { setActionLoading(folderId); await fs.removeConfig(folderId); await loadConfigs(); }
    catch (e: any) { toast.error(e?.message || "Failed to remove"); }
    finally { setActionLoading(null); }
  }, [loadConfigs, t]);

  const handleUpdate = useCallback(async (folderId: string, patch: Partial<FolderSyncConfig>) => {
    const fs = getFolderSync();
    if (!fs) return;
    try {
      setActionLoading(`update-${folderId}`);
      await fs.saveConfig({ folderId, ...patch });
      await loadConfigs();
      toast.success(t("folderSync.configUpdated"));
    } catch (e: any) { toast.error(e?.message || "Failed to update"); }
    finally { setActionLoading(null); }
  }, [loadConfigs, t]);

  const handleRunNow = useCallback(async (folderId: string) => {
    const fs = getFolderSync();
    if (!fs) return;
    try {
      setActionLoading(`run-${folderId}`);
      const result = await fs.runNow(folderId);
      if (result.ok) {
        setLastScanResults((prev) => ({ ...prev, [folderId]: result }));
        toast.success(
          t("folderSync.scanDone", { added: result.added, changed: result.changed, skipped: result.skipped })
          || `Scan done: +${result.added} ~${result.changed} skip${result.skipped}`
        );
        await loadConfigs();
      } else {
        toast.error(result.message || "Scan failed");
      }
    } catch (e: any) { toast.error(e?.message || "Scan failed"); }
    finally { setActionLoading(null); }
  }, [loadConfigs, t]);

  if (!isDesktop()) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-tx-tertiary">
        <FolderSync size={32} className="mb-3 opacity-40" />
        <p className="text-sm">{t("folderSync.noDesktop")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <FolderSync className="w-4 h-4 text-accent-primary" />
          <h3 className="text-lg font-bold text-tx-primary">{t("folderSync.title")}</h3>
        </div>
        <p className="text-sm text-tx-tertiary mb-4">{t("folderSync.description")}</p>
      </div>

      <button type="button" onClick={handleSelectFolder} disabled={actionLoading === "save"}
        className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-accent-primary text-white hover:opacity-90 disabled:opacity-50 transition-colors">
        {actionLoading === "save" ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
        {t("folderSync.selectFolder")}
      </button>

      {loading ? (
        <div className="flex items-center gap-2 text-tx-tertiary text-sm"><Loader2 size={14} className="animate-spin" /> Loading...</div>
      ) : configs.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-tx-tertiary">
          <FolderOpen size={24} className="mb-2 opacity-40" />
          <p className="text-sm">{t("folderSync.noConfigs")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => (
            <ConfigCard
              key={config.folderId}
              config={config}
              notebooks={notebooks}
              saving={actionLoading === `update-${config.folderId}`}
              runLoading={actionLoading === `run-${config.folderId}`}
              lastScanResult={lastScanResults[config.folderId] || null}
              onRunNow={() => handleRunNow(config.folderId)}
              onRemove={() => handleRemove(config.folderId)}
              onUpdate={(patch) => handleUpdate(config.folderId, patch)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
