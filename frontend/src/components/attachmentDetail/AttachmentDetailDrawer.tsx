/**
 * AttachmentDetailDrawer
 * ---------------------------------------------------------------------------
 * 复用型「附件详情抽屉」，FileManager（文件管理中心）与 TiptapEditor
 * （编辑器内点击附件链接）共用同一套交互。
 *
 * 设计要点：
 *   - 组件自管 detail 加载：传入 attachmentId，内部通过 api.files.get 拉数据。
 *     调用方零负担，不必再维护 detail/loading state。
 *   - 副作用回调（onAfterDelete / onAfterRename）只用于「通知」调用方
 *     做列表刷新等额外动作；删除/重命名的网络请求与 toast 都由本组件完成。
 *   - 删除按钮默认隐藏（编辑器场景一般不应直接删，避免破图）；
 *     FileManager 显式传 showDelete={true} 才会出现。
 *   - 跳转笔记按钮可选；不传 onJumpToNote 时，引用列表项变为只读展示。
 *   - docx「上传新版本」等扩展动作，通过 extraHeaderActions 插槽注入；
 *     避免本组件感知具体业务。
 *
 * 拆分自旧版 FileManager.DetailDrawer + MetaRow（原文件 ~360 行）。
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
} from "lucide-react";
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

// ---------------------------------------------------------------------------
// 工具函数：人类可读大小 / 本地时间格式化（与 FileManager 保持一致）
// ---------------------------------------------------------------------------

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
  // SQLite 的 datetime('now') 返回 "YYYY-MM-DD HH:mm:ss"（UTC，不带 Z），
  // 直接 new Date() 会当本地时间解析 → 显示晚 8h。显式拼 Z 再格式化。
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AttachmentDetailDrawerProps {
  /** 要展示的附件 id；为 null 时组件自身不渲染（由调用方控制 mount/unmount）。 */
  attachmentId: string | null;
  /** 关闭抽屉。 */
  onClose: () => void;

  /** 跳转到引用此附件的笔记。不传则隐藏跳转按钮，仅展示笔记标题。 */
  onJumpToNote?: (noteId: string) => void;

  /**
   * 删除成功后的回调。组件本身已完成网络请求 + toast + 关闭抽屉，
   * 调用方只需要在这里做「从列表里剔除该 id / 刷新统计」等附加动作。
   */
  onAfterDelete?: (id: string) => void;
  /**
   * 重命名成功后的回调。同上，只用于通知调用方同步列表里的 filename。
   */
  onAfterRename?: (id: string, newFilename: string) => void;

  /**
   * 是否显示「删除文件」按钮。默认 false——
   * 编辑器场景里附件可能就是当前笔记自己引用的，删了就破图，所以默认禁掉；
   * 文件管理中心需要显式打开。
   */
  showDelete?: boolean;

  /** 图床模式：外链分享区块用更醒目的紫色高亮。仅 FileManager 用得到。 */
  isImageHostMode?: boolean;

  /**
   * 抽屉头部右侧额外动作槽位。
   * 例：docx 场景塞「上传新版本」按钮；其他场景留空。
   */
  extraHeaderActions?: React.ReactNode;

  /**
   * 自定义预览区域。不传则走默认 AttachmentPreview。
   * 例：docx 场景需要走 DocxAttachmentPreview（带"上传新版本"），
   *     由调用方传一个使用了 detail 的 ReactNode 渲染函数。
   */
  renderPreview?: (detail: FileDetail, expanded: boolean) => React.ReactNode;
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

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
  // ---- detail 加载（A1：组件自管） ----
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(false);
  // 用 ref 保存最新的请求 id，避免快速切换时旧请求覆盖新数据
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
        toast.error(err?.message || "加载文件详情失败");
        // 加载失败：直接关掉抽屉，避免停在永远 loading 的 UI
        onClose();
      })
      .finally(() => {
        if (reqIdRef.current === myReq) setLoading(false);
      });
  }, [attachmentId, onClose]);

  // ---- 重命名 ----
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameSubmitting, setRenameSubmitting] = useState(false);

  // ---- 放大态 ----
  const [expanded, setExpanded] = useState(false);

  // 切换不同附件时重置局部 UI 态
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
      toast.error("文件名不能为空");
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
      if (!res.unchanged) toast.success("已重命名");
      setRenaming(false);
      setRenameDraft("");
      onAfterRename?.(detail.id, finalName);
    } catch (err: any) {
      console.error("[AttachmentDetailDrawer] rename failed:", err);
      toast.error(err?.message || "重命名失败");
    } finally {
      setRenameSubmitting(false);
    }
  }, [detail, renameDraft, cancelRename, onAfterRename]);

  // ---- 复制外链 ----
  const copySnippet = useCallback(
    async (format: ImageHostFormat) => {
      if (!detail) return;
      const full = resolveAttachmentUrl(detail.url);
      const snippet = formatImageHostSnippet(format, full, detail.filename);
      const ok = await copyText(snippet);
      if (ok) {
        toast.success(`已复制 ${imageHostFormatLabel(format)}`);
      } else {
        toast.error("复制失败，请检查浏览器剪贴板权限");
      }
    },
    [detail],
  );

  // ---- 下载 ----
  // 同源场景走原生 <a download>，同步触发，避免"第一次点击丢失用户手势"导致下载被拦截。
  // 跨源场景由 downloadAttachment 内部回退到 fetch+blob，保留原 filename。
  // 保留 200ms 视觉反馈防连点；不再用 await fetch 阻塞 UI。
  const [downloading, setDownloading] = useState(false);
  const handleDownload = useCallback(async () => {
    if (!detail || downloading) return;
    setDownloading(true);
    try {
      await downloadAttachment(resolveAttachmentUrl(detail.url), detail.filename);
    } catch (err: any) {
      console.error("[AttachmentDetailDrawer] download failed:", err);
      toast.error(`下载失败: ${err?.message || "未知错误"}`);
    } finally {
      // 200ms 后复位，给按钮一个轻微的"按下"反馈
      setTimeout(() => setDownloading(false), 200);
    }
  }, [detail, downloading]);

  // ---- 删除（带二次确认） ----
  const handleDelete = useCallback(async () => {
    if (!detail) return;
    const ok = await confirmDialog({
      title: "确定要删除此文件吗？",
      description:
        "删除后，引用该文件的笔记里将显示为破图 / 失效链接。该操作不可撤销。",
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.files.remove(detail.id);
      toast.success("已删除");
      const id = detail.id;
      onClose();
      onAfterDelete?.(id);
    } catch (err: any) {
      console.error("[AttachmentDetailDrawer] delete failed:", err);
      toast.error(err?.message || "删除失败");
    }
  }, [detail, onClose, onAfterDelete]);

  if (!attachmentId) return null;

  return (
    <>
      {/* 遮罩 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-40 bg-zinc-900/40 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* 抽屉 */}
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
        {/* Drawer header */}
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0"
          style={{ paddingTop: "calc(var(--safe-area-top) + 4px)" }}
        >
          <h3 className="text-sm font-semibold text-tx-primary">文件详情</h3>
          <div className="flex items-center gap-1">
            {extraHeaderActions}
            <button
              className="hidden sm:inline-flex p-1.5 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-app-hover"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? "还原宽度" : "放大查看（适合 docx 等文档）"}
            >
              {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button
              className="p-1.5 rounded-md text-tx-tertiary hover:text-tx-primary hover:bg-app-hover"
              onClick={onClose}
              aria-label="关闭"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Drawer body */}
        <ScrollArea className="flex-1 min-h-0">
          {loading || !detail ? (
            <div className="flex items-center justify-center py-20 text-tx-tertiary">
              <Loader2 size={16} className="animate-spin mr-2" />
              加载中…
            </div>
          ) : (
            <div className="p-3 md:p-4 space-y-4 md:space-y-5">
              {/* 预览区 */}
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

              {/* 外链分享区块：图床模式高亮，普通模式紧凑展示 */}
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
                        外链分享
                      </span>
                      <span className="text-[10px] text-tx-tertiary ml-auto">
                        无需登录即可访问
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
                          复制 {imageHostFormatLabel(fmt)}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* 元信息 */}
              <div className="space-y-2 text-xs">
                <MetaRow
                  label="文件名"
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
                          {renameSubmitting ? <Loader2 size={12} className="animate-spin" /> : "保存"}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-[11px]"
                          onClick={cancelRename}
                          disabled={renameSubmitting}
                        >
                          取消
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
                          重命名
                        </button>
                      </div>
                    )
                  }
                />
                <MetaRow label="类型" value={<code className="text-[11px]">{detail.mimeType || "-"}</code>} />
                <MetaRow label="大小" value={humanSize(detail.size)} />
                <MetaRow label="上传时间" value={formatLocalTime(detail.createdAt)} />
                {detail.hash && (
                  <MetaRow
                    label="哈希"
                    value={
                      <code
                        className="text-[10px] text-tx-tertiary break-all select-all cursor-pointer"
                        title="SHA-256；点击复制"
                        onClick={async () => {
                          const ok = await copyText(detail.hash || "");
                          if (ok) toast.success("已复制 hash");
                        }}
                      >
                        {detail.hash}
                      </code>
                    }
                  />
                )}
                <MetaRow
                  label="下载链接"
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

              {/* 反向引用 */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-tx-primary">引用此文件的笔记</h4>
                  <span className="text-[10px] text-tx-tertiary">{detail.references.length} 条</span>
                </div>
                {detail.references.length === 0 ? (
                  <div className="text-xs text-tx-tertiary py-4 text-center border border-dashed border-app-border rounded-md">
                    没有笔记引用该文件
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {detail.references.map((ref) => {
                      // 不传 onJumpToNote 时退化为只读条目；保持视觉一致但不可点。
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
                                <span className="truncate">{ref.title || "(无标题)"}</span>
                                {ref.isPrimary && (
                                  <span className="shrink-0 text-[9px] px-1 py-px rounded bg-accent-primary/15 text-accent-primary">主</span>
                                )}
                                {ref.isTrashed === 1 && (
                                  <span className="shrink-0 text-[9px] px-1 py-px rounded bg-orange-500/15 text-orange-500">回收站</span>
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

              {/* 操作按钮区：下载 + （可选）删除 */}
              <div className="pt-3 border-t border-app-border space-y-2 pb-4" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}>
                <Button
                  variant="default"
                  size="sm"
                  className="w-full"
                  onClick={handleDownload}
                  disabled={downloading}
                >
                  {/* 不在 downloading 时切图标——同源场景下载是同步触发的，
                      200ms 内切换 Loader2 → Download 反而造成"按钮抖一下"的视觉闪烁。
                      靠 disabled 防连点已经够了。 */}
                  <Download size={14} className="mr-1" />
                  下载文件
                </Button>
                {showDelete && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full text-red-500 border-red-500/30 hover:bg-red-500/10 hover:text-red-500 hover:border-red-500/50"
                    onClick={handleDelete}
                  >
                    <Trash2 size={14} className="mr-1" />
                    删除文件
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
