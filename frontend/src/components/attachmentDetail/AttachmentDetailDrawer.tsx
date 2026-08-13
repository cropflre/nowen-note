/**
 * AttachmentDetailDrawer
 * ---------------------------------------------------------------------------
 * 复用型「附件详情抽屉」，FileManager（文件管理中心）与 TiptapEditor
 * （编辑器内点击附件链接）共用同一套交互。
 *
 * 设计要点：
 *   - 组件自管 detail 加载：传入 attachmentId，内部通过 api.files.get 拉数据。
 *   - 副作用回调只用于通知调用方刷新列表等附加动作。
 *   - 删除按钮默认隐藏，FileManager 显式开启。
 *   - 跳转笔记按钮可选；不传时引用列表只读展示。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  X,
  Trash2,
  ExternalLink,
  Download,
  Loader2,
  Copy,
  Link2,
  Maximize2,
  Minimize2,
  ShieldCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { FileDetail } from "@/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { confirm as confirmDialog } from "@/components/ui/confirm";
import { copyText } from "@/lib/clipboard";
import { downloadAttachment } from "@/lib/downloadFile";
import {
  formatImageHostSnippet,
  imageHostFormatLabel,
  type ImageHostFormat,
} from "@/lib/imageHostFormats";
import AttachmentPreview from "@/components/attachmentPreview/AttachmentPreview";

function humanSize(bytes: number): string {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let v = bytes;
  while (v >= 1024 && idx < units.length - 1) {
    v /= 1024;
    idx++;
  }
  return `${v.toFixed(v >= 10 || idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function formatLocalTime(s: string): string {
  if (!s) return "";
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface AttachmentDetailDrawerProps {
  attachmentId: string | null;
  onClose: () => void;
  onJumpToNote?: (noteId: string) => void;
  onAfterDelete?: (id: string) => void;
  onAfterRename?: (id: string, newFilename: string) => void;
  showDelete?: boolean;
  isImageHostMode?: boolean;
  extraHeaderActions?: React.ReactNode;
  renderPreview?: (detail: FileDetail, expanded: boolean) => React.ReactNode;
}

export default function AttachmentDetailDrawer({
  attachmentId,
  onClose,
  onJumpToNote,
  onAfterDelete,
  onAfterRename,
  showDelete = false,
  isImageHostMode = false,
  extraHeaderActions,
  renderPreview,
}: AttachmentDetailDrawerProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!attachmentId) {
      setDetail(null);
      return;
    }
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setDetail(null);
    api.files
      .get(attachmentId)
      .then((d) => {
        if (reqIdRef.current === myReq) setDetail(d);
      })
      .catch((err: any) => {
        if (reqIdRef.current !== myReq) return;
        console.error("[AttachmentDetailDrawer] load failed:", err);
        toast.error(err?.message || t("attachmentDetail.loadFailed"));
        onClose();
      })
      .finally(() => {
        if (reqIdRef.current === myReq) setLoading(false);
      });
  }, [attachmentId, onClose, t]);

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSubmitting, setRenameSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setRenaming(false);
    setRenameDraft("");
    setRenameSubmitting(false);
    setExpanded(false);
  }, [attachmentId]);

  const startRename = useCallback(() => {
    if (!detail) return;
    setRenameDraft(detail.filename || "");
    setRenaming(true);
  }, [detail]);

  const cancelRename = useCallback(() => {
    setRenaming(false);
    setRenameDraft("");
  }, []);

  const submitRename = useCallback(async () => {
    if (!detail) return;
    const next = renameDraft.trim();
    if (!next) {
      toast.error(t("attachmentDetail.filenameRequired"));
      return;
    }
    if (next === detail.filename) {
      cancelRename();
      return;
    }
    setRenameSubmitting(true);
    try {
      const res = await api.files.rename(detail.id, next);
      const finalName = res.filename;
      setDetail((prev) => (prev ? { ...prev, filename: finalName } : prev));
      if (!res.unchanged) toast.success(t("attachmentDetail.renamed"));
      setRenaming(false);
      setRenameDraft("");
      onAfterRename?.(detail.id, finalName);
    } catch (err: any) {
      console.error("[AttachmentDetailDrawer] rename failed:", err);
      toast.error(err?.message || t("attachmentDetail.renameFailed"));
    } finally {
      setRenameSubmitting(false);
    }
  }, [detail, renameDraft, cancelRename, onAfterRename, t]);

  const copySnippet = useCallback(
    async (format: ImageHostFormat) => {
      if (!detail) return;
      const full = resolveAttachmentUrl(detail.url);
      const snippet = formatImageHostSnippet(format, full, detail.filename);
      const ok = await copyText(snippet);
      if (ok) {
        toast.success(t("attachmentDetail.copiedFormat", { format: imageHostFormatLabel(format) }));
      } else {
        toast.error(t("attachmentDetail.copyFailed"));
      }
    },
    [detail, t],
  );

  const [downloading, setDownloading] = useState(false);
  const handleDownload = useCallback(async () => {
    if (!detail || downloading) return;
    setDownloading(true);
    try {
      await downloadAttachment(resolveAttachmentUrl(detail.url), detail.filename);
    } catch (err: any) {
      console.error("[AttachmentDetailDrawer] download failed:", err);
      toast.error(t("attachmentDetail.downloadFailed", {
        error: err?.message || t("common.unknownError"),
      }));
    } finally {
      setTimeout(() => setDownloading(false), 200);
    }
  }, [detail, downloading, t]);

  const handleDelete = useCallback(async () => {
    if (!detail) return;
    const isProtectedManualUpload = Boolean(
      (detail as FileDetail & { isAutoCleanupProtected?: boolean }).isAutoCleanupProtected,
    );
    const ok = await confirmDialog({
      title: t("attachmentDetail.deleteConfirmTitle"),
      description: isProtectedManualUpload
        ? t("attachmentDetail.protectedDeleteDescription")
        : t("attachmentDetail.deleteDescription"),
      confirmText: t("attachmentDetail.delete"),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.files.remove(detail.id);
      toast.success(t("attachmentDetail.deleted"));
      const id = detail.id;
      onClose();
      onAfterDelete?.(id);
    } catch (err: any) {
      console.error("[AttachmentDetailDrawer] delete failed:", err);
      toast.error(err?.message || t("attachmentDetail.deleteFailed"));
    }
  }, [detail, onClose, onAfterDelete, t]);

  const isAutoCleanupProtected = Boolean(
    (detail as (FileDetail & { isAutoCleanupProtected?: boolean }) | null)?.isAutoCleanupProtected,
  );

  if (!attachmentId) return null;

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-40 bg-zinc-900/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", bounce: 0, duration: 0.3 }}
        className={cn(
          "fixed right-0 top-0 bottom-0 z-50 bg-app-surface border-l border-app-border shadow-2xl flex flex-col transition-[width] duration-200",
          expanded
            ? "w-full sm:w-[90vw] md:w-[90vw]"
            : "w-full sm:w-[480px] md:w-[520px]",
        )}
      >
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0"
          style={{ paddingTop: "calc(var(--safe-area-top) + 4px)" }}
        >
          <h3 className="text-sm font-semibold text-tx-primary">{t("attachmentDetail.title")}</h3>
          <div className="flex items-center gap-1">
            {extraHeaderActions}
            <button
              className="hidden sm:inline-flex p-1.5 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-app-hover"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? t("attachmentDetail.restoreWidth") : t("attachmentDetail.expandWidth")}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              className="p-1.5 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-app-hover"
              onClick={onClose}
              aria-label={t("attachmentDetail.close")}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <ScrollArea className="flex-1 min-h-0">
          {loading || !detail ? (
            <div className="flex items-center justify-center py-20 text-tx-tertiary">
              <Loader2 size={16} className="animate-spin mr-2" />
              {t("attachmentDetail.loading")}
            </div>
          ) : (
            <div className="p-3 md:p-4 space-y-4 md:space-y-5">
              <div className="rounded-lg border border-app-border bg-app-bg overflow-hidden">
                {renderPreview ? (
                  renderPreview(detail, expanded)
                ) : (
                  <AttachmentPreview
                    url={resolveAttachmentUrl(detail.url)}
                    filename={detail.filename}
                    mimeType={detail.mimeType}
                    size={detail.size}
                    heightClass={expanded ? "min-h-[80vh]" : "min-h-[200px] md:min-h-[500px]"}
                    imgMaxHeightClass={expanded ? "max-h-[80vh]" : "max-h-[240px] md:max-h-[360px]"}
                  />
                )}
              </div>

              {isAutoCleanupProtected && (
                <div className="flex items-start gap-2.5 rounded-lg border border-emerald-500/25 bg-emerald-500/5 px-3 py-2.5">
                  <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                      <span>{t("attachmentDetail.manualUpload")}</span>
                      <span className="rounded bg-emerald-500/12 px-1.5 py-0.5 text-[10px]">{t("attachmentDetail.protected")}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] leading-4 text-tx-secondary">
                      {t("attachmentDetail.protectedHint")}
                    </div>
                  </div>
                </div>
              )}

              {(() => {
                const fullUrl = resolveAttachmentUrl(detail.url);
                return (
                  <div
                    className={cn(
                      "rounded-lg border p-3 space-y-2",
                      isImageHostMode
                        ? "border-indigo-500/30 bg-indigo-500/5"
                        : "border-app-border bg-app-bg",
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-xs">
                      <Link2
                        size={13}
                        className={isImageHostMode ? "text-indigo-500" : "text-tx-tertiary"}
                      />
                      <span
                        className={cn(
                          "font-semibold",
                          isImageHostMode ? "text-indigo-500" : "text-tx-secondary",
                        )}
                      >
                        {t("attachmentDetail.shareLink")}
                      </span>
                      <span className="text-[10px] text-tx-tertiary ml-auto">
                        {t("attachmentDetail.publicAccess")}
                      </span>
                    </div>
                    <input
                      type="text"
                      readOnly
                      value={fullUrl}
                      onFocus={(e) => e.currentTarget.select()}
                      className="w-full px-2 py-1.5 rounded-md border border-app-border bg-app-surface text-[11px] text-tx-primary font-mono outline-none focus:border-accent-primary overflow-x-auto"
                    />
                    <div className="flex flex-wrap gap-1.5">
                      {(["url", "markdown", "html"] as ImageHostFormat[]).map((fmt) => (
                        <button
                          key={fmt}
                          onClick={() => copySnippet(fmt)}
                          className={cn(
                            "px-2.5 py-1 rounded-md text-[11px] flex items-center gap-1 transition-colors",
                            isImageHostMode
                              ? "bg-indigo-500 hover:bg-indigo-600 text-white"
                              : "bg-app-surface border border-app-border hover:bg-app-hover text-tx-primary",
                          )}
                        >
                          <Copy size={11} />
                          {t("attachmentDetail.copyFormat", { format: imageHostFormatLabel(fmt) })}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div className="space-y-2 text-xs">
                <MetaRow
                  label={t("attachmentDetail.filename")}
                  value={
                    renaming ? (
                      <div className="flex items-center gap-1.5">
                        <Input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void submitRename();
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              cancelRename();
                            }
                          }}
                          disabled={renameSubmitting}
                          className="h-7 text-xs flex-1 min-w-0"
                          maxLength={255}
                        />
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 px-2 text-[11px]"
                          onClick={() => void submitRename()}
                          disabled={renameSubmitting || !renameDraft.trim()}
                        >
                          {renameSubmitting ? <Loader2 size={12} className="animate-spin" /> : t("attachmentDetail.save")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          onClick={cancelRename}
                          disabled={renameSubmitting}
                        >
                          {t("attachmentDetail.cancel")}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <span className="flex-1 min-w-0 break-words">{detail.filename}</span>
                        <button
                          type="button"
                          className="shrink-0 text-[11px] text-accent-primary hover:underline"
                          onClick={startRename}
                        >
                          {t("attachmentDetail.rename")}
                        </button>
                      </div>
                    )
                  }
                />
                <MetaRow label={t("attachmentDetail.type")} value={<code className="text-[11px]">{detail.mimeType || "-"}</code>} />
                <MetaRow label={t("attachmentDetail.size")} value={humanSize(detail.size)} />
                <MetaRow label={t("attachmentDetail.uploadedAt")} value={formatLocalTime(detail.createdAt)} />
                {detail.hash && (
                  <MetaRow
                    label={t("attachmentDetail.hash")}
                    value={
                      <code
                        className="text-[10px] text-tx-tertiary break-all select-all cursor-pointer"
                        title={t("attachmentDetail.hashTitle")}
                        onClick={async () => {
                          const ok = await copyText(detail.hash || "");
                          if (ok) toast.success(t("attachmentDetail.hashCopied"));
                        }}
                      >
                        {detail.hash}
                      </code>
                    }
                  />
                )}
                <MetaRow
                  label={t("attachmentDetail.downloadLink")}
                  value={
                    <a
                      href={resolveAttachmentUrl(detail.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent-primary hover:underline inline-flex items-center gap-1 break-all [overflow-wrap:anywhere]"
                    >
                      <Download size={11} className="shrink-0" />
                      <span>{detail.url}</span>
                    </a>
                  }
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-tx-primary">{t("attachmentDetail.referencedNotes")}</h4>
                  <span className="text-[10px] text-tx-tertiary">{t("attachmentDetail.referenceCount", { count: detail.references.length })}</span>
                </div>
                {detail.references.length === 0 ? (
                  <div className="text-xs text-tx-tertiary py-4 text-center border border-dashed border-app-border rounded-md">
                    {t("attachmentDetail.noReferences")}
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {detail.references.map((ref) => {
                      const clickable = !!onJumpToNote;
                      const Tag = clickable ? "button" : "div";
                      return (
                        <li key={ref.id}>
                          <Tag
                            className={cn(
                              "w-full text-left px-2.5 py-2 rounded-md flex items-center gap-2 group",
                              clickable && "hover:bg-app-hover cursor-pointer",
                            )}
                            onClick={
                              clickable
                                ? () => {
                                    onJumpToNote!(ref.id);
                                    onClose();
                                  }
                                : undefined
                            }
                          >
                            <span className="text-sm">{ref.notebookIcon || "📄"}</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-tx-primary truncate flex items-center gap-1.5">
                                <span className="truncate">{ref.title || t("attachmentDetail.untitled")}</span>
                                {ref.isPrimary && (
                                  <span className="shrink-0 text-[9px] px-1 py-px rounded bg-accent-primary/15 text-accent-primary">{t("attachmentDetail.primary")}</span>
                                )}
                                {ref.isTrashed === 1 && (
                                  <span className="shrink-0 text-[9px] px-1 py-px rounded bg-orange-500/15 text-orange-500">{t("attachmentDetail.trash")}</span>
                                )}
                              </div>
                              <div className="text-[10px] text-tx-tertiary truncate">
                                {ref.notebookName || "-"} · {formatLocalTime(ref.updatedAt)}
                              </div>
                            </div>
                            {clickable && (
                              <ExternalLink size={11} className="text-tx-tertiary group-hover:text-accent-primary shrink-0" />
                            )}
                          </Tag>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              <div className="pt-3 border-t border-app-border space-y-2 pb-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}>
                <Button
                  variant="default"
                  size="sm"
                  className="w-full"
                  onClick={handleDownload}
                  disabled={downloading}
                >
                  <Download size={14} className="mr-1" />
                  {t("attachmentDetail.downloadFile")}
                </Button>
                {showDelete && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-red-500 border-red-500/30 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/50"
                    onClick={handleDelete}
                  >
                    <Trash2 size={14} className="mr-1" />
                    {t("attachmentDetail.deleteFile")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </ScrollArea>
      </motion.div>
    </>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 md:gap-3">
      <span className="shrink-0 w-16 md:w-20 text-tx-tertiary">{label}</span>
      <div className="flex-1 min-w-0 text-tx-primary break-all [overflow-wrap:anywhere]">{value}</div>
    </div>
  );
}
