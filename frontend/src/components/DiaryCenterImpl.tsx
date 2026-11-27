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
  MoreHorizontal,
  Video,
  X,
  Calendar,
  User as UserIcon,
  Edit2,
  Check,
  Search,
  Play,
  Paperclip,
  Sparkles,
} from "lucide-react";
import { MOTION_EASE, MOTION_SPRING } from "@/lib/motion";
import { api, getCurrentWorkspace } from "@/lib/api";
import { Diary, DiaryAttachmentItem, DiaryMediaItem, DiaryStats } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import DiaryVideoFeed from "@/components/DiaryVideoFeed";
import SayMarkdownContent from "@/components/diary/SayMarkdownContent";
import {
  loadDiaryDraft,
  saveDiaryDraft,
  clearDiaryDraft,
  isDiaryDraftExpired,
  type DiaryDraftMedia,
} from "@/lib/diaryDraft";
import SayCalendarView from "@/components/diary/SayCalendarView";
import DiarySidebar from "@/components/diary/DiarySidebar";
import DiaryAttachmentList, { type DiaryAttachmentViewItem } from "@/components/diary/DiaryAttachmentList";
import { loadAttachmentUploadPolicy, validateAttachmentSize } from "@/lib/attachmentUploadPolicy";
import { useApp } from "@/store/AppContext";
import {
  formatDateKeyInTimeZone,
  localDateRangeToUtcSqlBounds,
  localDateTimeInputToUtcIso,
  parseServerTime,
  utcSqlToLocalDateTimeInput,
} from "@/lib/dateTime";
import { relativeLocalDateKey } from "@/lib/dailyRecords";

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
  "video/3gpp",
]);

// 相对时间显示
function timeAgo(dateStr: string, t: (key: string) => string): string {
  const now = new Date();
  const date = parseServerTime(dateStr);
  if (!date) return dateStr;
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
  /** 保留原始文件，上传失败后可直接重试，不必重新选择。 */
  file?: File;
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

type DiaryMediaPickerSource = "image-library" | "camera" | "video-library" | "record" | "file";

function normalizePickedMediaFile(file: File): File {
  if (file.type) return file;
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  const mimeType = extension === "png" ? "image/png"
    : extension === "jpg" || extension === "jpeg" ? "image/jpeg"
    : extension === "gif" ? "image/gif"
    : extension === "webp" ? "image/webp"
    : extension === "bmp" ? "image/bmp"
    : extension === "mp4" || extension === "m4v" ? "video/mp4"
    : extension === "webm" ? "video/webm"
    : extension === "mov" ? "video/quicktime"
    : extension === "3gp" || extension === "3gpp" ? "video/3gpp"
    : "";
  return mimeType
    ? new File([file], file.name, { type: mimeType, lastModified: file.lastModified })
    : file;
}

function openDiaryMediaPicker(
  source: DiaryMediaPickerSource,
  onFiles: (files: File[]) => void,
  onUnavailable: () => void,
): void {
  if (typeof document === "undefined") {
    onUnavailable();
    return;
  }
  const input = document.createElement("input");
  const imageSource = source === "image-library" || source === "camera";
  input.type = "file";
  // file：任意文件附件，不限制类型（服务端负责拦截可执行/脚本类）。
  if (source !== "file") input.accept = imageSource ? "image/*" : "video/*";
  input.multiple = source === "image-library" || source === "file";
  if (source === "camera" || source === "record") input.setAttribute("capture", "environment");
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.opacity = "0";
  input.style.pointerEvents = "none";

  const cleanup = () => input.remove();
  input.onchange = () => {
    const files = Array.from(input.files || []).map(normalizePickedMediaFile);
    cleanup();
    if (files.length > 0) onFiles(files);
  };
  input.oncancel = cleanup;
  document.body.appendChild(input);
  try {
    input.click();
  } catch {
    cleanup();
    onUnavailable();
  }
}

function uploadPendingDiaryMedia(
  item: PendingMedia,
  setItems: React.Dispatch<React.SetStateAction<PendingMedia[]>>,
  onError: (error: unknown) => void,
): void {
  if (!item.file) return;
  setItems((previous) => previous.map((candidate) => (
    candidate.localKey === item.localKey
      ? { ...candidate, status: "uploading", errorMessage: undefined }
      : candidate
  )));
  api.diaryImages.upload(item.file)
    .then((result) => {
      setItems((previous) => previous.map((candidate) => (
        candidate.localKey === item.localKey
          ? {
              ...candidate,
              id: result.id,
              // 媒体上传不带 kind=file，服务端只会回 image / video
              type: result.type === "file" ? candidate.type : result.type,
              mimeType: result.mimeType,
              status: "ready" as const,
              errorMessage: undefined,
            }
          : candidate
      )));
    })
    .catch((error) => {
      console.error("Diary media upload failed:", error);
      setItems((previous) => previous.map((candidate) => (
        candidate.localKey === item.localKey
          ? {
              ...candidate,
              status: "error" as const,
              errorMessage: error instanceof Error ? error.message : "upload failed",
            }
          : candidate
      )));
      onError(error);
    });
}

// ---------------------------------------------------------------------------
// 文件附件（Issue #928）：与图片/视频分开排队，不占 9 图 / 1 视频额度。
// 同样"选好即上传、发布时绑定"，发布/保存时随 attachments 字段提交。
// ---------------------------------------------------------------------------
type PendingAttachment = DiaryAttachmentViewItem & { file?: File };

function pendingAttachmentsFrom(items: DiaryAttachmentItem[] | undefined): PendingAttachment[] {
  return (items || []).map((item) => ({ ...item, key: item.id, status: "ready" as const }));
}

function readyDiaryAttachments(items: PendingAttachment[]): DiaryAttachmentItem[] {
  return items
    .filter((item) => (item.status ?? "ready") === "ready" && item.id)
    .map((item) => ({ id: item.id!, filename: item.filename, mimeType: item.mimeType, size: item.size }));
}

function newPendingAttachments(files: File[]): PendingAttachment[] {
  return files.map((file) => ({
    key: crypto.randomUUID(),
    id: null,
    filename: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    file,
    status: "uploading" as const,
  }));
}

/** 按服务端附件上限预检：超限文件直接提示并跳过，不必整份上传后才被拒绝。 */
async function filterAttachmentFilesBySize(files: File[]): Promise<File[]> {
  if (!files.length) return [];
  const policy = await loadAttachmentUploadPolicy();
  return files.filter((file) => {
    const check = validateAttachmentSize(file.size, policy);
    if (!check.ok) toast.error(`${file.name}: ${check.message}`);
    return check.ok;
  });
}

function uploadPendingDiaryAttachment(
  item: PendingAttachment,
  setItems: React.Dispatch<React.SetStateAction<PendingAttachment[]>>,
  unsupportedMessage: string,
  onError: (error: unknown) => void,
): void {
  if (!item.file) return;
  const update = (patch: Partial<PendingAttachment>) => setItems((previous) => previous.map((candidate) => (
    candidate.key === item.key ? { ...candidate, ...patch } : candidate
  )));
  update({ status: "uploading", errorMessage: undefined, retryable: undefined });
  api.diaryImages.upload(item.file, { kind: "file" })
    .then((result) => {
      if (result.type !== "file") {
        // 旧服务器不认识 kind=file：会把图片当媒体收下，发布时又忽略 attachments。
        // 立即撤销这次上传，避免用户以为附件已随说说保存。
        api.diaryImages.remove(result.id).catch(() => {});
        throw Object.assign(new Error(unsupportedMessage), { retryable: false });
      }
      update({
        id: result.id,
        filename: result.filename || item.filename,
        mimeType: result.mimeType || item.mimeType,
        size: result.size,
        status: "ready",
        errorMessage: undefined,
      });
    })
    .catch((error) => {
      console.error("Diary attachment upload failed:", error);
      // 过大（413）或类型被拦截（415）重试也不会成功，只留"移除"
      const failure = error as { status?: unknown; retryable?: unknown };
      const retryable = failure?.retryable !== false && failure?.status !== 413 && failure?.status !== 415;
      update({ status: "error", errorMessage: error instanceof Error ? error.message : String(error), retryable });
      onError(error);
    });
}

/** 把拖入的文件分流：支持的图片/视频进媒体队列，其余作为文件附件。 */
function splitDroppedFiles(files: File[]): { media: File[]; attachments: File[] } {
  const media: File[] = [];
  const attachments: File[] = [];
  for (const file of files) {
    const normalized = normalizePickedMediaFile(file);
    if (mediaTypeForFile(normalized)) media.push(normalized);
    else attachments.push(file);
  }
  return { media, attachments };
}

function MoreMediaMenu({
  cameraDisabled,
  videoDisabled,
  onCamera,
  onVideo,
  onRecord,
}: {
  cameraDisabled: boolean;
  videoDisabled: boolean;
  onCamera: () => void;
  onVideo: () => void;
  onRecord: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const allDisabled = cameraDisabled && videoDisabled;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const items = [
    { id: "camera", label: t("diary.media.camera"), icon: <Camera size={14} />, disabled: cameraDisabled, action: onCamera },
    { id: "video", label: t("diary.media.video"), icon: <Play size={14} />, disabled: videoDisabled, action: onVideo },
    { id: "record", label: t("diary.media.record"), icon: <Video size={14} />, disabled: videoDisabled, action: onRecord },
  ];

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        disabled={allDisabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-all active:scale-95",
          allDisabled
            ? "cursor-not-allowed text-tx-tertiary/50"
            : open
            ? "bg-violet-500/12 text-violet-600 dark:text-violet-300"
            : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
        )}
        title={t("diary.media.more", { defaultValue: "更多" })}
      >
        <MoreHorizontal size={15} className="shrink-0" />
        <span className="hidden sm:inline">{t("diary.media.more", { defaultValue: "更多" })}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 4 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full left-0 z-50 mb-2 w-40 origin-bottom-left rounded-2xl border border-app-border/80 bg-app-elevated/95 p-1.5 shadow-xl backdrop-blur-xl"
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.action();
                }}
                className={cn(
                  "flex w-full items-center gap-2 whitespace-nowrap rounded-xl px-2.5 py-2 text-xs font-medium transition-colors",
                  item.disabled
                    ? "cursor-not-allowed text-tx-tertiary/50"
                    : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
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
  // 自定义发布日期（用于补录历史说说）
  const [customDate, setCustomDate] = useState("");
  const [showDatePicker, setShowDatePicker] = useState(false);
  // 拖拽视觉反馈（dragOver 时高亮整个卡片）
  const [isDragging, setIsDragging] = useState(false);
  // 待发布媒体队列。用 ref 留一份镜像，因为粘贴 / 拖拽回调里要拿到最新值再
  // setState，避免函数式更新里反复读旧 state 计数错误。
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const pendingMediaRef = useRef<PendingMedia[]>([]);
  pendingMediaRef.current = pendingMedia;
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  pendingAttachmentsRef.current = pendingAttachments;

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
    if (draft.attachments?.length) setPendingAttachments(pendingAttachmentsFrom(draft.attachments));
    if (draft.text || draft.mood || draft.media.length > 0 || draft.attachments?.length) {
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
      const draftAttachments = readyDiaryAttachments(pendingAttachments);
      if (!text.trim() && !mood && readyMedia.length === 0 && draftAttachments.length === 0) {
        clearDiaryDraft();
      } else {
        saveDiaryDraft({
          version: 1,
          workspaceId: getCurrentWorkspace() || "personal",
          text: text.trim(),
          mood,
          media: readyMedia,
          attachments: draftAttachments,
          updatedAt: Date.now(),
        });
      }
    }, 300);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mood, pendingMedia, pendingAttachments]);

  // 清空草稿并释放已上传未发布媒体
  const clearDraftAndMedia = useCallback(() => {
    const readyIds = pendingMediaRef.current
      .filter((p) => p.status === "ready" && p.id)
      .map((p) => p.id!);
    for (const id of readyIds) {
      api.diaryImages.remove(id).catch(() => {});
    }
    for (const attachment of readyDiaryAttachments(pendingAttachmentsRef.current)) {
      api.diaryImages.remove(attachment.id).catch(() => {});
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
    setPendingAttachments([]);
    setDraftRestored(false);
  }, []);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const moodRef = useRef<HTMLDivElement>(null);
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
        file,
        status: "uploading",
      }));
      setPendingMedia((prev) => [...prev, ...newItems]);

      // 并发上传；每个媒体独立处理结果（部分失败不影响其他项）
      newItems.forEach((item) => uploadPendingDiaryMedia(
        item,
        setPendingMedia,
        (error) => toast.error(error instanceof Error ? error.message : t("diary.media.uploadFailed")),
      ));
    },
    [t],
  );

  const retryMedia = useCallback((localKey: string) => {
    const item = pendingMediaRef.current.find((candidate) => candidate.localKey === localKey);
    if (!item?.file || item.status !== "error") return;
    uploadPendingDiaryMedia(
      item,
      setPendingMedia,
      (error) => toast.error(error instanceof Error ? error.message : t("diary.media.uploadFailed")),
    );
  }, [t]);

  const chooseMedia = useCallback((source: DiaryMediaPickerSource) => {
    openDiaryMediaPicker(
      source,
      (files) => { void addFiles(files); },
      () => toast.error(t("diary.media.pickerFailed", { defaultValue: "无法打开系统媒体选择器" })),
    );
  }, [addFiles, t]);

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

  const addAttachmentFiles = useCallback(async (files: File[]) => {
    const accepted = await filterAttachmentFilesBySize(files);
    if (!accepted.length) return;
    const newItems = newPendingAttachments(accepted);
    setPendingAttachments((prev) => [...prev, ...newItems]);
    newItems.forEach((item) => uploadPendingDiaryAttachment(
      item,
      setPendingAttachments,
      t("diary.attachment.serverUnsupported"),
      (error) => toast.error(error instanceof Error ? error.message : t("diary.attachment.uploadFailed")),
    ));
  }, [t]);

  const retryAttachment = useCallback((target: DiaryAttachmentViewItem) => {
    const item = pendingAttachmentsRef.current.find((candidate) => candidate.key === target.key);
    if (!item?.file || item.status !== "error") return;
    uploadPendingDiaryAttachment(
      item,
      setPendingAttachments,
      t("diary.attachment.serverUnsupported"),
      (error) => toast.error(error instanceof Error ? error.message : t("diary.attachment.uploadFailed")),
    );
  }, [t]);

  // 移除待发布附件：已上传成功的同时删除服务端悬空文件（与图片一致）
  const removeAttachment = useCallback((target: DiaryAttachmentViewItem) => {
    setPendingAttachments((prev) => prev.filter((item) => item.key !== target.key));
    if (target.id && (target.status ?? "ready") === "ready") {
      api.diaryImages.remove(target.id).catch(() => {
        /* ignore：最坏情况是个孤儿，24h 后被清理 */
      });
    }
  }, []);

  const chooseAttachments = useCallback(() => {
    openDiaryMediaPicker(
      "file",
      (files) => { void addAttachmentFiles(files); },
      () => toast.error(t("diary.attachment.pickerFailed")),
    );
  }, [addAttachmentFiles, t]);

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
    // 支持的图片/视频照旧进媒体队列；PDF、Office、压缩包等其余文件作为附件
    const { media, attachments } = splitDroppedFiles(Array.from(e.dataTransfer.files || []));
    if (media.length) void addFiles(media);
    if (attachments.length) void addAttachmentFiles(attachments);
  };

  const hasPendingUploads = pendingMedia.some((p) => p.status === "uploading");
  const hasErrorMedia = pendingMedia.some((p) => p.status === "error");
  const readyMedia = pendingMedia
    .filter((p) => p.status === "ready" && p.id)
    .map((p) => ({ id: p.id!, type: p.type }));
  const readyImageIds = readyMedia.filter((p) => p.type === "image").map((p) => p.id);
  const hasPendingAttachmentUploads = pendingAttachments.some((p) => p.status === "uploading");
  const hasErrorAttachments = pendingAttachments.some((p) => p.status === "error");
  const readyAttachments = readyDiaryAttachments(pendingAttachments);

  // 提交条件：内容/媒体/附件至少一项，且没有上传中或上传失败的项
  const canSubmit =
    !posting &&
    !hasPendingUploads &&
    !hasErrorMedia &&
    !hasPendingAttachmentUploads &&
    !hasErrorAttachments &&
    (text.trim().length > 0 || readyMedia.length > 0 || readyAttachments.length > 0);

  const handlePost = async () => {
    if (!canSubmit) return;
    setPosting(true);
    try {
      await api.postDiary({
        contentText: text.trim(),
        mood,
        media: readyMedia,
        images: readyImageIds,
        attachments: readyAttachments,
        createdAt: customDate
          ? localDateTimeInputToUtcIso(customDate) || undefined
          : undefined,
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
      setCustomDate("");
      setShowDatePicker(false);
      setPendingMedia([]);
      setPendingAttachments([]);
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
      data-nowen-media-owner="diary"
      className={cn(
        "relative z-0 rounded-3xl border bg-gradient-to-br from-violet-500/[0.05] via-app-elevated/92 to-pink-500/[0.05] shadow-sm backdrop-blur-md transition-all focus-within:border-violet-400/50 focus-within:shadow-md focus-within:ring-2 focus-within:ring-violet-500/15",
        isDragging
          ? "border-violet-400/70 ring-2 ring-violet-400/35"
          : "border-violet-500/20 hover:border-violet-400/35",
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
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-violet-500/20 bg-violet-500/8 px-3 py-1.5 text-[11px] text-violet-600 dark:text-violet-300">
            <span>{t("diary.draftRestored")}</span>
            <button
              onClick={() => clearDraftAndMedia()}
              className="ml-auto rounded-lg px-2 py-0.5 text-[10px] hover:bg-violet-500/12"
            >
              {t("diary.draftClear")}
            </button>
            <button
              onClick={() => setDraftRestored(false)}
              className="rounded-lg px-2 py-0.5 text-[10px] hover:bg-violet-500/12"
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
                  <button
                    type="button"
                    onClick={() => retryMedia(media.localKey)}
                    className="absolute inset-0 bg-red-500/60 flex flex-col items-center justify-center gap-0.5 text-[10px] text-white text-center px-1"
                    title={media.errorMessage}
                  >
                    <span>{t("diary.uploadFailed")}</span>
                    <span className="font-medium underline underline-offset-2">{t("diary.media.retry")}</span>
                  </button>
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

        {/* 待发布文件附件 */}
        <DiaryAttachmentList
          items={pendingAttachments}
          onRemove={removeAttachment}
          onRetry={retryAttachment}
        />
      </div>

      {/* 底部操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border/50 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1">
          {/* 心情按钮 */}
          <div ref={moodRef} className="relative">
            <button
              onClick={() => setShowMoods(!showMoods)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-all active:scale-95",
                mood
                  ? "bg-amber-500/14 text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
              )}
            >
              {selectedMoodEmoji ? (
                <span className="text-sm">{selectedMoodEmoji}</span>
              ) : (
                <Smile size={15} className="shrink-0 text-amber-500 dark:text-amber-400" />
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
                  className="absolute left-0 top-full z-50 mt-2 w-[232px] rounded-2xl border border-app-border/80 bg-app-elevated/95 p-2.5 shadow-2xl backdrop-blur-xl"
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
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base transition-all",
                          mood === v
                            ? "scale-110 bg-violet-500/18 ring-1 ring-violet-400/50"
                            : "hover:scale-125 hover:bg-app-hover",
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

          {/* 日期选择按钮 */}
          <div className="relative">
            <button
              onClick={() => setShowDatePicker(!showDatePicker)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-all active:scale-95",
                customDate
                  ? "bg-sky-500/14 text-sky-700 ring-1 ring-sky-500/25 dark:text-sky-300"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
              )}
              title={t("diary.customDate", { defaultValue: "自定义发布日期" })}
            >
              <Calendar size={15} className="shrink-0 text-sky-500 dark:text-sky-400" />
              <span className="hidden sm:inline">
                {customDate || t("diary.date", { defaultValue: "日期" })}
              </span>
            </button>
            {showDatePicker && (
              <div className="absolute left-0 top-full z-50 mt-2 rounded-2xl border border-app-border/80 bg-app-elevated/95 p-3 shadow-2xl backdrop-blur-xl">
                <div className="mb-2 text-[11px] text-tx-tertiary">
                  {t("diary.customDateHint", { defaultValue: "补录历史说说，留空则使用当前时间" })}
                </div>
                <input
                  type="datetime-local"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="w-full rounded-xl border border-app-border bg-app-bg px-2.5 py-1.5 text-xs text-tx-primary outline-none focus:border-accent-primary/60"
                />
                <div className="mt-2 flex items-center justify-between">
                  <button
                    onClick={() => { setCustomDate(""); setShowDatePicker(false); }}
                    className="rounded-lg px-2 py-1 text-[11px] text-tx-tertiary hover:bg-app-hover hover:text-tx-secondary"
                  >
                    {t("diary.clearDate", { defaultValue: "清除" })}
                  </button>
                  <button
                    onClick={() => setShowDatePicker(false)}
                    className="rounded-lg bg-violet-500/12 px-2.5 py-1 text-[11px] font-medium text-violet-600 dark:text-violet-300"
                  >
                    {t("diary.confirmDate", { defaultValue: "确定" })}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 图片按钮：达到上限就禁用 */}
          <button
            type="button"
            onClick={() => chooseMedia("image-library")}
            disabled={remainingImageSlots <= 0}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-all active:scale-95",
              remainingImageSlots <= 0
                ? "cursor-not-allowed text-tx-tertiary/50"
                : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
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
            <ImagePlus size={15} className="shrink-0 text-emerald-500 dark:text-emerald-400" />
            <span className="hidden sm:inline">{t("diary.media.image")}</span>
            {hasImages && (
              <span className="text-[10px] tabular-nums text-tx-tertiary">
                {pendingMedia.filter((p) => p.type === "image").length}/{MAX_IMAGES_PER_DIARY}
              </span>
            )}
          </button>
          {/* 文件附件：不占图片/视频额度 */}
          <button
            type="button"
            onClick={chooseAttachments}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium text-tx-secondary transition-all hover:bg-app-hover hover:text-tx-primary active:scale-95"
            title={t("diary.attachment.addTitle")}
            aria-label={t("diary.attachment.addTitle")}
          >
            <Paperclip size={15} className="shrink-0 text-violet-500 dark:text-violet-400" />
            <span className="hidden sm:inline">{t("diary.attachment.add")}</span>
            {pendingAttachments.length > 0 && (
              <span className="text-[10px] tabular-nums text-tx-tertiary">{pendingAttachments.length}</span>
            )}
          </button>
          <MoreMediaMenu
            cameraDisabled={remainingImageSlots <= 0}
            videoDisabled={remainingVideoSlots <= 0}
            onCamera={() => chooseMedia("camera")}
            onVideo={() => chooseMedia("video-library")}
            onRecord={() => chooseMedia("record")}
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 字数计数 */}
          <span
            className={cn(
              "text-[11px] tabular-nums transition-colors",
              text.length > 500 ? "text-rose-500 font-medium" : "text-tx-tertiary",
            )}
          >
            {text.length > 0 && text.length}
          </span>

          {/* 发布按钮 */}
          <button
            onClick={handlePost}
            disabled={!canSubmit}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-semibold transition-all",
              canSubmit
                ? "bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 text-white shadow-sm shadow-violet-500/25 hover:brightness-105 active:scale-95"
                : "cursor-not-allowed bg-app-hover text-tx-tertiary",
            )}
            title={
              hasPendingUploads
                ? t("diary.waitingUpload")
                : hasErrorMedia
                ? t("diary.errorImagesHint")
                : hasPendingAttachmentUploads
                ? t("diary.attachment.waitingUpload")
                : hasErrorAttachments
                ? t("diary.attachment.errorHint")
                : undefined
            }
          >
            {posting ? (
              <Loader2 size={13} className="shrink-0 animate-spin" />
            ) : (
              <Send size={13} className="shrink-0" />
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
const DiaryCard = React.forwardRef<HTMLDivElement, {
  item: Diary;
  onDelete: (id: string) => void;
  onUpdate: (updated: Diary) => void;
}>(({
  item,
  onDelete,
  onUpdate,
}, ref) => {
  const { t } = useTranslation();
  const [showConfirm, setShowConfirm] = useState(false);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const moodEmoji = getMoodEmoji(item.mood);
  const media = diaryMediaFromItem(item);
  const imageIds = media.filter((x) => x.type === "image").map((x) => x.id);
  const videoItem = media.find((x) => x.type === "video");
  const attachments = item.attachments || [];
  const [deletingAttachment, setDeletingAttachment] = useState(false);
  // 只剩一个附件且没有文字/媒体时不提供单独删除：删掉会变成空说说，应删除整条。
  const canDeleteAttachment =
    !deletingAttachment && (!!item.contentText?.trim() || media.length > 0 || attachments.length > 1);
  // 工作区下展示发布者；个人空间下省略（一定是自己）。
  const showCreator =
    !!item.creatorName && getCurrentWorkspace() !== "personal";

  const handleDeleteAttachment = async (target: DiaryAttachmentViewItem) => {
    if (deletingAttachment) return;
    if (!window.confirm(t("diary.attachment.confirmDelete", { name: target.filename }))) return;
    setDeletingAttachment(true);
    try {
      const updated = await api.updateDiary(item.id, {
        attachments: attachments.filter((attachment) => attachment.id !== target.id),
      });
      onUpdate(updated);
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("diary.attachment.deleteFailed"));
    } finally {
      setDeletingAttachment(false);
    }
  };

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
        <div className="rounded-2xl border border-app-border/75 bg-app-elevated/90 shadow-xs backdrop-blur-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-violet-400/35 hover:bg-app-surface hover:shadow-md">
          <div className="p-5">
            {/* 内容（纯图说说允许 contentText 为空，此时不渲染） */}
            {item.contentText && (
              <SayMarkdownContent content={item.contentText} />
            )}

            {/* 媒体预览：图片九宫格 / 视频播放器 */}
            {imageIds.length > 0 && (
              <ImageGrid ids={imageIds} onOpen={setLightboxIdx} />
            )}
            {videoItem && <VideoBlock id={videoItem.id} />}

            {/* 文件附件：预览 / 打开 / 下载 / 删除 */}
            <DiaryAttachmentList
              items={attachments.map((attachment) => ({ ...attachment, key: attachment.id }))}
              onRemove={canDeleteAttachment ? (target) => { void handleDeleteAttachment(target); } : undefined}
              removeMode="delete"
            />

            {/* 底部元信息 */}
            <div className="mt-3.5 flex items-center justify-between border-t border-app-border/50 pt-2.5">
              <div className="flex min-w-0 items-center gap-2 text-[11px] text-tx-tertiary">
                {moodEmoji && (
                  <span className="inline-flex items-center rounded-full bg-violet-500/10 px-2 py-0.5 text-sm">
                    {moodEmoji}
                  </span>
                )}
                <span className="shrink-0">{timeAgo(item.createdAt, t)}</span>
                {/* 工作区下追加发布者；与时间用「·」分隔，弱化视觉权重 */}
                {showCreator && (
                  <>
                    <span className="shrink-0 text-tx-tertiary/60">·</span>
                    <span
                      className="flex items-center gap-1 truncate"
                      title={t("common.createdBy", { name: item.creatorName })}
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
                    "flex items-center gap-1 whitespace-nowrap rounded-xl px-2.5 py-1 text-[11px] font-medium transition-all",
                    "opacity-100 md:opacity-0 md:group-hover:opacity-100",
                    "text-tx-tertiary hover:bg-violet-500/10 hover:text-violet-600 dark:hover:text-violet-300",
                  )}
                >
                  <Edit2 size={12} />
                  <span>{t("diary.edit")}</span>
                </button>

                {/* 删除按钮 */}
                <button
                  onClick={handleDelete}
                  className={cn(
                    "flex items-center gap-1 whitespace-nowrap rounded-xl px-2.5 py-1 text-[11px] font-medium transition-all",
                    showConfirm
                      ? "bg-rose-500/12 text-rose-500"
                      : "opacity-100 text-tx-tertiary hover:bg-rose-500/8 hover:text-rose-500 md:opacity-0 md:group-hover:opacity-100",
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
});

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
  // 编辑发布日期
  const [createdAt, setCreatedAt] = useState(() =>
    utcSqlToLocalDateTimeInput(item.createdAt),
  );
  const [showDatePicker, setShowDatePicker] = useState(false);
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
  // 文件附件与媒体分开编辑；已发布的附件初始化为 ready（移除在保存时由后端按差集删除）
  const [attachments, setAttachments] = useState<PendingAttachment[]>(() => pendingAttachmentsFrom(item.attachments));
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const moodRef = useRef<HTMLDivElement>(null);

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
        file: f,
        status: "uploading" as const,
      }));
      setImages((prev) => [...prev, ...newItems]);

      newItems.forEach((pending) => uploadPendingDiaryMedia(
        pending,
        setImages,
        (error) => toast.error(error instanceof Error ? error.message : t("diary.media.uploadFailed")),
      ));
    },
    [t],
  );

  const retryMedia = useCallback((localKey: string) => {
    const pending = imagesRef.current.find((candidate) => candidate.localKey === localKey);
    if (!pending?.file || pending.status !== "error") return;
    uploadPendingDiaryMedia(
      pending,
      setImages,
      (error) => toast.error(error instanceof Error ? error.message : t("diary.media.uploadFailed")),
    );
  }, [t]);

  const chooseMedia = useCallback((source: DiaryMediaPickerSource) => {
    openDiaryMediaPicker(
      source,
      (files) => { void addFiles(files); },
      () => toast.error(t("diary.media.pickerFailed", { defaultValue: "无法打开系统媒体选择器" })),
    );
  }, [addFiles, t]);

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

  const addAttachmentFiles = useCallback(async (files: File[]) => {
    const accepted = await filterAttachmentFilesBySize(files);
    if (!accepted.length) return;
    const newItems = newPendingAttachments(accepted);
    setAttachments((prev) => [...prev, ...newItems]);
    newItems.forEach((pending) => uploadPendingDiaryAttachment(
      pending,
      setAttachments,
      t("diary.attachment.serverUnsupported"),
      (error) => toast.error(error instanceof Error ? error.message : t("diary.attachment.uploadFailed")),
    ));
  }, [t]);

  const retryAttachment = useCallback((target: DiaryAttachmentViewItem) => {
    const pending = attachmentsRef.current.find((candidate) => candidate.key === target.key);
    if (!pending?.file || pending.status !== "error") return;
    uploadPendingDiaryAttachment(
      pending,
      setAttachments,
      t("diary.attachment.serverUnsupported"),
      (error) => toast.error(error instanceof Error ? error.message : t("diary.attachment.uploadFailed")),
    );
  }, [t]);

  // 仅本地移除；已发布附件的真正删除（连同磁盘文件）由后端在保存时按差集处理
  const removeAttachment = useCallback((target: DiaryAttachmentViewItem) => {
    setAttachments((prev) => prev.filter((pending) => pending.key !== target.key));
  }, []);

  const chooseAttachments = useCallback(() => {
    openDiaryMediaPicker(
      "file",
      (files) => { void addAttachmentFiles(files); },
      () => toast.error(t("diary.attachment.pickerFailed")),
    );
  }, [addAttachmentFiles, t]);

  // 编辑时也支持把文件拖进来：图片/视频进媒体，其余作为附件
  const handleDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  };
  const handleDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    const { media, attachments: droppedAttachments } = splitDroppedFiles(Array.from(e.dataTransfer.files || []));
    if (media.length) void addFiles(media);
    if (droppedAttachments.length) void addAttachmentFiles(droppedAttachments);
  };

  const hasPendingUploads = images.some((p) => p.status === "uploading");
  const hasErrorImages = images.some((p) => p.status === "error");
  const readyMedia = images
    .filter((p) => p.status === "ready" && p.id)
    .map((p) => ({ id: p.id!, type: p.type }));
  const readyImageIds = readyMedia.filter((p) => p.type === "image").map((p) => p.id);
  const hasPendingAttachmentUploads = attachments.some((p) => p.status === "uploading");
  const hasErrorAttachments = attachments.some((p) => p.status === "error");
  const readyAttachments = readyDiaryAttachments(attachments);
  // 附件列表没变时不提交 attachments：避免用旧列表覆盖其他设备刚添加的附件。
  const attachmentsChanged =
    readyAttachments.map((attachment) => attachment.id).join("\n")
    !== (item.attachments || []).map((attachment) => attachment.id).join("\n");

  const canSave =
    !saving &&
    !hasPendingUploads &&
    !hasErrorImages &&
    !hasPendingAttachmentUploads &&
    !hasErrorAttachments &&
    (text.trim().length > 0 || readyMedia.length > 0 || readyAttachments.length > 0);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const updated = await api.updateDiary(item.id, {
        contentText: text.trim(),
        mood,
        media: readyMedia,
        images: readyImageIds,
        ...(attachmentsChanged ? { attachments: readyAttachments } : {}),
        createdAt: createdAt
          ? localDateTimeInputToUtcIso(createdAt) || undefined
          : undefined,
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
      data-nowen-media-owner="diary"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="bg-app-surface/60 backdrop-blur-sm rounded-2xl border border-accent-primary/40 ring-1 ring-accent-primary/20 shadow-sm"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
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
                  <button
                    type="button"
                    onClick={() => retryMedia(img.localKey)}
                    className="absolute inset-0 bg-red-500/60 flex flex-col items-center justify-center gap-0.5 text-[10px] text-white text-center px-1"
                    title={img.errorMessage}
                  >
                    <span>{t("diary.uploadFailed")}</span>
                    <span className="font-medium underline underline-offset-2">{t("diary.media.retry")}</span>
                  </button>
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

        {/* 文件附件 */}
        <DiaryAttachmentList
          items={attachments}
          onRemove={removeAttachment}
          onRetry={retryAttachment}
        />
      </div>

      {/* 底部操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-app-border/50 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1">
          {/* 心情按钮 */}
          <div ref={moodRef} className="relative">
            <button
              onClick={() => setShowMoods(!showMoods)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-all active:scale-95",
                mood
                  ? "bg-amber-500/14 text-amber-700 dark:text-amber-300"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
              )}
            >
              {selectedMoodEmoji ? (
                <span className="text-sm">{selectedMoodEmoji}</span>
              ) : (
                <Smile size={15} className="shrink-0 text-amber-500 dark:text-amber-400" />
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
                  className="absolute left-0 top-full z-20 mt-2 w-[232px] rounded-2xl border border-app-border/80 bg-app-elevated/95 p-2.5 shadow-2xl backdrop-blur-xl"
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
                          "flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base transition-all",
                          mood === v
                            ? "scale-110 bg-violet-500/18 ring-1 ring-violet-400/50"
                            : "hover:scale-125 hover:bg-app-hover",
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

          {/* 日期选择按钮 */}
          <div className="relative">
            <button
              onClick={() => setShowDatePicker(!showDatePicker)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-all active:scale-95",
                createdAt
                  ? "bg-sky-500/14 text-sky-700 dark:text-sky-300"
                  : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
              )}
              title={t("diary.customDate", { defaultValue: "修改发布日期" })}
            >
              <Calendar size={15} className="shrink-0 text-sky-500 dark:text-sky-400" />
              <span className="hidden sm:inline">
                {createdAt ? createdAt.replace("T", " ") : t("diary.date", { defaultValue: "日期" })}
              </span>
            </button>
            {showDatePicker && (
              <div className="absolute left-0 top-full z-50 mt-2 w-[240px] max-w-[calc(100vw-32px)] rounded-2xl border border-app-border/80 bg-app-elevated/95 p-3 shadow-2xl backdrop-blur-xl">
                <div className="mb-2 text-[11px] text-tx-tertiary">
                  {t("diary.editDateHint", { defaultValue: "修改说说的显示时间" })}
                </div>
                <input
                  type="datetime-local"
                  value={createdAt}
                  onChange={(e) => setCreatedAt(e.target.value)}
                  className="w-full rounded-xl border border-app-border bg-app-bg px-2.5 py-1.5 text-xs text-tx-primary outline-none focus:border-accent-primary/60"
                />
                <div className="mt-2 flex items-center justify-end">
                  <button
                    onClick={() => setShowDatePicker(false)}
                    className="rounded-lg bg-violet-500/12 px-2.5 py-1 text-[11px] font-medium text-violet-600 dark:text-violet-300"
                  >
                    {t("diary.confirmDate", { defaultValue: "确定" })}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 图片按钮 */}
          <button
            type="button"
            onClick={() => chooseMedia("image-library")}
            disabled={remainingSlots <= 0}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium transition-all active:scale-95",
              remainingSlots <= 0
                ? "cursor-not-allowed text-tx-tertiary/50"
                : "text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
            )}
            title={
              remainingSlots <= 0
                ? t("diary.media.maxImages").replace("{{n}}", String(MAX_IMAGES_PER_DIARY))
                : t("diary.media.image")
            }
          >
            <ImagePlus size={15} className="shrink-0 text-emerald-500 dark:text-emerald-400" />
            <span className="hidden sm:inline">{t("diary.media.image")}</span>
            {images.length > 0 && (
              <span className="text-[10px] tabular-nums text-tx-tertiary">
                {images.filter((p) => p.type === "image").length}/{MAX_IMAGES_PER_DIARY}
              </span>
            )}
          </button>

          {/* 文件附件 */}
          <button
            type="button"
            onClick={chooseAttachments}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs font-medium text-tx-secondary transition-all hover:bg-app-hover hover:text-tx-primary active:scale-95"
            title={t("diary.attachment.addTitle")}
            aria-label={t("diary.attachment.addTitle")}
          >
            <Paperclip size={15} className="shrink-0 text-violet-500 dark:text-violet-400" />
            <span className="hidden sm:inline">{t("diary.attachment.add")}</span>
            {attachments.length > 0 && (
              <span className="text-[10px] tabular-nums text-tx-tertiary">{attachments.length}</span>
            )}
          </button>

          <MoreMediaMenu
            cameraDisabled={remainingSlots <= 0}
            videoDisabled={remainingVideoSlots <= 0}
            onCamera={() => chooseMedia("camera")}
            onVideo={() => chooseMedia("video-library")}
            onRecord={() => chooseMedia("record")}
          />
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* 取消 */}
          <button
            onClick={onCancel}
            disabled={saving}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-app-hover px-3 py-1.5 text-xs font-medium text-tx-secondary transition-all hover:bg-app-hover/80 disabled:opacity-50"
          >
            <X size={13} className="shrink-0" />
            <span>{t("diary.cancel")}</span>
          </button>

          {/* 保存 */}
          <button
            onClick={handleSave}
            disabled={!canSave}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-4 py-1.5 text-xs font-semibold transition-all",
              canSave
                ? "bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 text-white shadow-sm shadow-violet-500/25 hover:brightness-105 active:scale-95"
                : "cursor-not-allowed bg-app-hover text-tx-tertiary",
            )}
            title={
              hasPendingUploads
                ? t("diary.waitingUpload")
                : hasErrorImages
                ? t("diary.errorImagesHint")
                : hasPendingAttachmentUploads
                ? t("diary.attachment.waitingUpload")
                : hasErrorAttachments
                ? t("diary.attachment.errorHint")
                : undefined
            }
          >
            {saving ? (
              <Loader2 size={13} className="shrink-0 animate-spin" />
            ) : (
              <Check size={13} className="shrink-0" />
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
 * UI 保存的是用户本地日期；请求前转换成 UTC SQL 边界，确保上海等非 UTC
 * 时区的“今天/近 7 天/自定义日期”不会跨日偏移。
 */
type RangePreset = "all" | "today" | "week" | "month" | "custom";

interface DateRange {
  from?: string; // YYYY-MM-DD or ISO; undefined 表示不限制下界
  to?: string;
}

/** 把 preset 转成实际 from/to。custom 由调用方自己提供 customRange */
function presetToRange(
  preset: RangePreset,
  customRange?: DateRange,
): DateRange | null {
  switch (preset) {
    case "all":
      return null;
    case "today":
      return localDateRangeToUtcSqlBounds({ from: formatDateKeyInTimeZone(new Date()) });
    case "week":
      // 含今天共 7 天
      return localDateRangeToUtcSqlBounds({ from: relativeLocalDateKey(-6) });
    case "month":
      // 含今天共 30 天
      return localDateRangeToUtcSqlBounds({ from: relativeLocalDateKey(-29) });
    case "custom":
      // 没填或都为空时退化为"全部"，避免空查询条件让用户困惑
      if (!customRange?.from && !customRange?.to) return null;
      return localDateRangeToUtcSqlBounds(customRange);
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

  // 点外部关闭弹层 + Esc 关闭
  useEffect(() => {
    if (!showCustom) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowCustom(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowCustom(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
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
    <div className="flex flex-wrap items-center gap-1.5">
      {presets.map(({ key, label }) => {
        const active = preset === key;
        return (
          <button
            key={key}
            onClick={() => onChange(key, customRange)}
            className={cn(
              "relative whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-medium transition-colors",
              active
                ? "text-white"
                : "bg-app-hover/65 text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
            )}
          >
            {active && (
              <motion.span
                layoutId="diary-range-pill"
                transition={MOTION_SPRING.snappy}
                className="absolute inset-0 rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 shadow-xs shadow-violet-500/25"
              />
            )}
            <span className="relative z-10">{label}</span>
          </button>
        );
      })}

      {/* 自定义范围 */}
      <div ref={popoverRef} className="relative">
        <button
          onClick={() => setShowCustom((v) => !v)}
          className={cn(
            "flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-medium transition-all",
            preset === "custom"
              ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-xs shadow-violet-500/25"
              : "bg-app-hover/65 text-tx-secondary hover:bg-app-hover hover:text-tx-primary",
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
              className="absolute right-0 top-full z-50 mt-2 w-[260px] rounded-2xl border border-app-border/80 bg-app-elevated/95 p-3 shadow-2xl backdrop-blur-xl"
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
  const { state } = useApp();
  const [items, setItems] = useState<Diary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<DiaryStats | null>(null);
  // 视频沉浸流状态
  const [videoFeedOpen, setVideoFeedOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [videoFeedItems, setVideoFeedItems] = useState<Diary[]>([]);
  const [videoFeedIndex, setVideoFeedIndex] = useState(0);
  const [videoFeedLoading, setVideoFeedLoading] = useState(false);
  const [videoFeedLoadingMore, setVideoFeedLoadingMore] = useState(false);
  const [videoFeedHasMore, setVideoFeedHasMore] = useState(false);
  const [videoFeedNextCursor, setVideoFeedNextCursor] = useState<string | null>(null);
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

  // 去重工具
  function dedupeDiaries(items: Diary[]): Diary[] {
    const seen = new Set<string>();
    return items.filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  // 打开视频流
  const openVideoFeed = useCallback(async () => {
    setVideoFeedOpen(true);
    setVideoFeedLoading(true);
    setVideoFeedIndex(0);
    try {
      const data = await api.getDiaryTimeline(undefined, 20, {
        mediaType: "video",
        ...(activeRange || {}),
      });
      setVideoFeedItems(data.items);
      setVideoFeedHasMore(data.hasMore);
      setVideoFeedNextCursor(data.nextCursor);
    } catch (e) {
      console.error("Load video feed failed:", e);
    } finally {
      setVideoFeedLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRange]);

  // 视频流加载更多
  const loadMoreVideoFeed = useCallback(async () => {
    if (!videoFeedHasMore || videoFeedLoadingMore || !videoFeedNextCursor) return;
    setVideoFeedLoadingMore(true);
    try {
      const data = await api.getDiaryTimeline(videoFeedNextCursor, 20, {
        mediaType: "video",
        ...(activeRange || {}),
      });
      setVideoFeedItems((prev) => dedupeDiaries([...prev, ...data.items]));
      setVideoFeedHasMore(data.hasMore);
      setVideoFeedNextCursor(data.nextCursor);
    } catch (e) {
      console.error("Load more video feed failed:", e);
    } finally {
      setVideoFeedLoadingMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoFeedHasMore, videoFeedLoadingMore, videoFeedNextCursor, activeRange]);

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
    <div className="flex min-h-0 flex-1 flex-col h-full overflow-hidden bg-app-bg">
      {/* 全屏日历视图（移动端或点击日历卡片时） */}
      {calendarOpen ? (
        <SayCalendarView
          onClose={() => setCalendarOpen(false)}
          onWriteEntry={() => setCalendarOpen(false)}
          onLocateItem={(id: string) => {
            const found = items.find((x) => x.id === id);
            if (found) {
              setItems((prev) => {
                if (prev.some((x) => x.id === id)) return prev;
                return [found, ...prev];
              });
            }
            setCalendarOpen(false);
          }}
        />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 flex-1 justify-center overflow-hidden">
          {/* 左侧：主内容区 */}
          <ScrollArea className="h-full min-h-0 flex-1 max-w-[760px]" ref={scrollRef}>
            <div className="px-4 lg:px-6 py-5 space-y-5">
              {/* 顶部标题 + 统计 */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <motion.div
                    whileHover={{ rotate: [0, -10, 10, 0], scale: 1.08 }}
                    whileTap={{ scale: 0.92 }}
                    transition={{ duration: 0.4 }}
                    className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 via-fuchsia-500 to-pink-500 shadow-md shadow-violet-500/25"
                  >
                    <MessageCircle size={20} className="text-white" />
                    <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-300 text-amber-800 shadow-xs">
                      <Sparkles size={8} />
                    </span>
                  </motion.div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="text-xl font-bold tracking-tight text-tx-primary leading-tight">{t("diary.title")}</h1>
                      {stats && (
                        <span className="inline-flex items-center rounded-full border border-violet-500/20 bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-violet-700 dark:border-violet-400/25 dark:bg-violet-400/15 dark:text-violet-300">
                          {t("diary.statsLine")
                            .replace("{{total}}", String(stats.total))
                            .replace("{{today}}", String(stats.todayCount))}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                {/* 移动端日历入口 */}
                <button
                  onClick={() => setCalendarOpen(true)}
                  className="lg:hidden flex items-center gap-1.5 rounded-full border border-violet-400/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-600 transition-all hover:bg-violet-500/18 dark:text-violet-300"
                >
                  <Calendar size={14} />
                  <span>{t("diary.calendarTitle") || "日历"}</span>
                </button>
              </div>

              {/* 发布框 */}
              <div className={cn("relative", state.mobileSidebarOpen && "hidden md:block")}>
                <div className="pointer-events-none absolute -inset-1 rounded-3xl bg-gradient-to-r from-violet-500/10 via-fuchsia-500/8 to-pink-500/10 blur-lg opacity-70" />
                <div className="relative">
                  <ComposeBox key={getCurrentWorkspace() || "personal"} onPost={handlePost} />
                </div>
              </div>

              {/* 筛选区 - 磨砂控制台 */}
              <div className="space-y-2.5 rounded-2xl border border-app-border/75 bg-app-elevated/70 p-2.5 shadow-xs backdrop-blur-sm">
                {/* 时间筛选 */}
                <div className="flex flex-wrap items-center gap-2">
                  <FilterBar
                    preset={preset}
                    customRange={customRange}
                    onChange={handleFilterChange}
                  />
                </div>

                {/* 内容筛选 + 搜索 */}
                <div className="flex flex-wrap items-center gap-2 border-t border-app-border/50 pt-2.5">
                  {/* 媒体类型 */}
                  <div className="flex items-center gap-1 rounded-full bg-app-bg/70 p-0.5 ring-1 ring-app-border/60">
                    {(["all", "text", "image", "video"] as const).map((mt) => {
                      const active = mediaFilter === mt;
                      return (
                        <button
                          key={mt}
                          onClick={() => setMediaFilter(mt)}
                          className={cn(
                            "relative whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors",
                            active
                              ? "text-white"
                              : "text-tx-secondary hover:text-tx-primary",
                          )}
                        >
                          {active && (
                            <motion.span
                              layoutId="diary-media-pill"
                              transition={MOTION_SPRING.snappy}
                              className="absolute inset-0 rounded-full bg-gradient-to-r from-sky-500 to-indigo-500 shadow-xs"
                            />
                          )}
                          <span className="relative z-10">{t(`diary.filterMedia${mt.charAt(0).toUpperCase() + mt.slice(1)}`)}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* 视频流入口 */}
                  <button
                    onClick={openVideoFeed}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-pink-400/30 bg-pink-500/10 px-2.5 py-1 text-[11px] font-medium text-pink-600 transition-all hover:bg-pink-500/18 active:scale-95 dark:text-pink-300"
                    title={t("diary.videoFeed")}
                  >
                    <Play size={11} />
                    <span className="hidden sm:inline">{t("diary.enterVideoFeed")}</span>
                  </button>

                  {/* 搜索框 */}
                  <div className="relative ml-auto min-w-[140px] flex-1 max-w-[220px]">
                    <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tx-tertiary" />
                    <input
                      type="text"
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                      placeholder={t("diary.searchPlaceholder")}
                      className="w-full rounded-full border border-app-border/75 bg-app-surface/90 py-1 pl-7 pr-7 text-[11px] text-tx-primary placeholder:text-tx-tertiary outline-none transition-all focus:border-violet-400/60 focus:ring-2 focus:ring-violet-500/15"
                    />
                    {searchText && (
                      <button
                        onClick={() => setSearchText("")}
                        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full text-tx-tertiary hover:text-tx-primary"
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 时间线 */}
              {loading ? (
                <div className="space-y-3 py-2">
                  {[0, 1, 2].map((index) => (
                    <div key={index} className="animate-pulse rounded-2xl border border-app-border/70 bg-app-elevated/75 p-5 space-y-3">
                      <div className="h-3.5 w-3/4 rounded-md bg-app-hover/90" />
                      <div className="h-3.5 w-1/2 rounded-md bg-app-hover/70" />
                      <div className="flex items-center gap-2 pt-2">
                        <div className="h-4 w-16 rounded-full bg-app-hover/70" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : items.length === 0 ? (
                <PlayfulMomentEmptyState isFiltering={isFiltering} t={t} />
              ) : (
                <div className="space-y-6">
                  {groupedItems.map(({ label, items: dayItems }) => (
                    <div key={label}>
                      {/* 日期分割 - 时间线样式 */}
                      <div className="sticky top-0 z-10 -mx-4 mb-4 flex items-center gap-2.5 bg-app-bg/85 px-4 py-2 backdrop-blur-md lg:-mx-6 lg:px-6">
                        <div className="h-2.5 w-2.5 rounded-full bg-gradient-to-tr from-violet-500 to-pink-500 shadow-xs" />
                        <span className="text-xs font-bold text-tx-primary">
                          {label}
                        </span>
                        <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium tabular-nums text-violet-600 dark:text-violet-300">
                          {dayItems.length} {t("diary.itemsCount", { defaultValue: "条" })}
                        </span>
                        <div className="h-px flex-1 bg-gradient-to-r from-violet-400/25 via-app-border/50 to-transparent" />
                      </div>

                      {/* 当天动态 */}
                      <div className="ml-1 space-y-3 border-l-2 border-violet-400/25 pl-4 lg:pl-5">
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
                        className="flex items-center gap-1.5 rounded-full border border-app-border/80 bg-app-elevated/85 px-5 py-2 text-xs font-medium text-tx-secondary shadow-xs transition-all hover:border-violet-400/40 hover:bg-app-surface hover:text-tx-primary active:scale-95"
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

          {/* 右侧面板（桌面端） */}
          <div className="hidden lg:block w-[300px] xl:w-[320px] shrink-0 border-l border-app-border/75 bg-app-surface/40 overflow-auto">
            <div className="p-4 sticky top-0">
              <DiarySidebar
                stats={stats}
                moodFilter={moodFilter}
                onMoodFilterChange={setMoodFilter}
                onOpenCalendar={() => setCalendarOpen(true)}
                recentItems={items}
              />
            </div>
          </div>
          </div>
        </div>
      )}

      {/* 沉浸式视频流 Overlay */}
      <DiaryVideoFeed
        open={videoFeedOpen}
        items={videoFeedItems}
        index={videoFeedIndex}
        hasMore={videoFeedHasMore}
        loadingMore={videoFeedLoadingMore}
        loading={videoFeedLoading}
        onClose={() => setVideoFeedOpen(false)}
        onIndexChange={setVideoFeedIndex}
        onLoadMore={loadMoreVideoFeed}
      />
    </div>
  );
}

const MOMENT_BOOP_LINES = [
  "把此刻冒出来的小念头装进气泡里吧 🫧",
  "支持直接粘贴截图、拖入视频和 Markdown 哦 ✨",
  "给今天挑个心情小贴纸，写下第一条瞬间吧 😊",
];

/** 俏皮拟人化「气泡心情精灵」空状态：悬停微晃，点击开心弹跳。 */
function PlayfulMomentEmptyState({
  isFiltering,
  t,
}: {
  isFiltering: boolean;
  t: (key: string) => string;
}) {
  const [boops, setBoops] = useState(0);
  const [boopIndex, setBoopIndex] = useState<number | null>(null);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: MOTION_EASE.enter }}
      className="flex flex-col items-center rounded-3xl border border-dashed border-app-border/80 bg-app-elevated/60 px-6 py-14 text-center backdrop-blur-sm"
    >
      <motion.button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={() => {
          setBoops((count) => count + 1);
          setBoopIndex((prev) => (prev === null ? 0 : (prev + 1) % MOMENT_BOOP_LINES.length));
        }}
        className="group relative mx-auto mb-4 flex h-32 w-32 cursor-pointer items-center justify-center rounded-full focus:outline-none"
        whileHover={{ scale: 1.07 }}
        whileTap={{ scale: 0.93 }}
        animate={boops > 0 ? { y: [0, -12, 0], rotate: [0, -7, 7, 0] } : { y: [0, -4, 0] }}
        transition={boops > 0
          ? { duration: 0.45, ease: MOTION_EASE.enter }
          : { duration: 3.4, repeat: Infinity, ease: "easeInOut" }}
      >
        <span className="pointer-events-none absolute inset-1.5 rounded-full bg-gradient-to-tr from-violet-400/24 via-fuchsia-400/20 to-pink-400/24 blur-xl" />

        <motion.span
          className="pointer-events-none absolute right-2 top-3 text-amber-400 dark:text-amber-300"
          animate={{ y: [0, -5, 0], rotate: [0, 16, 0], opacity: [0.65, 1, 0.65] }}
          transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
        >
          <Sparkles size={16} />
        </motion.span>
        <motion.span
          className="pointer-events-none absolute left-2 top-7 h-2.5 w-2.5 rounded-full bg-violet-400/60"
          animate={{ scale: [1, 1.35, 1], opacity: [0.5, 0.95, 0.5] }}
          transition={{ duration: 2.3, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.span
          className="pointer-events-none absolute bottom-4 right-3 h-2 w-2 rounded-full bg-pink-400/60"
          animate={{ y: [0, 4, 0], opacity: [0.45, 0.9, 0.45] }}
          transition={{ duration: 2.8, repeat: Infinity, ease: "easeInOut", delay: 0.35 }}
        />

        <svg viewBox="0 0 112 112" className="relative h-24 w-24 drop-shadow-sm" fill="none">
          {/* 胖嘟嘟聊天气泡 */}
          <path
            d="M22 52C22 34.3 37.2 22 56 22C74.8 22 90 34.3 90 52C90 69.7 74.8 82 56 82C51.2 82 46.6 81.2 42.5 79.7L27 87L31.4 72.8C25.5 67.4 22 60.1 22 52Z"
            className="fill-app-elevated stroke-violet-500/65 dark:stroke-violet-300/65"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          {/* 气泡内柔光微晕 */}
          <ellipse cx="56" cy="48" rx="22" ry="15" className="fill-fuchsia-500/8 dark:fill-fuchsia-400/12" />
          {/* 笑眯眯小脸 */}
          <circle cx="46" cy="50" r="2.8" className="fill-tx-primary/75" />
          <circle cx="66" cy="50" r="2.8" className="fill-tx-primary/75" />
          <path
            d="M50.5 56.5C53 59.8 59 59.8 61.5 56.5"
            className="stroke-tx-primary/75"
            strokeWidth="2.3"
            strokeLinecap="round"
          />
          <circle cx="40" cy="54.5" r="3.2" className="fill-pink-400/45" />
          <circle cx="72" cy="54.5" r="3.2" className="fill-pink-400/45" />
        </svg>
      </motion.button>

      <p className="text-sm font-semibold text-tx-primary">
        {isFiltering ? t("diary.emptyFiltered") : t("diary.empty")}
      </p>
      <p className="mt-1.5 max-w-xs text-xs leading-5 text-tx-secondary">
        {boopIndex !== null
          ? MOMENT_BOOP_LINES[boopIndex]
          : isFiltering
            ? t("diary.emptyFilteredHint")
            : t("diary.emptyHint")}
      </p>
    </motion.div>
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
    const date = parseServerTime(item.createdAt);
    if (!date) continue;
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
