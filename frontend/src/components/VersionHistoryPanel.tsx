import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, History, RotateCcw, ChevronRight, FileText, Loader2, AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { NoteVersion } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";

interface VersionHistoryPanelProps {
  noteId: string;
  noteTitle: string;
  onRestore: (note: any) => void;
  onClose: () => void;
}

export default function VersionHistoryPanel({ noteId, noteTitle, onRestore, onClose }: VersionHistoryPanelProps) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selectedVersion, setSelectedVersion] = useState<NoteVersion | null>(null);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleClearAll = async () => {
    if (clearing) return;
    if (total === 0) {
      toast.info(t("versions.clearEmpty"));
      return;
    }
    setClearing(true);
    try {
      const res = await api.clearNoteVersions(noteId);
      setVersions([]);
      setTotal(0);
      setSelectedVersion(null);
      setPreviewContent(null);
      setConfirmClear(false);
      toast.success(t("versions.clearSuccess", { count: res.count }));
    } catch (e: any) {
      console.error("清空版本历史失败:", e);
      toast.error(t("versions.clearFailed") + (e?.message ? `: ${e.message}` : ""));
    } finally {
      setClearing(false);
    }
  };

  const loadVersions = useCallback(async () => {
    try {
      const data = await api.getNoteVersions(noteId);
      setVersions(data.versions);
      setTotal(data.total);
    } catch (e) {
      console.error("加载版本历史失败:", e);
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  // 预览版本内容
  const handlePreview = async (version: NoteVersion) => {
    if (selectedVersion?.id === version.id) {
      setSelectedVersion(null);
      setPreviewContent(null);
      return;
    }
    setSelectedVersion(version);
    setLoadingPreview(true);
    try {
      const data = await api.getNoteVersion(noteId, version.id);
      setPreviewContent(data.contentText || "");
    } catch (e) {
      console.error("加载版本内容失败:", e);
      setPreviewContent(t("versions.loadFailed"));
    } finally {
      setLoadingPreview(false);
    }
  };

  // 恢复版本
  const handleRestore = async (versionId: string) => {
    if (restoring) return;
    setRestoring(true);
    try {
      const updated = await api.restoreNoteVersion(noteId, versionId);
      onRestore(updated);
      setConfirmRestore(null);
      onClose();
    } catch (e: any) {
      console.error("恢复版本失败:", e);
    } finally {
      setRestoring(false);
    }
  };

  const formatTime = (date: string) => {
    // 后端 SQLite datetime('now') 存的是 UTC 字符串但不带 Z 后缀（形如 "2025-04-21 07:30:12"）。
    // 若直接 new Date(date)，浏览器会按本地时区解析，东八区下会多算 8 小时。
    // 统一补 "Z" 让 JS 按 UTC 解析。
    const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(date) ? date : date.replace(" ", "T") + "Z";
    const d = new Date(normalized);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHour = Math.floor(diffMs / 3600000);
    const diffDay = Math.floor(diffMs / 86400000);

    if (diffMin < 1) return t("versions.justNow");
    if (diffMin < 60) return t("versions.minutesAgo", { n: diffMin });
    if (diffHour < 24) return t("versions.hoursAgo", { n: diffHour });
    if (diffDay < 7) return t("versions.daysAgo", { n: diffDay });
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const changeTypeLabels: Record<string, { labelKey: string; color: string }> = {
    edit: { labelKey: "versions.typeEdit", color: "bg-blue-500/10 text-blue-500" },
    restore: { labelKey: "versions.typeRestore", color: "bg-amber-500/10 text-amber-500" },
    comment: { labelKey: "versions.typeComment", color: "bg-green-500/10 text-green-500" },
    guest_edit: { labelKey: "versions.typeGuestEdit", color: "bg-violet-500/10 text-violet-500" },
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="w-full max-w-2xl mx-4 bg-app-elevated rounded-xl shadow-2xl border border-app-border overflow-hidden max-h-[85vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-app-border">
          <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-3">
            <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center flex-shrink-0">
              <History size={16} className="text-violet-500" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-tx-primary">{t("versions.title")}</h2>
              <p className="text-[11px] text-tx-tertiary truncate">
                {noteTitle} · {t("versions.countLabel", { count: total })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {total > 0 && (
              confirmClear ? (
                <div className="flex items-center gap-1.5 mr-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmClear(false)}
                    disabled={clearing}
                    className="h-7 text-xs"
                  >
                    {t("versions.cancel")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleClearAll}
                    disabled={clearing}
                    className="h-7 text-xs bg-red-500 hover:bg-red-600 text-white"
                  >
                    {clearing ? <Loader2 size={12} className="animate-spin mr-1" /> : <Trash2 size={12} className="mr-1" />}
                    {t("versions.clearConfirmTitle")}
                  </Button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmClear(true)}
                  title={t("versions.clear")}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-tx-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 size={13} />
                  <span>{t("versions.clear")}</span>
                </button>
              )
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary transition-colors">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* 版本列表 */}
          <div className="w-1/2 border-r border-app-border flex flex-col">
            <ScrollArea className="flex-1">
              <div className="py-2">
                {loading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 size={20} className="animate-spin text-tx-tertiary" />
                  </div>
                ) : versions.length === 0 ? (
                  <div className="text-center py-12">
                    <History size={28} className="mx-auto mb-2 text-tx-tertiary/30" />
                    <p className="text-xs text-tx-tertiary">{t("versions.empty")}</p>
                    <p className="text-[10px] text-tx-tertiary/60 mt-0.5">{t("versions.emptyHint")}</p>
                  </div>
                ) : (
                  versions.map((v) => {
                    const ct = changeTypeLabels[v.changeType] || changeTypeLabels.edit;
                    return (
                      <button
                        key={v.id}
                        onClick={() => handlePreview(v)}
                        className={cn(
                          "w-full text-left px-4 py-3 transition-colors border-b border-app-border/50 hover:bg-app-hover",
                          selectedVersion?.id === v.id && "bg-accent-primary/5"
                        )}
                      >
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className={cn("px-1.5 py-0.5 text-[9px] rounded font-medium flex-shrink-0", ct.color)}>
                            {t(ct.labelKey)}
                          </span>
                          <span className="text-[10px] text-tx-tertiary flex-shrink-0">v{v.version}</span>
                          <span className="text-[10px] text-tx-tertiary/60 ml-auto flex-shrink-0">{formatTime(v.createdAt)}</span>
                        </div>
                        <p className="text-xs text-tx-secondary truncate">{v.title || t("versions.noTitle")}</p>
                        {v.changeSummary && (
                          <p className="text-[10px] text-tx-tertiary mt-0.5 truncate">{v.changeSummary}</p>
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </ScrollArea>
          </div>

          {/* 预览区域 */}
          <div className="w-1/2 flex flex-col">
            {selectedVersion ? (
              <>
                <div className="px-4 py-3 border-b border-app-border bg-app-bg/50">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-tx-primary truncate">{selectedVersion.title}</p>
                      <p className="text-[10px] text-tx-tertiary">
                        {t("versions.versionLabel", { version: selectedVersion.version })} · {formatTime(selectedVersion.createdAt)}
                      </p>
                    </div>
                    {confirmRestore === selectedVersion.id ? (
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmRestore(null)}
                          className="h-7 text-xs"
                        >
                          {t("versions.cancel")}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleRestore(selectedVersion.id)}
                          disabled={restoring}
                          className="h-7 text-xs bg-amber-500 hover:bg-amber-600 text-white"
                        >
                          {restoring ? <Loader2 size={12} className="animate-spin mr-1" /> : <RotateCcw size={12} className="mr-1" />}
                          {t("versions.restoreConfirm")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmRestore(selectedVersion.id)}
                        className="h-7 text-xs text-amber-500 hover:bg-amber-500/10 flex-shrink-0"
                      >
                        <RotateCcw size={12} className="mr-1" />
                        {t("versions.restore")}
                      </Button>
                    )}
                  </div>
                </div>
                <ScrollArea className="flex-1">
                  <div className="px-4 py-3">
                    {loadingPreview ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 size={16} className="animate-spin text-tx-tertiary" />
                      </div>
                    ) : (
                      <pre className="text-xs text-tx-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
                        {previewContent || t("versions.emptyContent")}
                      </pre>
                    )}
                  </div>
                </ScrollArea>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <FileText size={28} className="mx-auto mb-2 text-tx-tertiary/30" />
                  <p className="text-xs text-tx-tertiary">{t("versions.selectHint")}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
