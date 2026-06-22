import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Send,
  Trash2,
  Loader2,
  ChevronDown,
  Smile,
  MessageCircle,
  ImagePlus,
  Camera,
  Video,
  X,
  Calendar,
  User as UserIcon,
  Edit2,
  Check,
  Search,
} from "lucide-react";
import { api, getCurrentWorkspace } from "@/lib/api";
import { Diary, DiaryMediaItem, DiaryStats } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import {
  loadDiaryDraft,
  saveDiaryDraft,
  clearDiaryDraft,
  isDiaryDraftExpired,
  type DiaryDraftMedia,
} from "@/lib/diaryDraft";

// 心情选项
const MOODS = [
  { value: "happy", emoji: "😊" },
  { value: "excited", emoji: "🥳" },
  { value: "peaceful", emoji: "😌" },
  { value: "thinking", emoji: "🤔" },
  { value: "tired", emoji: "😴" },
  { value: "sad", emoji: "😢" },
  { value: "angry", emoji: "😤" },
  { value: "sick", emoji: "🤒" },
  { value: "love", emoji: "🥰" },
  { value: "cool", emoji: "😎" },
  { value: "laugh", emoji: "🤣" },
  { value: "shock", emoji: "😱" },
];

function getMoodEmoji(mood: string): string {
  return MOODS.find((m) => m.value === mood)?.emoji || "";
}

// ---------------------------------------------------------------------------
// 图片相关常量与工具
// ---------------------------------------------------------------------------
// 单条说说图片数量上限。前端硬限制 + 后端 diary.ts 也限制，双保险。
const MAX_IMAGES_PER_DIARY = 9;
const MAX_VIDEOS_PER_DIARY = 1;
// 单张图大小上限，与后端 MAX_DIARY_IMAGE_SIZE 保持一致 → 不一致会出现"前端选过、后端拒"的尴尬
const MAX_DIARY_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_DIARY_VIDEO_SIZE = 100 * 1024 * 1024;
// 与后端 ALLOWED_DIARY_IMAGE_MIMES 对齐（不收 svg 防 XSS）
const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);
const ALLOWED_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

// 相对时间显示
function timeAgo(dateStr: string, t: (key: string) => string): string {
  const now = new Date();
  const date = new Date(dateStr.replace(" ", "T") + "Z");
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return t("diary.justNow");
  if (diffMin < 60) return t("diary.minutesAgo").replace("{{n}}", String(diffMin));
  if (diffHour < 24) return t("diary.hoursAgo").replace("{{n}}", String(diffHour));
  if (diffDay < 7) return t("diary.daysAgo").replace("{{n}}", String(diffDay));

  // 超过 7 天显示具体日期
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  if (y === now.getFullYear()) return `${m}-${d} ${h}:${min}`;
  return `${y}-${m}-${d} ${h}:${min}`;
}

// ---------------------------------------------------------------------------
// 待上传 / 上传中 / 上传失败的本地图片项
//   - id 为 null 表示尚未上传成功（仍只在本地）
//   - previewUrl 用 URL.createObjectURL 生成；卸载时 revoke 防内存泄漏
//   - status: 控制缩略图上的 spinner / 错误覆盖层
// ---------------------------------------------------------------------------
interface PendingMedia {
  /** 本地随机 key，用于 React 列表渲染 + 删除定位 */
  localKey: string;
  /** 上传成功后的服务端 id；上传中 / 失败为 null */
  id: string | null;
  type: "image" | "video";
  /** 本地预览（blob:），上传成功后保留此预览（无需重新拉远端图） */
  previewUrl: string;
  mimeType?: string;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
}

function diaryMediaFromItem(item: Diary): DiaryMediaItem[] {
  if (Array.isArray(item.media) && item.media.length > 0) return item.media;
  return (item.images || []).map((id) => ({ id, type: "image" as const }));
}

function mediaUrl(id: string): string {
  return api.diaryImages.urlFor(id);
}

function mediaTypeForFile(file: File): "image" | "video" | null {
  const mime = (file.type || "").toLowerCase();
  if (ALLOWED_IMAGE_MIMES.has(mime)) return "image";
  if (ALLOWED_VIDEO_MIMES.has(mime)) return "video";
  return null;
}

// ============================================================
// 发布框
// ============================================================
function ComposeBox({ onPost }: { onPost: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [mood, setMood] = useState("");
  const [showMoods, setShowMoods] = useState(false);
  const [posting, setPosting] = useState(false);
  // 拖拽视觉反馈（dragOver 时高亮整个卡片）
  const [isDragging, setIsDragging] = useState(false);
  // 待发布媒体队列。用 ref 留一份镜像，因为粘贴 / 拖拽回调里要拿到最新值再
  // setState，避免函数式更新里反复读旧 state 计数错误。
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const pendingMediaRef = useRef<PendingMedia[]>([]);
  pendingMediaRef.current = pendingMedia;

  // 草稿恢复：mount 时读取当前 workspace 草稿
  const [draftRestored, setDraftRestored] = useState(false);
  useEffect(() => {
    const draft = loadDiaryDraft();
    if (!draft) return;
    if (isDiaryDraftExpired(draft)) {
      clearDiaryDraft();
      toast.info(t("diary.draftExpired"));
      return;
    }
    if (draft.text) setText(draft.text);
    if (draft.mood) setMood(draft.mood);
    if (draft.media.length > 0) {
      setPendingMedia(
        draft.media.map((m) => ({
          localKey: m.id,
          id: m.id,
          type: m.type,
          mimeType: m.mimeType,
          previewUrl: api.diaryImages.urlFor(m.id),
          status: "ready" as const,
        })),
      );
    }
    if (draft.text || draft.mood || draft.media.length > 0) {
      setDraftRestored(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 草稿自动保存：text / mood / ready media 变化时保存（300ms 防抖）
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      const readyMedia: DiaryDraftMedia[] = pendingMedia
        .filter((p) => p.status === "ready" && p.id)
        .map((p) => ({ id: p.id!, type: p.type, mimeType: p.mimeType }));
      if (!text.trim() && !mood && readyMedia.length === 0) {
        clearDiaryDraft();
      } else {
        saveDiaryDraft({
          version: 1,
          workspaceId: getCurrentWorkspace() || "personal",
          text: text.trim(),
          mood,
          media: readyMedia,
          updatedAt: Date.now(),
        });
      }
    }, 300);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mood, pendingMedia]);

  // 清空草稿并释放已上传未发布媒体
  const clearDraftAndMedia = useCallback(() => {
    const readyIds = pendingMediaRef.current
      .filter((p) => p.status === "ready" && p.id)
      .map((p) => p.id!);
    for (const id of readyIds) {
      api.diaryImages.remove(id).catch(() => {});
    }
    for (const item of pendingMediaRef.current) {
      if (item.previewUrl.startsWith("blob:")) {
        try { URL.revokeObjectURL(item.previewUrl); } catch {}
      }
    }
    clearDiaryDraft();
    setText("");
    setMood("");
    setPendingMedia([]);
    setDraftRestored(false);
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const moodRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const recordInputRef = useRef<HTMLInputElement>(null);
  // dragOver/Leave 计数：浏览器会在子元素切换时狂抛 enter/leave 事件，
  // 直接 setState 会闪烁。用计数器保证只有真正离开容器才隐藏高亮。
  const dragCounterRef = useRef(0);

  // 自动调整 textarea 高度
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, []);

  // 点击外部关闭心情选择器
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moodRef.current && !moodRef.current.contains(e.target as Node)) {
        setShowMoods(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 卸载时回收所有 blob URL
  useEffect(() => {
    return () => {
      for (const item of pendingMediaRef.current) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // -------------------------------------------------------------------------
  // 添加文件到上传队列（共用入口：input change / 粘贴 / 拖拽 都走这里）
  //   - 校验 MIME 与大小，把不合规的剔掉并告知用户（这里用 alert 简单兜底；
  //     如果项目有全局 toast 可以替换）
  //   - 受 MAX_IMAGES_PER_DIARY 卡上限，超出部分静默丢弃
  // -------------------------------------------------------------------------
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const current = pendingMediaRef.current;
      const currentType = current[0]?.type;
      const accepted: Array<{ file: File; type: "image" | "video" }> = [];
      const rejected: { name: string; reason: string }[] = [];
      for (const f of files) {
        const mime = (f.type || "").toLowerCase();
        const type = mediaTypeForFile(f);
        if (!type) {
          rejected.push({ name: f.name || "image", reason: "type" });
          continue;
        }
        if (currentType && currentType !== type) {
          rejected.push({ name: f.name || "media", reason: "mix" });
          continue;
        }
        if (type === "image" && f.size > MAX_DIARY_IMAGE_SIZE) {
          rejected.push({ name: f.name || "image", reason: "size" });
          continue;
        }
        if (type === "video" && f.size > MAX_DIARY_VIDEO_SIZE) {
          rejected.push({ name: f.name || "video", reason: "video-size" });
          continue;
        }
        const currentImageCount = current.filter((x) => x.type === "image").length;
        const acceptedImageCount = accepted.filter((x) => x.type === "image").length;
        const currentVideoCount = current.filter((x) => x.type === "video").length;
        const acceptedVideoCount = accepted.filter((x) => x.type === "video").length;
        if (type === "image" && currentImageCount + acceptedImageCount >= MAX_IMAGES_PER_DIARY) {
          rejected.push({ name: f.name || "image", reason: "max-images" });
          continue;
        }
        if (type === "video" && currentVideoCount + acceptedVideoCount >= MAX_VIDEOS_PER_DIARY) {
          rejected.push({ name: f.name || "video", reason: "max-videos" });
          continue;
        }
        accepted.push({ file: f, type });
      }
      if (rejected.length) {
        const lines = rejected.map((r) => {
          if (r.reason === "size") return t("diary.imageTooLarge").replace("{{name}}", r.name);
          if (r.reason === "video-size") return t("diary.media.videoTooLarge").replace("{{name}}", r.name);
          if (r.reason === "mix") return t("diary.media.noMixImageVideo");
          if (r.reason === "max-images") return t("diary.media.maxImages").replace("{{n}}", String(MAX_IMAGES_PER_DIARY));
          if (r.reason === "max-videos") return t("diary.media.maxVideos").replace("{{n}}", String(MAX_VIDEOS_PER_DIARY));
          return t("diary.media.unsupportedType").replace("{{name}}", r.name);
        });
        for (const line of lines) toast.error(line);
      }
      if (!accepted.length) return;

      // 先把"上传中"占位丢进 state，UI 立刻有反馈；逐个并发上传更新各自状态。
      const newItems: PendingMedia[] = accepted.map(({ file, type }) => ({
        localKey: crypto.randomUUID(),
        id: null,
        type,
        previewUrl: URL.createObjectURL(file),
        mimeType: file.type,
        status: "uploading",
      }));
      setPendingMedia((prev) => [...prev, ...newItems]);

      // 并发上传；每个媒体独立处理结果（部分失败不影响其他项）
      newItems.forEach((item, idx) => {
        const { file } = accepted[idx];
        api.diaryImages
          .upload(file)
          .then((res) => {
            setPendingMedia((prev) =>
              prev.map((p) =>
                p.localKey === item.localKey
                  ? { ...p, id: res.id, type: res.type, mimeType: res.mimeType, status: "ready" as const }
                  : p,
              ),
            );
          })
          .catch((err) => {
            console.error("Diary media upload failed:", err);
            toast.error(err?.message || t("diary.media.uploadFailed"));
            setPendingMedia((prev) =>
              prev.map((p) =>
                p.localKey === item.localKey
                  ? {
                      ...p,
                      status: "error" as const,
                      errorMessage: err?.message || "upload failed",
                    }
                  : p,
              ),
            );
          });
      });
    },
    [t],
  );

  // 移除一个媒体：未上传成功的直接丢；已上传成功的同时调后端 DELETE 释放服务端文件
  const removeMedia = useCallback((localKey: string) => {
    const target = pendingMediaRef.current.find((p) => p.localKey === localKey);
    if (!target) return;
    setPendingMedia((prev) => prev.filter((p) => p.localKey !== localKey));
    try {
      URL.revokeObjectURL(target.previewUrl);
    } catch {
      /* ignore */
    }
    if (target.id && target.status === "ready") {
      // 后端会校验"未绑定 diary"才允许删；此处出错忽略即可（最坏情况是个孤儿，
      // 24h 后被 sweepOrphanDiaryImages 清理）。
      api.diaryImages.remove(target.id).catch(() => {
        /* ignore */
      });
    }
  }, []);

  // 文件选择
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    void addFiles(files);
    // 清空 value，下次选同一张图也能触发 change
    e.target.value = "";
  };

  // 粘贴：从剪贴板里抓出图片文件
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault(); // 阻止默认（防止把 [object File] 文本塞进去）
      void addFiles(files);
    }
  };

  // 拖拽
  const handleDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDragging(true);
  };
  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  };
  const handleDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files || []).filter((f) =>
      f.type.startsWith("image/") || f.type.startsWith("video/"),
    );
    if (files.length) void addFiles(files);
  };

  const hasPendingUploads = pendingMedia.some((p) => p.status === "uploading");
  const hasErrorMedia = pendingMedia.some((p) => p.status === "error");
  const readyMedia = pendingMedia
    .filter((p) => p.status === "ready" && p.id)
    .map((p) => ({ id: p.id!, type: p.type }));
  const readyImageIds = readyMedia.filter((p) => p.type === "image").map((p) => p.id);

  // 提交条件：内容/媒体至少一项，且没有上传中
  const canSubmit =
    !posting &&
    !hasPendingUploads &&
    (text.trim().length > 0 || readyMedia.length > 0);

  const handlePost = async () => {
    if (!canSubmit) return;
    setPosting(true);
    try {
      await api.postDiary({
        contentText: text.trim(),
        mood,
        media: readyMedia,
        images: readyImageIds,
      });
      // 重置：先 revoke 所有 blob URL（已发布图片由后端持久化，前端不再需要 blob）
      for (const item of pendingMediaRef.current) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {
          /* ignore */
        }
      }
      setText("");
      setMood("");
      setShowMoods(false);
      setPendingMedia([]);
      clearDiaryDraft();
      setDraftRestored(false);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
      onPost();
    } catch (e) {
      console.error("Post failed:", e);
    } finally {
      setPosting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl/Cmd + Enter 发布
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handlePost();
    }
  };

  const selectedMoodEmoji = getMoodEmoji(mood);
  const hasVideo = pendingMedia.some((p) => p.type === "video");
  const hasImages = pendingMedia.some((p) => p.type === "image");
  const remainingImageSlots = hasVideo ? 0 : MAX_IMAGES_PER_DIARY - pendingMedia.filter((p) => p.type === "image").length;
  const remainingVideoSlots = hasImages ? 0 : MAX_VIDEOS_PER_DIARY - pendingMedia.filter((p) => p.type === "video").length;

  return (
    <div
      className={cn(
        "relative z-40 bg-app-surface/60 backdrop-blur-sm rounded-2xl border border-app-border shadow-sm transition-all",
        isDragging && "ring-2 ring-accent-primary/50 border-accent-primary/40",
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 输入区域 */}
      <div className="p-4 pb-2">
        {/* 草稿恢复提示 */}
        {draftRestored && (
          <div className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-lg bg-accent-primary/5 border border-accent-primary/20 text-[11px] text-accent-primary">
            <span>{t("diary.draftRestored")}</span>
            <button
              onClick={() => clearDraftAndMedia()}
              className="ml-auto px-2 py-0.5 rounded text-[10px] hover:bg-accent-primary/10"
            >
              {t("diary.draftClear")}
            </button>
            <button
              onClick={() => setDraftRestored(false)}
              className="px-2 py-0.5 rounded text-[10px] hover:bg-accent-primary/10"
            >
              {t("diary.draftDismiss")}
            </button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t("diary.placeholder")}
          rows={2}
          className="w-full bg-transparent text-tx-primary placeholder:text-tx-tertiary text-sm leading-relaxed resize-none outline-none min-h-[52px]"
        />

        {/* 待发布媒体预览区 */}
        {pendingMedia.length > 0 && (
          <div className="mt-2 grid grid-cols-4 sm:grid-cols-5 gap-2">
            {pendingMedia.map((media) => (
              <div
                key={media.localKey}
                className={cn(
                  "relative rounded-lg overflow-hidden border border-app-border bg-app-hover/40 group/img",
                  media.type === "video" ? "col-span-4 sm:col-span-3 aspect-video" : "aspect-square",
                )}
              >
                {media.type === "video" ? (
                  <video
                    src={media.previewUrl}
                    className="w-full h-full object-cover bg-black"
                    controls
                    preload="metadata"
                    playsInline
                  />
                ) : (
                  <img
                    src={media.previewUrl}
                    alt=""
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                )}
                {/* 上传中遮罩 */}
                {media.status === "uploading" && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <Loader2 size={18} className="animate-spin text-white" />
                  </div>
                )}
                {/* 上传失败遮罩 */}
                {media.status === "error" && (
                  <div
                    className="absolute inset-0 bg-red-500/60 flex items-center justify-center text-[10px] text-white text-center px-1"
                    title={media.errorMessage}
                  >
                    {t("diary.uploadFailed")}
                  </div>
                )}
                {/* 删除按钮 */}
                <button
                  onClick={() => removeMedia(media.localKey)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                  aria-label={t("diary.media.remove")}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between px-4 pb-3">
        <div className="flex items-center gap-1">
          {/* 心情按钮 */}
          <div ref={moodRef} className="relative">
            <button
              onClick={() => setShowMoods(!showMoods)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
                mood
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
              )}
            >
              {selectedMoodEmoji ? (
                <span className="text-sm">{selectedMoodEmoji}</span>
              ) : (
                <Smile size={15} />
              )}
              <span className="hidden sm:inline">
                {mood ? t(`diary.mood${mood.charAt(0).toUpperCase() + mood.slice(1)}`) : t("diary.mood")}
              </span>
            </button>

            {/* 心情弹出面板 */}
            <AnimatePresence>
              {showMoods && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-full left-0 mt-2 p-2.5 bg-app-elevated rounded-xl border border-app-border shadow-lg z-50 w-[220px]"
                >
                  <div className="grid grid-cols-6 gap-1.5">
                    {MOODS.map(({ value: v, emoji }) => (
                      <button
                        key={v}
                        onClick={() => {
                          setMood(mood === v ? "" : v);
                          setShowMoods(false);
                        }}
                        className={cn(
                          "w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-base transition-all",
                          mood === v
                            ? "bg-accent-primary/15 scale-110 ring-1 ring-accent-primary/30"
                            : "hover:bg-app-hover hover:scale-110",
                        )}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 图片按钮：达到上限就禁用 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={remainingImageSlots <= 0}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              remainingImageSlots <= 0
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={
              remainingImageSlots <= 0
                ? t("diary.imageLimitReached").replace(
                    "{{n}}",
                    String(MAX_IMAGES_PER_DIARY),
                  )
                : t("diary.addImage")
            }
          >
            <ImagePlus size={15} />
            <span className="hidden sm:inline">{t("diary.media.image")}</span>
            {hasImages && (
              <span className="text-[10px] text-tx-tertiary tabular-nums">
                {pendingMedia.filter((p) => p.type === "image").length}/{MAX_IMAGES_PER_DIARY}
              </span>
            )}
          </button>
          <button
            onClick={() => cameraInputRef.current?.click()}
            disabled={remainingImageSlots <= 0}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              remainingImageSlots <= 0
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={t("diary.media.camera")}
          >
            <Camera size={15} />
            <span className="hidden sm:inline">{t("diary.media.camera")}</span>
          </button>
          <button
            onClick={() => videoInputRef.current?.click()}
            disabled={remainingVideoSlots <= 0}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              remainingVideoSlots <= 0
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={t("diary.media.video")}
          >
            <Video size={15} />
            <span className="hidden sm:inline">{t("diary.media.video")}</span>
          </button>
          <button
            onClick={() => recordInputRef.current?.click()}
            disabled={remainingVideoSlots <= 0}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              remainingVideoSlots <= 0
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={t("diary.media.record")}
          >
            <Video size={15} />
            <span className="hidden sm:inline">{t("diary.media.record")}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={recordInputRef}
            type="file"
            accept="video/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        <div className="flex items-center gap-2">
          {/* 字数计数 */}
          <span
            className={cn(
              "text-[11px] tabular-nums transition-colors",
              text.length > 500 ? "text-red-400" : "text-tx-tertiary",
            )}
          >
            {text.length > 0 && text.length}
          </span>

          {/* 发布按钮 */}
          <button
            onClick={handlePost}
            disabled={!canSubmit}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition-all",
              canSubmit
                ? "bg-accent-primary text-white hover:bg-accent-primary/90 shadow-sm shadow-accent-primary/20 active:scale-95"
                : "bg-app-hover text-tx-tertiary cursor-not-allowed",
            )}
            title={
              hasPendingUploads
                ? t("diary.waitingUpload")
                : hasErrorMedia
                ? t("diary.errorImagesHint")
                : undefined
            }
          >
            {posting ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Send size={13} />
            )}
            <span>{t("diary.post")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// 图片宫格 + Lightbox
// ============================================================
/**
 * 朋友圈风格的图片网格：
 *   1 张  → 单张大图（最大宽度，按比例显示）
 *   2~4 张 → 2 列
 *   5+ 张 → 3 列
 * 点击任意一张打开 Lightbox 大图查看，支持左右切换 / Esc 关闭。
 */
function ImageGrid({
  ids,
  onOpen,
}: {
  ids: string[];
  onOpen: (idx: number) => void;
}) {
  if (!ids.length) return null;
  const count = ids.length;
  const cols = count === 1 ? 1 : count <= 4 ? 2 : 3;
  return (
    <div
      className={cn(
        "mt-3 grid gap-1.5",
        cols === 1 && "grid-cols-1",
        cols === 2 && "grid-cols-2",
        cols === 3 && "grid-cols-3",
      )}
    >
      {ids.map((id, i) => (
        <button
          key={id}
          onClick={() => onOpen(i)}
          className={cn(
            "relative overflow-hidden rounded-lg border border-app-border bg-app-hover/30 hover:opacity-90 transition-opacity",
            // 单图按宽高自然比；多图统一正方形避免参差
            count === 1 ? "max-h-[320px]" : "aspect-square",
          )}
        >
          <img
            src={api.diaryImages.urlFor(id)}
            alt=""
            loading="lazy"
            className={cn(
              "w-full h-full",
              count === 1 ? "object-contain" : "object-cover",
            )}
            draggable={false}
          />
        </button>
      ))}
    </div>
  );
}

function VideoBlock({ id }: { id: string }) {
  const { t } = useTranslation();
  const [hasError, setHasError] = useState(false);
  if (hasError) {
    return (
      <div className="mt-3 flex items-center justify-center h-40 rounded-xl border border-app-border bg-app-hover text-tx-tertiary text-sm">
        {t("diary.media.videoLoadFailed")}
      </div>
    );
  }
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-app-border bg-black">
      <video
        src={mediaUrl(id)}
        className="block w-full max-h-[420px] bg-black object-contain"
        controls
        preload="metadata"
        playsInline
        onError={() => setHasError(true)}
      />
    </div>
  );
}

/**
 * 简版 Lightbox：黑底全屏、左右箭头、Esc 关闭、点击空白关闭。
 * 没有引入第三方库（项目里没看到 lightbox 库），自己 60 行搞定足够。
 */
function Lightbox({
  ids,
  index,
  onClose,
  onIndexChange,
}: {
  ids: string[];
  index: number;
  onClose: () => void;
  onIndexChange: (idx: number) => void;
}) {
  // 键盘控制
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onIndexChange(index - 1);
      else if (e.key === "ArrowRight" && index < ids.length - 1)
        onIndexChange(index + 1);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [index, ids.length, onClose, onIndexChange]);

  // 打开时禁滚（防止背景滚动）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!ids.length) return null;
  const id = ids[index];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
        aria-label="close"
      >
        <X size={20} />
      </button>
      {/* 左 / 右切换 */}
      {index > 0 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onIndexChange(index - 1);
          }}
          className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          aria-label="prev"
        >
          ‹
        </button>
      )}
      {index < ids.length - 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onIndexChange(index + 1);
          }}
          className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
          aria-label="next"
        >
          ›
        </button>
      )}
      {/* 图片本体：阻止冒泡，避免点图也关闭 */}
      <img
        key={id}
        src={api.diaryImages.urlFor(id)}
        alt=""
        onClick={(e) => e.stopPropagation()}
        className="max-w-[92vw] max-h-[88vh] object-contain"
        draggable={false}
      />
      {/* 计数 */}
      {ids.length > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-full bg-white/10 text-white text-xs tabular-nums">
          {index + 1} / {ids.length}
        </div>
      )}
    </motion.div>
  );
}

// ============================================================
// 单条说说卡片
// ============================================================
function DiaryCard({
  item,
  onDelete,
  onUpdate,
}: {
  item: Diary;
  onDelete: (id: string) => void;
  onUpdate: (updated: Diary) => void;
}) {
  const { t } = useTranslation();
  const [showConfirm, setShowConfirm] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const moodEmoji = getMoodEmoji(item.mood);
  const media = diaryMediaFromItem(item);
  const imageIds = media.filter((x) => x.type === "image").map((x) => x.id);
  const videoItem = media.find((x) => x.type === "video");
  // 工作区下展示发布者；个人空间下省略（一定是自己）。
  const showCreator =
    !!item.creatorName && getCurrentWorkspace() !== "personal";

  const handleDelete = () => {
    if (!showConfirm) {
      setShowConfirm(true);
      setTimeout(() => setShowConfirm(false), 3000); // 3 秒后自动取消
      return;
    }
    onDelete(item.id);
  };

  // 编辑模式直接渲染编辑器，整张卡被替换；保存/取消会回到只读视图
  if (isEditing) {
    return (
      <DiaryEditor
        item={item}
        onCancel={() => setIsEditing(false)}
        onSaved={(updated) => {
          onUpdate(updated);
          setIsEditing(false);
        }}
      />
    );
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8, transition: { duration: 0.2 } }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="group"
      >
        <div className="bg-app-surface/40 backdrop-blur-sm rounded-2xl border border-app-border hover:border-app-border/80 transition-all duration-200 hover:shadow-sm">
          <div className="p-4">
            {/* 内容（纯图说说允许 contentText 为空，此时不渲染 <p>） */}
            {item.contentText && (
              <p className="text-sm text-tx-primary leading-relaxed whitespace-pre-wrap break-words">
                {item.contentText}
              </p>
            )}

            {/* 媒体预览：图片九宫格 / 视频播放器 */}
            {imageIds.length > 0 && (
              <ImageGrid ids={imageIds} onOpen={setLightboxIdx} />
            )}
            {videoItem && <VideoBlock id={videoItem.id} />}

            {/* 底部元信息 */}
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-app-border/40">
              <div className="flex items-center gap-2 text-[11px] text-tx-tertiary min-w-0">
                {moodEmoji && <span className="text-sm">{moodEmoji}</span>}
                <span className="shrink-0">{timeAgo(item.createdAt, t)}</span>
                {/* 工作区下追加发布者；与时间用「·」分隔，弱化视觉权重 */}
                {showCreator && (
                  <>
                    <span className="text-tx-tertiary/60 shrink-0">·</span>
                    <span
                      className="flex items-center gap-1 truncate"
                      title={t('common.createdBy', { name: item.creatorName })}
                    >
                      <UserIcon size={11} className="shrink-0" />
                      <span className="truncate">{item.creatorName}</span>
                    </span>
                  </>
                )}
              </div>

              {/* 操作按钮：编辑 + 删除 */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setIsEditing(true)}
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] transition-all",
                    "opacity-100 md:opacity-0 md:group-hover:opacity-100",
                    "text-tx-tertiary hover:text-accent-primary hover:bg-accent-primary/10",
                  )}
                >
                  <Edit2 size={12} />
                  <span>{t("diary.edit")}</span>
                </button>

                {/* 删除按钮 */}
                <button
                  onClick={handleDelete}
                  className={cn(
                    "flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] transition-all",
                    showConfirm
                      ? "bg-red-500/10 text-red-500"
                      : "opacity-100 md:opacity-0 md:group-hover:opacity-100 text-tx-tertiary hover:text-red-400 hover:bg-red-500/5",
                  )}
                >
                  <Trash2 size={12} />
                  <span>{showConfirm ? t("diary.confirmDelete") : t("diary.delete")}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {lightboxIdx !== null && (
          <Lightbox
            ids={imageIds}
            index={lightboxIdx}
            onClose={() => setLightboxIdx(null)}
            onIndexChange={setLightboxIdx}
          />
        )}
      </AnimatePresence>
    </>
  );
}

// ============================================================
// 单条说说编辑器（就地编辑模式）
// ============================================================
/**
 * 设计要点：
 *   - 编辑模式直接替换原卡片，避免在小屏空间塞两套 UI；
 *   - 图片复用 ComposeBox 的"先上传后绑定"模型：
 *       原本已发布的媒体用 PendingMedia 表示（id 取自 server，previewUrl
 *       直接拼远端 URL，status=ready）；新加的走 upload 流程；点 × 仅从
 *       本地队列移除（实际删除在保存时由后端按 images 差集处理）；
 *   - 保存调用 api.updateDiary(id, { contentText, mood, images })，
 *     后端返回更新后的 Diary，由父组件用 onSaved 回写到列表中；
 *   - 内容与图片至少一项非空（与 POST 同口径）。
 */
function DiaryEditor({
  item,
  onCancel,
  onSaved,
}: {
  item: Diary;
  onCancel: () => void;
  onSaved: (updated: Diary) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(item.contentText || "");
  const [mood, setMood] = useState(item.mood || "");
  const [showMoods, setShowMoods] = useState(false);
  const [saving, setSaving] = useState(false);
  // 复用 PendingMedia 结构：原有媒体初始化为 ready 状态（id 已知，预览用远端 URL）
  const [images, setImages] = useState<PendingMedia[]>(() =>
    diaryMediaFromItem(item).map((media) => ({
      localKey: media.id, // 已有 id 直接当 localKey，稳定
      id: media.id,
      type: media.type,
      previewUrl: mediaUrl(media.id),
      status: "ready" as const,
    })),
  );
  const imagesRef = useRef<PendingMedia[]>([]);
  imagesRef.current = images;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const moodRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 自动调整高度
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }
  }, []);
  useEffect(() => {
    autoResize();
  }, [autoResize]);

  // 点击外部关闭心情面板
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moodRef.current && !moodRef.current.contains(e.target as Node)) {
        setShowMoods(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 卸载时回收"新增图"的 blob URL（已有图的 previewUrl 是 http(s)，不需要 revoke）
  useEffect(() => {
    return () => {
      for (const img of imagesRef.current) {
        if (img.previewUrl.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(img.previewUrl);
          } catch {
            /* ignore */
          }
        }
      }
    };
  }, []);

  // 添加新媒体（图片/视频，与 ComposeBox 逻辑对齐）
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const current = imagesRef.current;
      const currentHasImages = current.some((x) => x.type === "image");
      const currentHasVideo = current.some((x) => x.type === "video");

      const accepted: Array<{ file: File; type: "image" | "video" }> = [];
      const rejected: { name: string; reason: string }[] = [];
      for (const f of files) {
        const mime = (f.type || "").toLowerCase();
        let mediaType: "image" | "video" | null = null;
        if (ALLOWED_IMAGE_MIMES.has(mime)) mediaType = "image";
        else if (ALLOWED_VIDEO_MIMES.has(mime)) mediaType = "video";
        if (!mediaType) {
          rejected.push({ name: f.name || "file", reason: "type" });
          continue;
        }
        if (mediaType === "image" && f.size > MAX_DIARY_IMAGE_SIZE) {
          rejected.push({ name: f.name || "image", reason: "image-size" });
          continue;
        }
        if (mediaType === "video" && f.size > MAX_DIARY_VIDEO_SIZE) {
          rejected.push({ name: f.name || "video", reason: "video-size" });
          continue;
        }
        // 混发校验（当前已有的 + 本次已接受的）
        const acceptedHasImages = accepted.some((x) => x.type === "image");
        const acceptedHasVideo = accepted.some((x) => x.type === "video");
        if (mediaType === "video" && (currentHasImages || acceptedHasImages)) {
          rejected.push({ name: f.name || "video", reason: "mix" });
          continue;
        }
        if (mediaType === "image" && (currentHasVideo || acceptedHasVideo)) {
          rejected.push({ name: f.name || "image", reason: "mix" });
          continue;
        }
        // 数量校验
        if (mediaType === "video") {
          const videoCount = current.filter((x) => x.type === "video").length + accepted.filter((x) => x.type === "video").length;
          if (videoCount >= MAX_VIDEOS_PER_DIARY) {
            rejected.push({ name: f.name || "video", reason: "max-videos" });
            continue;
          }
        }
        if (mediaType === "image") {
          const imageCount = current.filter((x) => x.type === "image").length + accepted.filter((x) => x.type === "image").length;
          if (imageCount >= MAX_IMAGES_PER_DIARY) {
            rejected.push({ name: f.name || "image", reason: "max-images" });
            continue;
          }
        }
        accepted.push({ file: f, type: mediaType });
      }
      if (rejected.length) {
        for (const r of rejected) {
          const msg =
            r.reason === "image-size" ? t("diary.media.imageTooLarge").replace("{{name}}", r.name) :
            r.reason === "video-size" ? t("diary.media.videoTooLarge").replace("{{name}}", r.name) :
            r.reason === "mix" ? t("diary.media.noMixImageVideo") :
            r.reason === "max-images" ? t("diary.media.maxImages").replace("{{n}}", String(MAX_IMAGES_PER_DIARY)) :
            r.reason === "max-videos" ? t("diary.media.maxVideos").replace("{{n}}", String(MAX_VIDEOS_PER_DIARY)) :
            t("diary.media.unsupportedType").replace("{{name}}", r.name);
          toast.error(msg);
        }
      }
      if (!accepted.length) return;

      const newItems: PendingMedia[] = accepted.map(({ file: f, type: mediaType }) => ({
        localKey: crypto.randomUUID(),
        id: null,
        type: mediaType,
        previewUrl: URL.createObjectURL(f),
        mimeType: f.type,
        status: "uploading" as const,
      }));
      setImages((prev) => [...prev, ...newItems]);

      newItems.forEach((it, idx) => {
        const file = accepted[idx].file;
        api.diaryImages
          .upload(file)
          .then((res) => {
            setImages((prev) =>
              prev.map((p) =>
                p.localKey === it.localKey
                  ? { ...p, id: res.id, type: res.type, mimeType: res.mimeType, status: "ready" as const }
                  : p,
              ),
            );
          })
          .catch((err) => {
            console.error("Diary media upload failed:", err);
            setImages((prev) =>
              prev.map((p) =>
                p.localKey === it.localKey
                  ? {
                      ...p,
                      status: "error" as const,
                      errorMessage: err?.message || "upload failed",
                    }
                  : p,
              ),
            );
          });
      });
    },
    [t],
  );

  // 移除图片：仅本地移除；真正删除（连同盘上文件）由后端在 save 时根据差集处理
  const removeImage = useCallback((localKey: string) => {
    const target = imagesRef.current.find((p) => p.localKey === localKey);
    if (!target) return;
    setImages((prev) => prev.filter((p) => p.localKey !== localKey));
    if (target.previewUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(target.previewUrl);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    void addFiles(files);
    e.target.value = "";
  };

  const hasPendingUploads = images.some((p) => p.status === "uploading");
  const hasErrorImages = images.some((p) => p.status === "error");
  const readyMedia = images
    .filter((p) => p.status === "ready" && p.id)
    .map((p) => ({ id: p.id!, type: p.type }));
  const readyImageIds = readyMedia.filter((p) => p.type === "image").map((p) => p.id);

  const canSave =
    !saving &&
    !hasPendingUploads &&
    (text.trim().length > 0 || readyMedia.length > 0);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const updated = await api.updateDiary(item.id, {
        contentText: text.trim(),
        mood,
        media: readyMedia,
        images: readyImageIds,
      });
      onSaved(updated);
    } catch (e: any) {
      console.error("Save diary failed:", e);
      toast.error(e?.message || t("diary.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  const selectedMoodEmoji = getMoodEmoji(mood);
  const editorHasVideo = images.some((p) => p.type === "video");
  const remainingSlots = editorHasVideo ? 0 : MAX_IMAGES_PER_DIARY - images.filter((p) => p.type === "image").length;
  const editorHasImages = images.some((p) => p.type === "image");
  const remainingVideoSlots = editorHasImages ? 0 : MAX_VIDEOS_PER_DIARY - images.filter((p) => p.type === "video").length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="bg-app-surface/60 backdrop-blur-sm rounded-2xl border border-accent-primary/40 ring-1 ring-accent-primary/20 shadow-sm"
    >
      <div className="p-4 pb-2">
        <div className="flex items-center gap-1.5 mb-2 text-[11px] text-accent-primary">
          <Edit2 size={11} />
          <span>{t("diary.editing")}</span>
        </div>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          placeholder={t("diary.editPlaceholder")}
          rows={2}
          className="w-full bg-transparent text-tx-primary placeholder:text-tx-tertiary text-sm leading-relaxed resize-none outline-none min-h-[52px]"
          autoFocus
        />

        {/* 媒体预览 */}
        {images.length > 0 && (
          <div className="mt-2 grid grid-cols-4 sm:grid-cols-5 gap-2">
            {images.map((img) => (
              <div
                key={img.localKey}
                className={cn(
                  "relative rounded-lg overflow-hidden border border-app-border bg-app-hover/40 group/img",
                  img.type === "video" ? "col-span-4 sm:col-span-3 aspect-video" : "aspect-square",
                )}
              >
                {img.type === "video" ? (
                  <video
                    src={img.previewUrl}
                    className="w-full h-full object-cover bg-black"
                    controls
                    preload="metadata"
                    playsInline
                  />
                ) : (
                  <img
                    src={img.previewUrl}
                    alt=""
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                )}
                {img.status === "uploading" && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <Loader2 size={18} className="animate-spin text-white" />
                  </div>
                )}
                {img.status === "error" && (
                  <div
                    className="absolute inset-0 bg-red-500/60 flex items-center justify-center text-[10px] text-white text-center px-1"
                    title={img.errorMessage}
                  >
                    {t("diary.uploadFailed")}
                  </div>
                )}
                <button
                  onClick={() => removeImage(img.localKey)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                  aria-label={t("diary.media.remove")}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="flex items-center justify-between px-4 pb-3">
        <div className="flex items-center gap-1">
          {/* 心情按钮 */}
          <div ref={moodRef} className="relative">
            <button
              onClick={() => setShowMoods(!showMoods)}
              className={cn(
                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
                mood
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
              )}
            >
              {selectedMoodEmoji ? (
                <span className="text-sm">{selectedMoodEmoji}</span>
              ) : (
                <Smile size={15} />
              )}
              <span className="hidden sm:inline">
                {mood ? t(`diary.mood${mood.charAt(0).toUpperCase() + mood.slice(1)}`) : t("diary.mood")}
              </span>
            </button>

            <AnimatePresence>
              {showMoods && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: -4 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-full left-0 mt-2 p-2.5 bg-app-elevated rounded-xl border border-app-border shadow-lg z-20 w-[220px]"
                >
                  <div className="grid grid-cols-6 gap-1.5">
                    {MOODS.map(({ value: v, emoji }) => (
                      <button
                        key={v}
                        onClick={() => {
                          setMood(mood === v ? "" : v);
                          setShowMoods(false);
                        }}
                        className={cn(
                          "w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-base transition-all",
                          mood === v
                            ? "bg-accent-primary/15 scale-110 ring-1 ring-accent-primary/30"
                            : "hover:bg-app-hover hover:scale-110",
                        )}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* 图片按钮 */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={remainingSlots <= 0}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              remainingSlots <= 0
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={
              remainingSlots <= 0
                ? t("diary.media.maxImages").replace("{{n}}", String(MAX_IMAGES_PER_DIARY))
                : t("diary.media.image")
            }
          >
            <ImagePlus size={15} />
            <span className="hidden sm:inline">{t("diary.media.image")}</span>
            {images.length > 0 && (
              <span className="text-[10px] text-tx-tertiary tabular-nums">
                {images.filter((p) => p.type === "image").length}/{MAX_IMAGES_PER_DIARY}
              </span>
            )}
          </button>

          {/* 拍照 */}
          <button
            onClick={() => cameraInputRef.current?.click()}
            disabled={remainingSlots <= 0}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              remainingSlots <= 0
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={t("diary.media.camera")}
          >
            <Camera size={15} />
            <span className="hidden sm:inline">{t("diary.media.camera")}</span>
          </button>

          {/* 视频 */}
          <button
            onClick={() => videoInputRef.current?.click()}
            disabled={remainingVideoSlots <= 0}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              remainingVideoSlots <= 0
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={t("diary.media.video")}
          >
            <Video size={15} />
            <span className="hidden sm:inline">{t("diary.media.video")}</span>
          </button>

          {/* 录像 */}
          <button
            onClick={() => recordInputRef.current?.click()}
            disabled={remainingVideoSlots <= 0}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              remainingVideoSlots <= 0
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={t("diary.media.record")}
          >
            <Video size={15} />
            <span className="hidden sm:inline">{t("diary.media.record")}</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={recordInputRef}
            type="file"
            accept="video/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        <div className="flex items-center gap-2">
          {/* 取消 */}
          <button
            onClick={onCancel}
            disabled={saving}
            className="flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium text-tx-secondary bg-app-hover hover:bg-app-hover/80 transition-all disabled:opacity-50"
          >
            <X size={13} />
            <span>{t("diary.cancel")}</span>
          </button>

          {/* 保存 */}
          <button
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              "flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-medium transition-all",
              canSave
                ? "bg-accent-primary text-white hover:bg-accent-primary/90 shadow-sm shadow-accent-primary/20 active:scale-95"
                : "bg-app-hover text-tx-tertiary cursor-not-allowed",
            )}
            title={
              hasPendingUploads
                ? t("diary.waitingUpload")
                : hasErrorImages
                ? t("diary.errorImagesHint")
                : undefined
            }
          >
            {saving ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Check size={13} />
            )}
            <span>{t("diary.save")}</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ============================================================
// 时间筛选
// ============================================================
/**
 * 快捷范围 preset。range = null 表示"全部"（不传 from/to）。
 *   - today / week / month 用本地时间计算 from（本地 00:00:00），不传 to（即到现在）
 *   - custom 由用户在弹层里输入 YYYY-MM-DD（input[type=date]）
 *
 * 后端约定：from/to 直接走字符串比较（createdAt 是 UTC "YYYY-MM-DD HH:MM:SS"）。
 * 这里前端发出的 from 也是不带时区的 "YYYY-MM-DD"，后端会补 00:00:00、23:59:59。
 * 由于 createdAt 是 UTC 而用户输入是本地日期，会有最多 ±1 天的边界偏差；
 * 对"说说时间筛选"这种轻量功能可接受 —— 真要完全准确得在前端把本地日期转成
 * UTC ISO 再传，复杂度上去而收益有限，先按简单方案做。
 */
type RangePreset = "all" | "today" | "week" | "month" | "custom";

interface DateRange {
  from?: string; // YYYY-MM-DD or ISO; undefined 表示不限制下界
  to?: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function ymd(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 把 preset 转成实际 from/to。custom 由调用方自己提供 customRange */
function presetToRange(
  preset: RangePreset,
  customRange?: DateRange,
): DateRange | null {
  const now = new Date();
  switch (preset) {
    case "all":
      return null;
    case "today":
      return { from: ymd(now) };
    case "week": {
      const d = new Date(now);
      d.setDate(d.getDate() - 6); // 含今天共 7 天
      return { from: ymd(d) };
    }
    case "month": {
      const d = new Date(now);
      d.setDate(d.getDate() - 29); // 含今天共 30 天
      return { from: ymd(d) };
    }
    case "custom":
      // 没填或都为空时退化为"全部"，避免空查询条件让用户困惑
      if (!customRange?.from && !customRange?.to) return null;
      return { from: customRange.from, to: customRange.to };
  }
}

/**
 * 紧凑的时间筛选条：4 个快捷 chip + 自定义按钮 + 自定义范围弹层。
 *   - 父组件传入 preset/customRange/onChange，这里只负责呈现与本地交互（弹层开关）
 */
function FilterBar({
  preset,
  customRange,
  onChange,
}: {
  preset: RangePreset;
  customRange: DateRange;
  onChange: (preset: RangePreset, customRange: DateRange) => void;
}) {
  const { t } = useTranslation();
  const [showCustom, setShowCustom] = useState(false);
  const [draftFrom, setDraftFrom] = useState(customRange.from || "");
  const [draftTo, setDraftTo] = useState(customRange.to || "");
  const popoverRef = useRef<HTMLDivElement>(null);

  // 点外部关闭弹层
  useEffect(() => {
    if (!showCustom) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowCustom(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showCustom]);

  // 同步外部 customRange → 草稿（比如父组件被重置时）
  useEffect(() => {
    setDraftFrom(customRange.from || "");
    setDraftTo(customRange.to || "");
  }, [customRange.from, customRange.to]);

  const presets: { key: RangePreset; label: string }[] = [
    { key: "all", label: t("diary.filterAll") },
    { key: "today", label: t("diary.filterToday") },
    { key: "week", label: t("diary.filterWeek") },
    { key: "month", label: t("diary.filterMonth") },
  ];

  const customLabel = useMemo(() => {
    if (preset !== "custom") return t("diary.filterCustom");
    if (customRange.from && customRange.to) return `${customRange.from} ~ ${customRange.to}`;
    if (customRange.from) return `${customRange.from} ~`;
    if (customRange.to) return `~ ${customRange.to}`;
    return t("diary.filterCustom");
  }, [preset, customRange.from, customRange.to, t]);

  const applyCustom = () => {
    // 校验：开始 > 结束时自动对调，避免空结果
    let f = draftFrom || undefined;
    let to = draftTo || undefined;
    if (f && to && f > to) [f, to] = [to, f];
    onChange("custom", { from: f, to });
    setShowCustom(false);
  };
  const clearCustom = () => {
    setDraftFrom("");
    setDraftTo("");
    onChange("all", {});
    setShowCustom(false);
  };

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {presets.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChange(key, customRange)}
          className={cn(
            "px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
            preset === key
              ? "bg-accent-primary text-white shadow-sm shadow-accent-primary/20"
              : "bg-app-hover/60 text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
          )}
        >
          {label}
        </button>
      ))}

      {/* 自定义范围 */}
      <div ref={popoverRef} className="relative">
        <button
          onClick={() => setShowCustom((v) => !v)}
          className={cn(
            "flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
            preset === "custom"
              ? "bg-accent-primary text-white shadow-sm shadow-accent-primary/20"
              : "bg-app-hover/60 text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
          )}
        >
          <Calendar size={11} />
          <span>{customLabel}</span>
        </button>

        <AnimatePresence>
          {showCustom && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -4 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full mt-2 p-3 bg-app-elevated rounded-xl border border-app-border shadow-lg z-30 w-[260px]"
            >
              <div className="space-y-2">
                <div>
                  <label className="block text-[10px] text-tx-tertiary mb-1">
                    {t("diary.filterFrom")}
                  </label>
                  <input
                    type="date"
                    value={draftFrom}
                    max={draftTo || undefined}
                    onChange={(e) => setDraftFrom(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg bg-app-bg border border-app-border text-xs text-tx-primary outline-none focus:border-accent-primary/60"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-tx-tertiary mb-1">
                    {t("diary.filterTo")}
                  </label>
                  <input
                    type="date"
                    value={draftTo}
                    min={draftFrom || undefined}
                    onChange={(e) => setDraftTo(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg bg-app-bg border border-app-border text-xs text-tx-primary outline-none focus:border-accent-primary/60"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between mt-3 gap-2">
                <button
                  onClick={clearCustom}
                  className="px-2.5 py-1 rounded-lg text-[11px] text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-colors"
                >
                  {t("diary.filterClear")}
                </button>
                <button
                  onClick={applyCustom}
                  disabled={!draftFrom && !draftTo}
                  className={cn(
                    "px-3 py-1 rounded-lg text-[11px] font-medium transition-colors",
                    !draftFrom && !draftTo
                      ? "bg-app-hover text-tx-tertiary cursor-not-allowed"
                      : "bg-accent-primary text-white hover:bg-accent-primary/90",
                  )}
                >
                  {t("diary.filterApply")}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ============================================================
// 主组件：DiaryCenter
// ============================================================
export default function DiaryCenter() {
  const { t } = useTranslation();
  const [items, setItems] = useState<Diary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<DiaryStats | null>(null);
  const [mediaFilter, setMediaFilter] = useState<string>("all");
  const [moodFilter, setMoodFilter] = useState<string>("");
  const [showMoodFilter, setShowMoodFilter] = useState(false);
  const moodFilterRef = useRef<HTMLDivElement>(null);
  const [searchText, setSearchText] = useState("");
  const [debouncedSearchText, setDebouncedSearchText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // 时间筛选状态。preset = 当前激活的快捷范围；customRange 仅在 preset === 'custom' 时
  // 真正生效。两者分开存是为了：从 custom 切到其他 preset 再切回来，原来填的日期还在。
  const [preset, setPreset] = useState<RangePreset>("all");
  const [customRange, setCustomRange] = useState<DateRange>({});
  const activeRange = useMemo(
    () => presetToRange(preset, customRange),
    [preset, customRange],
  );

  // 合并日期筛选 + 内容筛选为完整筛选参数
  const activeFilters = useMemo(() => ({
    ...(activeRange || {}),
    mediaType: mediaFilter,
    mood: moodFilter || undefined,
    q: debouncedSearchText.trim() || undefined,
  }), [activeRange, mediaFilter, moodFilter, debouncedSearchText]);

  // 加载时间线。注意：cursor 仍来自 state（翻页），但 range 是当前筛选；
  // 切换筛选时 reset=true 会自动丢弃旧 cursor 重新拉首屏。
  const loadTimeline = useCallback(
    async (reset = false) => {
      if (reset) setLoading(true);
      else setLoadingMore(true);

      try {
        const cursor = reset ? undefined : nextCursor || undefined;
        const data = await api.getDiaryTimeline(
          cursor,
          20,
          activeFilters || undefined,
        );
        if (reset) {
          setItems(data.items);
        } else {
          setItems((prev) => [...prev, ...data.items]);
        }
        setHasMore(data.hasMore);
        setNextCursor(data.nextCursor);
      } catch (e) {
        console.error("Load timeline failed:", e);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [nextCursor, activeFilters],
  );

  // 加载统计：跟着筛选走，让"共 N 条"反映当前范围
  const loadStats = useCallback(async () => {
    try {
      const s = await api.getDiaryStats(activeFilters || undefined);
      setStats(s);
    } catch {
      /* ignore */
    }
  }, [activeFilters]);

  // 心情筛选面板点击外部关闭
  useEffect(() => {
    if (!showMoodFilter) return;
    const handler = (e: MouseEvent) => {
      if (moodFilterRef.current && !moodFilterRef.current.contains(e.target as Node)) {
        setShowMoodFilter(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showMoodFilter]);

  // 搜索防抖
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchText(searchText), 300);
    return () => clearTimeout(timer);
  }, [searchText]);

  // 初始化
  useEffect(() => {
    loadTimeline(true);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 工作区切换：重置游标后重新拉首屏 + 统计，保证跨 scope 切换时数据干净。
  useEffect(() => {
    const onWs = () => {
      setNextCursor(null);
      loadTimeline(true);
      loadStats();
    };
    window.addEventListener("nowen:workspace-changed", onWs);
    return () => window.removeEventListener("nowen:workspace-changed", onWs);
  }, [loadTimeline, loadStats]);

  // 筛选变化 → 重新拉首屏 + 重新算统计。
  // 用 activeRange 的 from/to 字符串做依赖（而非对象引用），避免 useMemo 引用换了
  // 但内容没换时多余触发；JSON.stringify 简单可靠且数据量极小。
  const rangeKey = useMemo(() => JSON.stringify(activeFilters), [activeFilters]);
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      // 初始化的 effect 已经拉过了，避免重复请求
      isFirstRender.current = false;
      return;
    }
    setNextCursor(null);
    loadTimeline(true);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey]);

  // 发布后刷新
  const handlePost = useCallback(() => {
    setNextCursor(null);
    loadTimeline(true);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 删除
  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.deleteDiary(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
      loadStats();
    } catch (e) {
      console.error("Delete failed:", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 编辑保存：用后端返回的最新 Diary 替换列表中对应项；
  // 不重排（保持原 createdAt 顺序），不重拉时间线（避免编辑过程中的视觉跳动）。
  const handleUpdate = useCallback((updated: Diary) => {
    setItems((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, []);

  // 筛选变化的处理：写到 state，effect 会自动触发刷新
  const handleFilterChange = useCallback(
    (next: RangePreset, range: DateRange) => {
      setPreset(next);
      setCustomRange(range);
    },
    [],
  );

  // 当前是否处于"非全部"筛选 —— 用于空状态文案
  const isFiltering = preset !== "all" || mediaFilter !== "all" || !!moodFilter || !!debouncedSearchText.trim();

  // 按日期分组
  const groupedItems = groupByDate(items, t);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-app-bg">
      <ScrollArea className="flex-1" ref={scrollRef}>
        <div className="max-w-[640px] mx-auto px-4 py-6 space-y-6">
          {/* 顶部标题 + 统计 */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-pink-500 flex items-center justify-center">
                <MessageCircle size={18} className="text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-tx-primary leading-tight">{t("diary.title")}</h1>
                {stats && (
                  <p className="text-[11px] text-tx-tertiary mt-0.5">
                    {t("diary.statsLine")
                      .replace("{{total}}", String(stats.total))
                      .replace("{{today}}", String(stats.todayCount))}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* 时间筛选条 */}
          <FilterBar
            preset={preset}
            customRange={customRange}
            onChange={handleFilterChange}
          />

          {/* 内容筛选栏 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* 媒体类型 chip */}
            {(["all", "text", "image", "video"] as const).map((mt) => (
              <button
                key={mt}
                onClick={() => setMediaFilter(mt)}
                className={cn(
                  "px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
                  mediaFilter === mt
                    ? "bg-accent-primary text-white shadow-sm shadow-accent-primary/20"
                    : "bg-app-hover/60 text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
                )}
              >
                {t(`diary.filterMedia${mt.charAt(0).toUpperCase() + mt.slice(1)}`)}
              </button>
            ))}

            {/* 心情筛选 */}
            <div className="relative" ref={moodFilterRef}>
              <button
                onClick={() => setShowMoodFilter(!showMoodFilter)}
                className={cn(
                  "flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-medium transition-all",
                  moodFilter
                    ? "bg-accent-primary/10 text-accent-primary"
                    : "bg-app-hover/60 text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
                )}
              >
                {moodFilter ? (
                  <>
                    <span>{getMoodEmoji(moodFilter)}</span>
                    <X
                      size={11}
                      className="ml-0.5 hover:text-accent-primary"
                      onClick={(e) => { e.stopPropagation(); setMoodFilter(""); setShowMoodFilter(false); }}
                    />
                  </>
                ) : (
                  <>
                    <Smile size={12} />
                    <span>{t("diary.filterMoodAll")}</span>
                  </>
                )}
              </button>
              {showMoodFilter && (
                <div className="absolute top-full left-0 mt-1 p-2 bg-app-elevated rounded-xl border border-app-border shadow-lg z-20 w-[200px]">
                  <div className="grid grid-cols-6 gap-1">
                    <button
                      onClick={() => { setMoodFilter(""); setShowMoodFilter(false); }}
                      className={cn(
                        "col-span-6 mb-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-all",
                        !moodFilter
                          ? "bg-accent-primary/15 text-accent-primary"
                          : "text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary",
                      )}
                    >
                      {t("diary.filterMoodAll")}
                    </button>
                    {MOODS.map(({ value: v, emoji }) => (
                      <button
                        key={v}
                        onClick={() => { setMoodFilter(v); setShowMoodFilter(false); }}
                        className={cn(
                          "w-7 h-7 rounded-lg flex items-center justify-center text-sm transition-all",
                          moodFilter === v
                            ? "bg-accent-primary/15 scale-110 ring-1 ring-accent-primary/30"
                            : "hover:bg-app-hover hover:scale-110",
                        )}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 搜索框 */}
            <div className="relative flex-1 min-w-[120px] max-w-[200px]">
              <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-tx-tertiary" />
              <input
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={t("diary.searchPlaceholder")}
                className="w-full pl-7 pr-7 py-1 rounded-full text-[11px] bg-app-hover/60 text-tx-secondary placeholder:text-tx-tertiary outline-none focus:ring-1 focus:ring-accent-primary/30"
              />
              {searchText && (
                <button
                  onClick={() => setSearchText("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-tx-tertiary hover:text-tx-secondary"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          </div>

          {/* 发布框 */}
          <ComposeBox key={getCurrentWorkspace() || "personal"} onPost={handlePost} />

          {/* 时间线 */}
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 size={24} className="animate-spin text-accent-primary" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center py-20 text-center">
              <div className="w-16 h-16 rounded-2xl bg-app-hover/60 flex items-center justify-center mb-4">
                <MessageCircle size={28} className="text-tx-tertiary" />
              </div>
              <p className="text-sm text-tx-secondary font-medium">
                {isFiltering ? t("diary.emptyFiltered") : t("diary.empty")}
              </p>
              <p className="text-xs text-tx-tertiary mt-1">
                {isFiltering ? t("diary.emptyFilteredHint") : t("diary.emptyHint")}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              {groupedItems.map(({ label, items: dayItems }) => (
                <div key={label}>
                  {/* 日期分割 */}
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-[11px] font-medium text-tx-tertiary bg-app-hover/60 px-2.5 py-1 rounded-full">
                      {label}
                    </span>
                    <div className="flex-1 h-px bg-app-border/50" />
                  </div>

                  {/* 当天动态 */}
                  <div className="space-y-3">
                    <AnimatePresence mode="popLayout">
                      {dayItems.map((item) => (
                        <DiaryCard
                          key={item.id}
                          item={item}
                          onDelete={handleDelete}
                          onUpdate={handleUpdate}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              ))}

              {/* 加载更多 */}
              {hasMore && (
                <div className="flex justify-center pt-2 pb-4">
                  <button
                    onClick={() => loadTimeline(false)}
                    disabled={loadingMore}
                    className="flex items-center gap-1.5 px-5 py-2 rounded-full text-xs font-medium text-tx-secondary bg-app-hover/60 hover:bg-app-hover transition-colors"
                  >
                    {loadingMore ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    <span>{loadingMore ? t("diary.loadingMore") : t("diary.loadMore")}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ============================================================
// 辅助：按日期分组
// ============================================================
function groupByDate(
  items: Diary[],
  t: (key: string) => string
): { label: string; items: Diary[] }[] {
  const groups: Map<string, Diary[]> = new Map();
  const today = new Date();
  const todayStr = formatDateKey(today);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = formatDateKey(yesterday);

  for (const item of items) {
    const date = new Date(item.createdAt.replace(" ", "T") + "Z");
    const key = formatDateKey(date);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  return Array.from(groups.entries()).map(([key, dayItems]) => {
    let label = key;
    if (key === todayStr) label = t("diary.today");
    else if (key === yesterdayStr) label = t("diary.yesterday");
    return { label, items: dayItems };
  });
}

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
