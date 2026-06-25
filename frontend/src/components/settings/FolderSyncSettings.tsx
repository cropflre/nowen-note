import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  FolderSync, FolderOpen, Plus, Trash2, Loader2, RefreshCw,
  ChevronDown, ChevronUp, Save, FileText, AlertCircle, CheckCircle2,
  SkipForward, XCircle, Clock, ExternalLink, Filter,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { api } from "@/lib/api";
import type { FolderSyncConfig, FolderSyncScanResult, FolderSyncLogItem, FolderSyncIndexItem } from "@/lib/desktopBridge";
import type { Notebook } from "@/types";
import { confirm } from "@/components/ui/confirm";

const DEFAULT_FILE_TYPES = [".md", ".txt", ".html", ".pdf", ".docx"];

type IndexFilter = "all" | "error" | "skipped" | "deleted";

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function statusIcon(s: string, size = 10) {
  switch (s) {
    case "new": return <Plus size={size} className="text-green-500" />;
    case "changed": return <AlertCircle size={size} className="text-amber-500" />;
    case "synced":
    case "unchanged": return <CheckCircle2 size={size} className="text-green-400" />;
    case "deleted": return <XCircle size={size} className="text-red-400" />;
    case "skipped": return <SkipForward size={size} className="text-zinc-400" />;
    case "error": return <XCircle size={size} className="text-red-500" />;
    default: return null;
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case "new": return "新增";
    case "changed": return "变更";
    case "synced": return "已同步";
    case "unchanged": return "未变";
    case "deleted": return "已删除";
    case "skipped": return "跳过";
    case "error": return "失败";
    default: return s;
  }
}

function logTypeColor(type: string): string {
  if (type.includes("error") || type.includes("failed")) return "text-red-500";
  if (type.includes("completed") || type.includes("success")) return "text-green-600";
  if (type.includes("skipped")) return "text-zinc-400";
  return "text-tx-tertiary";
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
  onOpenNote,
}: {
  config: FolderSyncConfig;
  notebooks: Notebook[];
  saving: boolean;
  onRunNow: () => void;
  onRemove: () => void;
  onUpdate: (patch: Partial<FolderSyncConfig>) => void;
  runLoading: boolean;
  lastScanResult: FolderSyncScanResult | null;
  onOpenNote: (noteId: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<FolderSyncLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [index, setIndex] = useState<FolderSyncIndexItem[]>([]);
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexFilter, setIndexFilter] = useState<IndexFilter>("all");

  const [editNotebook, setEditNotebook] = useState(config.targetNotebookId || "");
  const [editSubfolders, setEditSubfolders] = useState(config.includeSubfolders);
  const [editFileTypes, setEditFileTypes] = useState<string[]>(config.fileTypes);
  const [editEnabled, setEditEnabled] = useState(config.enabled);

  const nbName = notebooks.find((n) => n.id === config.targetNotebookId)?.name || "—";
  const stats = lastScanResult?.ok ? lastScanResult : config.lastScanStats;

  const filteredIndex = useMemo(() => {
    if (indexFilter === "all") return index;
    return index.filter((i) => i.status === indexFilter);
  }, [index, indexFilter]);

  const indexCounts = useMemo(() => {
    const counts = { all: index.length, error: 0, skipped: 0, deleted: 0 };
    for (const i of index) {
      if (i.status === "error") counts.error++;
      else if (i.status === "skipped") counts.skipped++;
      else if (i.status === "deleted") counts.deleted++;
    }
    return counts;
  }, [index]);

  const loadLogs = useCallback(async () => {
    const fs = getFolderSync();
    if (!fs) return;
    setLogsLoading(true);
    try { setLogs(await fs.getLogs(config.folderId)); } catch { /* ignore */ }
    setLogsLoading(false);
  }, [config.folderId]);

  const loadIndex = useCallback(async () => {
    const fs = getFolderSync();
    if (!fs) return;
    setIndexLoading(true);
    try { setIndex(await fs.getIndex(config.folderId)); } catch { /* ignore */ }
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
            {/* 时间信息 */}
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
              {config.lastScanAt && (
                <span className="text-[10px] text-tx-tertiary">
                  <Clock size={9} className="inline mr-0.5" />
                  {t("folderSync.lastScan")}: {new Date(config.lastScanAt).toLocaleString()}
                </span>
              )}
              {config.lastSyncedAt && (
                <span className="text-[10px] text-tx-tertiary">
                  <CheckCircle2 size={9} className="inline mr-0.5" />
                  {t("folderSync.lastSynced")}: {new Date(config.lastSyncedAt).toLocaleString()}
                </span>
              )}
            </div>
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
          <div className="flex flex-wrap gap-1.5 mt-2">
            {stats.added > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600">+{stats.added} {t("folderSync.statAdded")}</span>}
            {stats.changed > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600">~{stats.changed} {t("folderSync.statChanged")}</span>}
            {stats.deleted > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500">-{stats.deleted} {t("folderSync.statDeleted")}</span>}
            {stats.skipped > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-500/10 text-zinc-500">{stats.skipped} {t("folderSync.statSkipped")}</span>}
            {stats.errors > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-500">{stats.errors} {t("folderSync.statErrors")}</span>}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-app-bg text-tx-tertiary">={stats.unchanged} {t("folderSync.statUnchanged")}</span>
            <span className="text-[10px] text-tx-tertiary self-center">{stats.total} {t("folderSync.statTotal")}</span>
            {stats.durationMs != null && <span className="text-[10px] text-tx-tertiary self-center">{formatDuration(stats.durationMs)}</span>}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex items-center gap-2 mt-3">
          <button type="button" onClick={onRunNow} disabled={runLoading}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/15 transition-colors disabled:opacity-50">
            {runLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {t("folderSync.runNow")}
          </button>
          <button type="button" onClick={toggleLogs}
            className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-tx-secondary hover:text-tx-primary hover:bg-app-hover transition-colors">
            <FileText size={12} />
            {showLogs ? t("folderSync.hideDetails") : t("folderSync.showDetails")}
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

      {/* 详情面板 */}
      {showLogs && (
        <div className="px-4 pb-4 border-t border-app-border/50 pt-3 space-y-3">
          {/* 提示 */}
          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-500/5 border border-amber-500/10">
            <AlertCircle size={13} className="text-amber-500 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">
              {t("folderSync.hintTextOnly")}
            </p>
          </div>

          {/* 文件索引 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-medium text-tx-tertiary">{t("folderSync.indexedFiles")} ({indexCounts.all})</p>
              <div className="flex items-center gap-1">
                {(["all", "error", "skipped", "deleted"] as IndexFilter[]).map((f) => (
                  <button key={f} type="button" onClick={() => setIndexFilter(f)}
                    className={cn("text-[10px] px-1.5 py-0.5 rounded transition-colors",
                      indexFilter === f ? "bg-accent-primary/10 text-accent-primary" : "text-tx-tertiary hover:text-tx-secondary")}>
                    {f === "all" ? t("folderSync.filterAll") : `${statusLabel(f)}${indexCounts[f] > 0 ? ` ${indexCounts[f]}` : ""}`}
                  </button>
                ))}
              </div>
            </div>

            {indexLoading ? (
              <div className="flex items-center gap-2 text-xs text-tx-tertiary"><Loader2 size={12} className="animate-spin" /> Loading...</div>
            ) : filteredIndex.length === 0 ? (
              <p className="text-xs text-tx-tertiary">{t("folderSync.noFiles")}</p>
            ) : (
              <div className="max-h-48 overflow-y-auto space-y-0.5 rounded-lg border border-app-border/50 p-2">
                {filteredIndex.map((item) => (
                  <div key={item.relativePath} className="flex items-center gap-2 text-[11px] py-0.5 group">
                    {statusIcon(item.status)}
                    <span className="text-tx-secondary truncate flex-1" title={item.relativePath}>{item.relativePath}</span>
                    <span className="text-tx-tertiary shrink-0">{formatBytes(item.size)}</span>
                    {item.status === "synced" && item.noteId && (
                      <button type="button" onClick={() => onOpenNote(item.noteId!)}
                        className="opacity-0 group-hover:opacity-100 shrink-0 text-accent-primary hover:underline transition-opacity"
                        title={t("folderSync.openNote")}>
                        <ExternalLink size={10} />
                      </button>
                    )}
                    {item.error && (
                      <span className="text-red-400 truncate max-w-[120px] shrink-0" title={item.error}>{item.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 最近日志 */}
          <div>
            <p className="text-xs font-medium text-tx-tertiary mb-1.5">{t("folderSync.recentLogs")}</p>
            {logsLoading ? (
              <div className="flex items-center gap-2 text-xs text-tx-tertiary"><Loader2 size={12} className="animate-spin" /> Loading...</div>
            ) : logs.length === 0 ? (
              <p className="text-xs text-tx-tertiary">{t("folderSync.noLogs")}</p>
            ) : (
              <div className="max-h-32 overflow-y-auto space-y-0.5">
                {logs.slice().reverse().slice(0, 15).map((log) => (
                  <div key={log.id} className="flex items-start gap-2 text-[10px]">
                    <span className="text-tx-tertiary shrink-0">{new Date(log.createdAt).toLocaleTimeString()}</span>
                    <span className={cn("shrink-0", logTypeColor(log.type))}>[{log.type}]</span>
                    <span className="text-tx-secondary truncate">{log.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
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
      const scanResult = await fs.runNow(folderId);
      if (!scanResult.ok) { toast.error(scanResult.message || "Scan failed"); return; }
      setLastScanResults((prev) => ({ ...prev, [folderId]: scanResult }));

      const pendingResult = await fs.getPendingUploads(folderId);
      if (!pendingResult.ok) { toast.error(pendingResult.error || "Failed to get pending uploads"); return; }

      const targetNotebookId = pendingResult.config.targetNotebookId;
      if (!targetNotebookId) {
        toast.info(t("folderSync.syncDoneNoUpload", { added: scanResult.added, changed: scanResult.changed })
          || `Scan done: +${scanResult.added} ~${scanResult.changed}. No target notebook, skipping upload.`);
        await loadConfigs();
        return;
      }

      let imported = 0, updated = 0, uploadSkipped = 0, uploadFailed = 0;

      for (const candidate of pendingResult.pending) {
        if (candidate.skipReason || !candidate.contentText) {
          await fs.markUploadResult(folderId, candidate.relativePath, { success: false, skipped: true, error: candidate.skipReason || "No content" });
          uploadSkipped++;
          continue;
        }
        try {
          const res = await api.folderSync.importFile({
            filename: candidate.filename, relativePath: candidate.relativePath,
            sha256: candidate.sha256, targetNotebookId, contentText: candidate.contentText,
            sourcePathHash: candidate.sourcePathHash, existingNoteId: candidate.existingNoteId || undefined,
          });
          if (res.skipped) {
            await fs.markUploadResult(folderId, candidate.relativePath, { success: true, noteId: res.noteId, skipped: true });
            uploadSkipped++;
          } else if (res.success) {
            await fs.markUploadResult(folderId, candidate.relativePath, { success: true, noteId: res.noteId });
            if (res.created) imported++; else if (res.updated) updated++;
          } else {
            await fs.markUploadResult(folderId, candidate.relativePath, { success: false, error: "Import failed" });
            uploadFailed++;
          }
        } catch (e: any) {
          await fs.markUploadResult(folderId, candidate.relativePath, { success: false, error: e?.message || "Upload error" });
          uploadFailed++;
        }
      }

      const total = imported + updated + uploadSkipped + uploadFailed;
      if (total === 0) {
        toast.success(t("folderSync.scanDone", { added: scanResult.added, changed: scanResult.changed, skipped: scanResult.skipped })
          || `Scan done: +${scanResult.added} ~${scanResult.changed} skip${scanResult.skipped}`);
      } else {
        toast.success(t("folderSync.syncDone", { imported, updated, skipped: uploadSkipped, failed: uploadFailed })
          || `Sync done: +${imported} ~${updated} skip${uploadSkipped} fail${uploadFailed}`);
      }
      await loadConfigs();
    } catch (e: any) { toast.error(e?.message || "Sync failed"); }
    finally { setActionLoading(null); }
  }, [loadConfigs, t]);

  const handleOpenNote = useCallback((noteId: string) => {
    // 打开笔记：触发全局事件让主界面切换到该笔记
    try {
      window.dispatchEvent(new CustomEvent("nowen:open-note", { detail: { noteId } }));
    } catch { /* ignore */ }
  }, []);

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
        <p className="text-sm text-tx-tertiary mb-2">{t("folderSync.description")}</p>
        <p className="text-[11px] text-tx-tertiary leading-relaxed">{t("folderSync.hintTextOnly")}</p>
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
              onOpenNote={handleOpenNote}
            />
          ))}
        </div>
      )}
    </div>
  );
}
