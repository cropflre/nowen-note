import React, { useState, useEffect, useCallback } from "react";
import { FolderSync, FolderOpen, Plus, Trash2, Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import type { FolderSyncConfig } from "@/lib/desktopBridge";
import { confirm } from "@/components/ui/confirm";

function isDesktop(): boolean {
  return !!(window as any).nowenDesktop?.isDesktop;
}

function getFolderSync() {
  return (window as any).nowenDesktop?.folderSync as import("@/lib/desktopBridge").FolderSyncAPI | undefined;
}

export default function FolderSyncSettings() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<FolderSyncConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadConfigs = useCallback(async () => {
    const fs = getFolderSync();
    if (!fs) return;
    try {
      setLoading(true);
      const data = await fs.getConfigs();
      setConfigs(data);
    } catch (e) {
      console.warn("[FolderSyncSettings] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfigs(); }, [loadConfigs]);

  const handleSelectFolder = useCallback(async () => {
    const fs = getFolderSync();
    if (!fs) return;
    try {
      const result = await fs.selectFolder();
      if (result.cancelled || !result.path) return;
      setActionLoading("save");
      const res = await fs.saveConfig({ folderPath: result.path });
      if (res.ok) {
        toast.success(t("folderSync.saveConfig"));
        await loadConfigs();
      }
    } catch (e: any) {
      toast.error(e?.message || "Failed to save config");
    } finally {
      setActionLoading(null);
    }
  }, [loadConfigs, t]);

  const handleRemove = useCallback(async (folderId: string) => {
    const ok = await confirm({
      title: t("folderSync.removeConfirm"),
      danger: true,
    });
    if (!ok) return;
    const fs = getFolderSync();
    if (!fs) return;
    try {
      setActionLoading(folderId);
      await fs.removeConfig(folderId);
      await loadConfigs();
    } catch (e: any) {
      toast.error(e?.message || "Failed to remove");
    } finally {
      setActionLoading(null);
    }
  }, [loadConfigs, t]);

  const handleRunNow = useCallback(async (folderId: string) => {
    const fs = getFolderSync();
    if (!fs) return;
    try {
      setActionLoading(`run-${folderId}`);
      const result = await fs.runNow(folderId);
      if (!result.ok && result.code === "NOT_IMPLEMENTED") {
        toast.info(t("folderSync.notImplemented"));
      }
    } catch (e: any) {
      toast.error(e?.message || "Sync failed");
    } finally {
      setActionLoading(null);
    }
  }, [t]);

  // Web 端不显示
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

      {/* 添加按钮 */}
      <button
        type="button"
        onClick={handleSelectFolder}
        disabled={actionLoading === "save"}
        className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg bg-accent-primary text-white hover:opacity-90 disabled:opacity-50 transition-colors"
      >
        {actionLoading === "save" ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <Plus size={14} />
        )}
        {t("folderSync.selectFolder")}
      </button>

      {/* 配置列表 */}
      {loading ? (
        <div className="flex items-center gap-2 text-tx-tertiary text-sm">
          <Loader2 size={14} className="animate-spin" />
          Loading...
        </div>
      ) : configs.length === 0 ? (
        <div className="flex flex-col items-center py-8 text-tx-tertiary">
          <FolderOpen size={24} className="mb-2 opacity-40" />
          <p className="text-sm">{t("folderSync.noConfigs")}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {configs.map((config) => (
            <div
              key={config.folderId}
              className="p-4 rounded-xl border border-app-border bg-app-surface space-y-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-tx-primary truncate" title={config.folderPath}>
                    {config.folderPath}
                  </p>
                  <p className="text-xs text-tx-tertiary mt-1">
                    {t("folderSync.lastSynced")}: {config.lastSyncedAt
                      ? new Date(config.lastSyncedAt).toLocaleString()
                      : t("folderSync.never")}
                  </p>
                </div>
                <span className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full shrink-0",
                  config.enabled
                    ? "bg-green-500/10 text-green-600 dark:text-green-400"
                    : "bg-zinc-500/10 text-zinc-500"
                )}>
                  {config.enabled ? t("folderSync.enabled") : t("folderSync.disabled")}
                </span>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleRunNow(config.folderId)}
                  disabled={actionLoading === `run-${config.folderId}`}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-tx-secondary hover:text-accent-primary hover:bg-accent-primary/5 transition-colors disabled:opacity-50"
                >
                  {actionLoading === `run-${config.folderId}` ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  {t("folderSync.runNow")}
                </button>
                <button
                  type="button"
                  onClick={() => handleRemove(config.folderId)}
                  disabled={actionLoading === config.folderId}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs rounded-md text-tx-tertiary hover:text-red-500 hover:bg-red-500/5 transition-colors disabled:opacity-50 ml-auto"
                >
                  {actionLoading === config.folderId ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Trash2 size={12} />
                  )}
                  {t("folderSync.removeConfig")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
