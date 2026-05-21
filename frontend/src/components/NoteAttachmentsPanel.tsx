/**
 * NoteAttachmentsPanel —— 本笔记的附件目录列表
 * ---------------------------------------------------------------------------
 * 数据源：GET /api/files?noteId=<id>，走 attachment_references 倒排表，
 *        覆盖"自己上传 + 引用别处的附件"全部。
 *
 * 交互：
 *   - 顶部：搜索 + 分类切换（全部 / 图片 / 文档 / 视频 / 音频 / 其他）
 *   - 列表：图标 / 缩略图 + 文件名 + 大小 + 上传时间 + 操作按钮
 *   - 操作：复制链接 / 打开详情抽屉
 *   - 详情抽屉复用 AttachmentDetailDrawer（点详情即可看预览、删除、跳转引用笔记）
 *
 * 设计：照搬 VersionHistoryPanel 的居中弹窗模式，与其他笔记面板交互一致。
 */
import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  X,
  Paperclip,
  Loader2,
  Search,
  Image as ImageIcon,
  FileText,
  FileVideo,
  FileAudio,
  FileCode,
  FileArchive,
  FileSpreadsheet,
  Copy,
  Check,
  ExternalLink,
} from "lucide-react";
import { api, resolveAttachmentUrl } from "@/lib/api";
import { FileItem } from "@/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import { copyText } from "@/lib/clipboard";
import AttachmentDetailDrawer from "@/components/attachmentDetail/AttachmentDetailDrawer";

interface Props {
  noteId: string;
  noteTitle: string;
  onClose: () => void;
}

type CategoryKey = "all" | "image" | "doc" | "video" | "audio" | "other";

const CATEGORIES: { key: CategoryKey; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "image", label: "图片" },
  { key: "doc", label: "文档" },
  { key: "video", label: "视频" },
  { key: "audio", label: "音频" },
  { key: "other", label: "其他" },
];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function humanSize(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `今天 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 把 MIME 映射到 6 大类——比 FileCategory（仅 image/file）粒度更细。 */
function categoryOf(item: FileItem): CategoryKey {
  const m = (item.mimeType || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  // doc：常见文档/文本/代码/表格/PDF 一并归这里
  if (
    m === "application/pdf" ||
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m.includes("word") ||
    m.includes("excel") ||
    m.includes("spreadsheet") ||
    m.includes("powerpoint") ||
    m.includes("presentation")
  ) {
    return "doc";
  }
  return "other";
}

/** 根据 MIME / 扩展名挑一个 lucide 图标，跟 FileManager 的视觉口径一致。 */
function iconFor(item: FileItem) {
  const m = (item.mimeType || "").toLowerCase();
  const cls = "text-tx-tertiary";
  if (m.startsWith("image/")) return <ImageIcon size={16} className={cls} />;
  if (m.startsWith("video/")) return <FileVideo size={16} className={cls} />;
  if (m.startsWith("audio/")) return <FileAudio size={16} className={cls} />;
  if (m.includes("zip") || m.includes("tar") || m.includes("compressed"))
    return <FileArchive size={16} className={cls} />;
  if (m.includes("excel") || m.includes("spreadsheet") || m === "text/csv")
    return <FileSpreadsheet size={16} className={cls} />;
  if (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/javascript" ||
    m === "application/x-sh"
  )
    return <FileCode size={16} className={cls} />;
  return <FileText size={16} className={cls} />;
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export default function NoteAttachmentsPanel({ noteId, noteTitle, onClose }: Props) {
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryKey>("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 拉本笔记附件（一次拉满，UI 端做分类/搜索过滤——单笔记附件量级有限，无需分页）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.files
      .list({ noteId, pageSize: 200, sort: "created_desc" })
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((err: any) => {
        if (cancelled) return;
        console.error("[NoteAttachmentsPanel] load failed:", err);
        toast.error(err?.message || "加载笔记附件失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  // 各分类的计数（tab 上的徽标）
  const categoryCounts = useMemo(() => {
    const map: Record<CategoryKey, number> = {
      all: items.length,
      image: 0,
      doc: 0,
      video: 0,
      audio: 0,
      other: 0,
    };
    for (const it of items) map[categoryOf(it)]++;
    return map;
  }, [items]);

  // 当前可见列表：分类 + 搜索过滤
  const filtered = useMemo(() => {
    const q = searchInput.trim().toLowerCase();
    return items.filter((it) => {
      if (activeCategory !== "all" && categoryOf(it) !== activeCategory) return false;
      if (q && !it.filename.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [items, activeCategory, searchInput]);

  // 复制直链：写入剪贴板，2s 后恢复 icon
  const handleCopyLink = async (item: FileItem) => {
    try {
      await copyText(resolveAttachmentUrl(item.url));
      setCopiedId(item.id);
      setTimeout(() => setCopiedId((cur) => (cur === item.id ? null : cur)), 1800);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败");
    }
  };

  // 详情抽屉删除/重命名后回写本地列表，避免重新拉一次
  const afterDelete = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };
  const afterRename = (id: string, newName: string) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, filename: newName } : it)),
    );
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-900/60 backdrop-blur-sm"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
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
              <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center flex-shrink-0">
                <Paperclip size={16} className="text-amber-500" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-tx-primary">附件目录</h2>
                <p className="text-[11px] text-tx-tertiary truncate">
                  {noteTitle} · 共 {items.length} 个附件
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary transition-colors flex-shrink-0"
            >
              <X size={18} />
            </button>
          </div>

          {/* 工具条：搜索 + 分类 */}
          <div className="px-4 py-2.5 border-b border-app-border space-y-2">
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary pointer-events-none"
              />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="搜索文件名…"
                className="h-7 pl-7 text-xs"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map((c) => {
                const count = categoryCounts[c.key];
                const active = activeCategory === c.key;
                // 没数据的分类（除"全部"外）灰显但仍可点——保留发现性
                const dim = c.key !== "all" && count === 0;
                return (
                  <button
                    key={c.key}
                    onClick={() => setActiveCategory(c.key)}
                    className={cn(
                      "px-2 py-0.5 text-[11px] rounded-md transition-colors flex items-center gap-1",
                      active
                        ? "bg-accent-primary text-white"
                        : "bg-app-hover text-tx-secondary hover:bg-app-active",
                      dim && !active && "opacity-50",
                    )}
                  >
                    <span>{c.label}</span>
                    <span
                      className={cn(
                        "text-[10px]",
                        active ? "text-white/80" : "text-tx-tertiary",
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 列表 */}
          <ScrollArea className="flex-1 min-h-[280px]">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="animate-spin text-tx-tertiary" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-16 px-6">
                <Paperclip size={28} className="mx-auto mb-2 text-tx-tertiary/30" />
                <p className="text-xs text-tx-tertiary">
                  {items.length === 0
                    ? "本笔记还没有附件"
                    : "没有匹配的附件"}
                </p>
                <p className="text-[10px] text-tx-tertiary/60 mt-0.5">
                  {items.length === 0
                    ? "粘贴图片、拖拽文件或上传文件后会自动出现在这里"
                    : "试试调整搜索词或分类"}
                </p>
              </div>
            ) : (
              <ul className="py-1">
                {filtered.map((item) => {
                  const isImg = (item.mimeType || "").startsWith("image/");
                  const thumb = item.thumbnailUrl
                    ? resolveAttachmentUrl(item.thumbnailUrl)
                    : isImg
                      ? resolveAttachmentUrl(item.url)
                      : null;
                  return (
                    <li
                      key={item.id}
                      className="group flex items-center gap-3 px-4 py-2 hover:bg-app-hover transition-colors cursor-pointer"
                      onClick={() => setDetailId(item.id)}
                    >
                      {/* 缩略图 / 图标 */}
                      <div className="w-9 h-9 rounded-md bg-app-bg border border-app-border flex items-center justify-center overflow-hidden flex-shrink-0">
                        {thumb ? (
                          <img
                            src={thumb}
                            alt={item.filename}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              // 图片加载失败回退到通用图标
                              (e.currentTarget as HTMLImageElement).style.display = "none";
                            }}
                          />
                        ) : (
                          iconFor(item)
                        )}
                      </div>

                      {/* 名称 + 元信息 */}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-tx-primary truncate">{item.filename}</div>
                        <div className="text-[10px] text-tx-tertiary mt-0.5 flex items-center gap-2">
                          <span>{humanSize(item.size)}</span>
                          <span className="text-tx-tertiary/50">·</span>
                          <span>{formatTime(item.createdAt)}</span>
                        </div>
                      </div>

                      {/* 操作按钮（hover 显示） */}
                      <div
                        className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="复制直链"
                          onClick={() => handleCopyLink(item)}
                        >
                          {copiedId === item.id ? (
                            <Check size={13} className="text-emerald-500" />
                          ) : (
                            <Copy size={13} />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="详情"
                          onClick={() => setDetailId(item.id)}
                        >
                          <ExternalLink size={13} />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </motion.div>
      </div>

      {/* 详情抽屉——复用 AttachmentDetailDrawer 全部能力（预览 / 重命名 / 删除 / 跳转） */}
      {detailId && (
        <AttachmentDetailDrawer
          attachmentId={detailId}
          onClose={() => setDetailId(null)}
          onAfterDelete={afterDelete}
          onAfterRename={afterRename}
          showDelete
        />
      )}
    </>
  );
}
