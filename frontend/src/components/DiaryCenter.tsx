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
  X,
  Calendar,
  CalendarDays,
  User as UserIcon,
  Edit2,
  Check,
  Mic,
  Play,
  Pause,
  Volume2,
  Globe,
  Lock,
  Copy,
  VolumeX,
  Sparkles,
  Search,
} from "lucide-react";
import { api, getCurrentWorkspace } from "@/lib/api";
import { Diary, DiaryStats, Tag } from "@/types";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { useApp } from "@/store/AppContext";
import GenericTagInput from "@/components/GenericTagInput";
import DiaryCalendar from "@/components/DiaryCalendar";
import MentionPicker, { parseMentionTrigger, replaceMentionText } from "@/components/MentionPicker";

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * 检测文本是否包含 Markdown 语法
 */
function hasMarkdownSyntax(text: string): boolean {
  return /(\*\*.*\*\*|#{1,6}\s|^\s*[-*+]\s|^\s*\d+\.\s|!\[.*\]\(|\[.*\]\(|`{1,3}|^>\s)/m.test(text);
}

/**
 * 渲染说说内容：自动检测 Markdown 语法，有则渲染为 MD，无则显示纯文本。
 * 说说定位是"朋友圈风格"短内容，纯文本展示比强制 MD 渲染更自然。
 */
export function renderDiaryContent(text: string): string {
  if (!text) return "";
  if (hasMarkdownSyntax(text)) {
    const rawHtml = marked.parse(text) as string;
    return DOMPurify.sanitize(rawHtml, {
      ADD_TAGS: ["iframe"],
      ADD_ATTR: ["allow", "allowfullscreen", "frameborder", "scrolling", "sandbox", "src", "width", "height", "style"],
    });
  }
  // 纯文本：转义 HTML 后直接显示，保留换行
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\n/g, "<br>");
}

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
// 单张图大小上限，与后端 MAX_DIARY_IMAGE_SIZE 保持一致 → 不一致会出现"前端选过、后端拒"的尴尬
const MAX_DIARY_IMAGE_SIZE = 10 * 1024 * 1024;
// 与后端 ALLOWED_DIARY_IMAGE_MIMES 对齐（不收 svg 防 XSS）
const ALLOWED_IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
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
interface PendingImage {
  /** 本地随机 key，用于 React 列表渲染 + 删除定位 */
  localKey: string;
  /** 上传成功后的服务端 id；上传中 / 失败为 null */
  id: string | null;
  /** 本地预览（blob:），上传成功后保留此预览（无需重新拉远端图） */
  previewUrl: string;
  status: "uploading" | "ready" | "error";
  errorMessage?: string;
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
  // 待发布图片队列。用 ref 留一份镜像，因为粘贴 / 拖拽回调里要拿到最新值再
  // setState，避免函数式更新里反复读旧 state 计数错误。
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const pendingImagesRef = useRef<PendingImage[]>([]);
  pendingImagesRef.current = pendingImages;

  // 新增：可见性选择（工作区默认公开，个人空间默认私密）
  const [visibility, setVisibility] = useState<string>(() => {
    const ws = getCurrentWorkspace();
    return (ws && ws !== "personal") ? "PUBLIC" : "PRIVATE";
  });
  const [pendingVoice, setPendingVoice] = useState<{ id: string; duration: number } | null>(null);
  const [voiceUploading, setVoiceUploading] = useState(false);
  const [composeTags, setComposeTags] = useState<Tag[]>([]);

  // @提及选择器状态
  const [cursorPos, setCursorPos] = useState(0);
  const mentionRaw = parseMentionTrigger(text, cursorPos);
  const mentionTrigger = mentionRaw ? { ...mentionRaw, clear: () => {} } : null;

  // 录音相关状态与 Ref
  const [recording, setRecording] = useState(false);
  const [recordingPaused, setRecordingPaused] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<any>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const moodRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
      for (const item of pendingImagesRef.current) {
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
      const current = pendingImagesRef.current;
      const remaining = MAX_IMAGES_PER_DIARY - current.length;
      if (remaining <= 0) return;

      const accepted: File[] = [];
      const rejected: { name: string; reason: string }[] = [];
      for (const f of files) {
        if (accepted.length >= remaining) break;
        const mime = (f.type || "").toLowerCase();
        if (!ALLOWED_IMAGE_MIMES.has(mime)) {
          rejected.push({ name: f.name || "image", reason: "type" });
          continue;
        }
        if (f.size > MAX_DIARY_IMAGE_SIZE) {
          rejected.push({ name: f.name || "image", reason: "size" });
          continue;
        }
        accepted.push(f);
      }
      if (rejected.length) {
        // 多条拒绝原因逐条 toast：保持视觉一致，避免原生 alert 的尴尬抬头
        const lines = rejected.map((r) =>
          r.reason === "size"
            ? t("diary.imageTooLarge").replace("{{name}}", r.name)
            : t("diary.imageTypeUnsupported").replace("{{name}}", r.name),
        );
        for (const line of lines) toast.error(line);
      }
      if (!accepted.length) return;

      // 先把"上传中"占位丢进 state，UI 立刻有反馈；逐个并发上传更新各自状态。
      const newItems: PendingImage[] = accepted.map((f) => ({
        localKey: crypto.randomUUID(),
        id: null,
        previewUrl: URL.createObjectURL(f),
        status: "uploading",
      }));
      setPendingImages((prev) => [...prev, ...newItems]);

      // 并发上传；每张图独立处理结果（部分失败不影响其他图）
      newItems.forEach((item, idx) => {
        const file = accepted[idx];
        api.diaryImages
          .upload(file)
          .then((res) => {
            setPendingImages((prev) =>
              prev.map((p) =>
                p.localKey === item.localKey
                  ? { ...p, id: res.id, status: "ready" as const }
                  : p,
              ),
            );
          })
          .catch((err) => {
            console.error("Diary image upload failed:", err);
            setPendingImages((prev) =>
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

  // 移除一张图：未上传成功的直接丢；已上传成功的同时调后端 DELETE 释放服务端文件
  const removeImage = useCallback((localKey: string) => {
    const target = pendingImagesRef.current.find((p) => p.localKey === localKey);
    if (!target) return;
    setPendingImages((prev) => prev.filter((p) => p.localKey !== localKey));
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
      f.type.startsWith("image/"),
    );
    if (files.length) void addFiles(files);
  };

  // 录音逻辑
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      let duration = 0;
      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        const file = new File([audioBlob], `voice_${Date.now()}.webm`, { type: "audio/webm" });
        try {
          setVoiceUploading(true);
          const uploadRes = await api.diaryImages.upload(file);
          setPendingVoice({
            id: uploadRes.id,
            duration: duration || 1,
          });
        } catch (e) {
          console.error("Voice upload failed:", e);
          toast.error("语音上传失败");
        } finally {
          setVoiceUploading(false);
        }
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorder.start(200);
      setRecording(true);
      setRecordingPaused(false);
      setRecordDuration(0);

      recordTimerRef.current = setInterval(() => {
        duration += 1;
        setRecordDuration(duration);
      }, 1000);
    } catch (err) {
      console.error("Failed to start recording:", err);
      toast.error("无法启动录音设备");
    }
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.pause();
      setRecordingPaused(true);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    }
  };

  const resumeRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "paused") {
      mediaRecorderRef.current.resume();
      setRecordingPaused(false);
      const currentDur = recordDuration;
      let duration = currentDur;
      recordTimerRef.current = setInterval(() => {
        duration += 1;
        setRecordDuration(duration);
      }, 1000);
    }
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.onstop = () => {
        if (mediaRecorderRef.current) {
          const stream = mediaRecorderRef.current.stream;
          stream.getTracks().forEach((track) => track.stop());
        }
      };
      mediaRecorderRef.current.stop();
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      setRecording(false);
      setRecordingPaused(false);
      setRecordDuration(0);
      audioChunksRef.current = [];
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      setRecording(false);
      setRecordingPaused(false);
    }
  };

  const hasPendingUploads = pendingImages.some((p) => p.status === "uploading");
  const hasErrorImages = pendingImages.some((p) => p.status === "error");
  const readyImageIds = pendingImages
    .filter((p) => p.status === "ready" && p.id)
    .map((p) => p.id!) as string[];

  // 提交条件：内容、图片、语音至少一项，且没有上传中
  const canSubmit =
    !posting &&
    !hasPendingUploads &&
    !voiceUploading &&
    (text.trim().length > 0 || readyImageIds.length > 0 || pendingVoice !== null);

  const handlePost = async () => {
    if (!canSubmit) return;
    setPosting(true);
    try {
      await api.postDiary({
        contentText: text.trim(),
        mood,
        images: readyImageIds,
        visibility,
        voice: pendingVoice,
        tagIds: composeTags.map((t) => t.id),
      });
      // 重置：先 revoke 所有 blob URL（已发布图片由后端持久化，前端不再需要 blob）
      for (const item of pendingImagesRef.current) {
        try {
          URL.revokeObjectURL(item.previewUrl);
        } catch {
          /* ignore */
        }
      }
      setText("");
      setMood("");
      setShowMoods(false);
      setPendingImages([]);
      setVisibility("PRIVATE");
      setPendingVoice(null);
      setComposeTags([]);
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
  const remainingSlots = MAX_IMAGES_PER_DIARY - pendingImages.length;

  return (
    <div
      className={cn(
        "bg-app-surface/60 backdrop-blur-sm rounded-2xl border border-app-border shadow-sm transition-all",
        isDragging && "ring-2 ring-accent-primary/50 border-accent-primary/40",
      )}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* 输入区域 */}
      <div className="p-4 pb-2">
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCursorPos(e.target.selectionStart);
              autoResize();
            }}
            onSelect={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
            onClick={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
            onKeyUp={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart)}
            onKeyDown={(e) => {
              if (mentionTrigger) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape") {
                  e.preventDefault();
                }
              }
              handleKeyDown(e);
            }}
            onPaste={handlePaste}
            placeholder={t("diary.placeholder")}
            rows={2}
            className="w-full bg-transparent text-tx-primary placeholder:text-tx-tertiary text-sm leading-relaxed resize-none outline-none min-h-[52px]"
          />
        </div>

        {/* @提及选择器 */}
        {mentionTrigger && (
          <div className="relative z-50">
            <MentionPicker
              search={mentionTrigger.search}
              onSelect={(user) => {
                const newText = replaceMentionText(text, cursorPos, mentionTrigger.startIndex, user.username);
                setText(newText);
                setCursorPos(mentionTrigger.startIndex + user.username.length + 2);
                mentionTrigger.clear();
                textareaRef.current?.focus();
              }}
              onClose={mentionTrigger.clear}
            />
          </div>
        )}

        {/* 待发布图片缩略图区 */}
        {pendingImages.length > 0 && (
          <div className="mt-2 grid grid-cols-4 sm:grid-cols-5 gap-2">
            {pendingImages.map((img) => (
              <div
                key={img.localKey}
                className="relative aspect-square rounded-lg overflow-hidden border border-app-border bg-app-hover/40 group/img"
              >
                <img
                  src={img.previewUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  draggable={false}
                />
                {/* 上传中遮罩 */}
                {img.status === "uploading" && (
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                    <Loader2 size={18} className="animate-spin text-white" />
                  </div>
                )}
                {/* 上传失败遮罩 */}
                {img.status === "error" && (
                  <div
                    className="absolute inset-0 bg-red-500/60 flex items-center justify-center text-[10px] text-white text-center px-1"
                    title={img.errorMessage}
                  >
                    {t("diary.uploadFailed")}
                  </div>
                )}
                {/* 删除按钮 */}
                <button
                  onClick={() => removeImage(img.localKey)}
                  className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity"
                  aria-label={t("diary.removeImage")}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* 语音上传中 */}
        {voiceUploading && (
          <div className="mt-2.5 p-3 rounded-xl bg-app-hover/40 border border-app-border flex items-center gap-2">
            <Loader2 size={16} className="animate-spin text-accent-primary" />
            <span className="text-xs text-tx-tertiary">语音上传中...</span>
          </div>
        )}

        {/* 已录制语音预览 */}
        {pendingVoice && (
          <div className="mt-2.5 p-3 rounded-xl bg-accent-primary/5 border border-accent-primary/10 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-accent-primary/10 flex items-center justify-center text-accent-primary">
                <Mic size={16} />
              </div>
              <div>
                <span className="text-xs font-semibold text-tx-primary">已录制语音</span>
                <span className="text-[10px] text-tx-tertiary block mt-0.5 tabular-nums">
                  {Math.floor(pendingVoice.duration / 60)}分{pendingVoice.duration % 60}秒
                </span>
              </div>
            </div>
            
            <button
              onClick={() => setPendingVoice(null)}
              className="w-6 h-6 rounded-full bg-black/5 hover:bg-black/10 text-tx-secondary flex items-center justify-center transition-all"
              aria-label="删除录音"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* 录音控制面板 */}
        {recording && (
          <div className="mt-2.5 p-3 rounded-xl bg-accent-primary/5 border border-accent-primary/10 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className={cn(
                "w-2.5 h-2.5 rounded-full bg-red-500",
                !recordingPaused && "animate-pulse"
              )} />
              <span className="text-xs font-semibold text-tx-secondary tabular-nums">
                {Math.floor(recordDuration / 60).toString().padStart(2, "0")}:
                {(recordDuration % 60).toString().padStart(2, "0")}
              </span>
              <span className="text-[11px] text-tx-tertiary">
                {recordingPaused ? "录音已暂停" : "正在录音..."}
              </span>
            </div>
            
            <div className="flex items-center gap-2">
              {recordingPaused ? (
                <button
                  onClick={resumeRecording}
                  className="px-2.5 py-1 rounded-lg text-[11px] bg-accent-primary/10 text-accent-primary hover:bg-accent-primary/20 transition-all"
                >
                  继续
                </button>
              ) : (
                <button
                  onClick={pauseRecording}
                  className="px-2.5 py-1 rounded-lg text-[11px] bg-zinc-500/10 text-zinc-500 hover:bg-zinc-500/20 transition-all"
                >
                  暂停
                </button>
              )}
              <button
                onClick={cancelRecording}
                className="px-2.5 py-1 rounded-lg text-[11px] bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-all"
              >
                取消
              </button>
              <button
                onClick={stopRecording}
                className="px-3 py-1 rounded-lg text-[11px] font-medium bg-accent-primary text-white hover:bg-accent-primary/95 transition-all shadow-sm shadow-accent-primary/10"
              >
                完成
              </button>
            </div>
          </div>
        )}

        {/* 标签选择 */}
        <div className="mt-3">
          <GenericTagInput
            selectedTags={composeTags}
            onTagsChange={setComposeTags}
            placeholder={t('tags.addTagPlaceholder')}
          />
        </div>
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

          {/* 图片按钮：达到上限就禁用 */}
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
                ? t("diary.imageLimitReached").replace(
                    "{{n}}",
                    String(MAX_IMAGES_PER_DIARY),
                  )
                : t("diary.addImage")
            }
          >
            <ImagePlus size={15} />
            <span className="hidden sm:inline">{t("diary.image")}</span>
            {pendingImages.length > 0 && (
              <span className="text-[10px] text-tx-tertiary tabular-nums">
                {pendingImages.length}/{MAX_IMAGES_PER_DIARY}
              </span>
            )}
          </button>
          
          {/* 语音按钮 */}
          <button
            onClick={startRecording}
            disabled={recording || pendingVoice !== null}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs transition-all",
              (recording || pendingVoice !== null)
                ? "text-tx-tertiary/50 cursor-not-allowed"
                : "text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover",
            )}
            title={pendingVoice !== null ? "每条说说只能录制一段语音" : "录制语音"}
          >
            <Mic size={15} />
            <span className="hidden sm:inline">语音</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        <div className="flex items-center gap-2">
          {/* 可见性范围选择 */}
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            className="text-[11px] bg-app-hover/80 border border-app-border text-tx-secondary rounded-full px-2.5 py-1 outline-none cursor-pointer focus:border-accent-primary/50 transition-all font-medium"
          >
            <option value="PRIVATE">🔒 自己可见</option>
            <option value="PUBLIC">🌐 公开</option>
          </select>
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
                : hasErrorImages
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
// 语音播放器组件 (VoicePlayer)
// ============================================================
function VoicePlayer({
  item,
  onUpdate,
}: {
  item: Diary;
  onUpdate: (updated: Diary) => void;
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(item.voice?.duration || 0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [transcribing, setTranscribing] = useState(false);
  const [showVolume, setShowVolume] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pressTimerRef = useRef<any>(null);

  const voice = item.voice!;
  const audioUrl = api.diaryImages.urlFor(voice.id);

  useEffect(() => {
    const audio = new Audio(audioUrl);
    audioRef.current = audio;

    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    const onLoadedMetadata = () => {
      if (audio.duration && !isNaN(audio.duration) && isFinite(audio.duration)) {
        setDuration(audio.duration);
      }
    };

    const onEnded = () => {
      setIsPlaying(false);
      setCurrentTime(0);
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("loadedmetadata", onLoadedMetadata);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.pause();
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("loadedmetadata", onLoadedMetadata);
      audio.removeEventListener("ended", onEnded);
    };
  }, [audioUrl]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
      audioRef.current.playbackRate = playbackRate;
    }
  }, [volume, isMuted, playbackRate]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play().catch((err) => {
        console.error("Play failed:", err);
      });
      setIsPlaying(true);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setCurrentTime(val);
    if (audioRef.current) {
      audioRef.current.currentTime = val;
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (val > 0) {
      setIsMuted(false);
    }
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const cycleSpeed = () => {
    const rates = [1, 1.25, 1.5, 2, 0.5];
    const nextIdx = (rates.indexOf(playbackRate) + 1) % rates.length;
    setPlaybackRate(rates[nextIdx]);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const handleTranscribe = async () => {
    if (voice.text) return; // Already transcribed
    setTranscribing(true);
    try {
      const res = await api.transcribeDiaryVoice(item.id, voice.id);
      onUpdate({
        ...item,
        voice: {
          ...voice,
          text: res.text,
        },
      });
      toast.success("转文字成功");
    } catch (e: any) {
      console.error("Transcribe failed:", e);
      toast.error(e?.message || "语音转文字失败");
    } finally {
      setTranscribing(false);
    }
  };

  const handleStartPress = (e: React.MouseEvent | React.TouchEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("input")) return;
    pressTimerRef.current = setTimeout(() => {
      handleTranscribe();
    }, 800);
  };

  const handleEndPress = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
  };

  return (
    <div className="flex flex-col gap-2 w-full mt-3">
      {/* 播放器面板 */}
      <div
        onMouseDown={handleStartPress}
        onMouseUp={handleEndPress}
        onMouseLeave={handleEndPress}
        onTouchStart={handleStartPress}
        onTouchEnd={handleEndPress}
        className="flex items-center gap-3 p-3 rounded-2xl bg-accent-primary/5 border border-accent-primary/10 select-none hover:bg-accent-primary/10 transition-colors duration-200"
        title="长按此区域语音转文字"
      >
        {/* 播放/暂停按钮 */}
        <button
          onClick={togglePlay}
          className="w-9 h-9 rounded-full bg-accent-primary text-white flex items-center justify-center shadow-md shadow-accent-primary/20 hover:scale-105 active:scale-95 transition-all shrink-0"
        >
          {isPlaying ? (
            <Pause size={16} fill="white" />
          ) : (
            <Play size={16} fill="white" className="ml-0.5" />
          )}
        </button>

        {/* 进度条 & 时间 */}
        <div className="flex-1 flex flex-col gap-1 min-w-0">
          <input
            type="range"
            min="0"
            max={duration || 100}
            value={currentTime}
            onChange={handleSeek}
            className="w-full h-1 bg-app-border rounded-lg appearance-none cursor-pointer accent-accent-primary"
          />
          <div className="flex items-center justify-between text-[10px] text-tx-tertiary tabular-nums">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>

        {/* 音量控制 */}
        <div
          className="relative flex items-center"
          onMouseEnter={() => setShowVolume(true)}
          onMouseLeave={() => setShowVolume(false)}
        >
          <button
            onClick={toggleMute}
            className="w-7 h-7 rounded-lg hover:bg-app-hover text-tx-secondary flex items-center justify-center transition-colors"
          >
            {isMuted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <AnimatePresence>
            {showVolume && (
              <motion.div
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 60 }}
                exit={{ opacity: 0, width: 0 }}
                className="overflow-hidden flex items-center h-full mr-1"
              >
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={isMuted ? 0 : volume}
                  onChange={handleVolumeChange}
                  className="w-12 h-1 bg-app-border rounded-lg appearance-none cursor-pointer accent-accent-primary"
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* 倍速播放 */}
        <button
          onClick={cycleSpeed}
          className="px-2 py-0.5 rounded bg-app-hover hover:bg-app-active text-[10px] font-semibold text-tx-secondary transition-all shrink-0"
        >
          {playbackRate}x
        </button>
      </div>

      {/* 转文字状态 / 结果 */}
      {transcribing && (
        <div className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-app-hover/30 border border-app-border/40 text-xs text-tx-tertiary">
          <Loader2 size={12} className="animate-spin text-accent-primary" />
          <span>正在转写文字...</span>
        </div>
      )}

      {voice.text && (
        <div className="p-3 rounded-xl bg-app-hover/30 border border-app-border/40 relative group/trans">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] text-accent-primary font-medium flex items-center gap-1 bg-accent-primary/5 px-2 py-0.5 rounded-full select-none">
              <Sparkles size={10} /> SenseVoice 转写文本
            </span>
          </div>
          <p className="text-xs text-tx-secondary leading-relaxed select-text font-normal pr-8 break-words">
            {voice.text}
          </p>
          <button
            onClick={() => {
              navigator.clipboard.writeText(voice.text || "");
              toast.success("已复制到剪贴板");
            }}
            className="absolute top-2.5 right-2.5 w-5 h-5 rounded hover:bg-app-hover text-tx-tertiary hover:text-tx-secondary flex items-center justify-center transition-colors opacity-0 group-hover/trans:opacity-100"
            title="复制文本"
          >
            <Copy size={12} />
          </button>
        </div>
      )}
    </div>
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
            {/* 内容（支持 HTML & Markdown 渲染） */}
            {item.contentText && (
              <div
                className="diary-rendered-content prose prose-sm dark:prose-invert max-w-none text-sm text-tx-primary leading-relaxed break-words"
                dangerouslySetInnerHTML={{ __html: renderDiaryContent(item.contentText) }}
              />
            )}

            {/* 语音播放器 */}
            {item.voice && (
              <VoicePlayer item={item} onUpdate={onUpdate} />
            )}

            {/* 图片网格 */}
            {item.images && item.images.length > 0 && (
              <ImageGrid ids={item.images} onOpen={setLightboxIdx} />
            )}

            {/* 标签列表 */}
            {item.tags && item.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {item.tags.map((tag) => (
                  <span
                    key={tag.id}
                    className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border"
                    style={{
                      backgroundColor: tag.color + "15",
                      borderColor: tag.color + "30",
                      color: tag.color,
                    }}
                  >
                    #{tag.name}
                  </span>
                ))}
              </div>
            )}

            {/* 底部元信息 */}
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-app-border/40">
              <div className="flex items-center gap-2 text-[11px] text-tx-tertiary min-w-0">
                {moodEmoji && <span className="text-sm">{moodEmoji}</span>}
                <span className="shrink-0">{timeAgo(item.createdAt, t)}</span>
                {/* 空间可见性标识 */}
                <span className="text-tx-tertiary/60 shrink-0">·</span>
                <span className="flex items-center gap-0.5 shrink-0" title={item.visibility === "PUBLIC" ? "公开的说说" : "仅自己可见的说说"}>
                  {item.visibility === "PUBLIC" ? (
                    <>
                      <Globe size={11} />
                      <span>公开</span>
                    </>
                  ) : (
                    <>
                      <Lock size={11} />
                      <span>仅自己可见</span>
                    </>
                  )}
                </span>
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
            ids={item.images}
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
  const { state } = useApp();
  const [text, setText] = useState(item.contentText || "");
  const [mood, setMood] = useState(item.mood || "");
  const [showMoods, setShowMoods] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visibility, setVisibility] = useState<string>(item.visibility || "PRIVATE");
  const [editorTags, setEditorTags] = useState<Tag[]>(item.tags || []);
  const [images, setImages] = useState<PendingImage[]>(() =>
    (item.images || []).map((id) => ({
      localKey: id,
      id,
      previewUrl: api.diaryImages.urlFor(id),
      status: "ready" as const,
    })),
  );
  const imagesRef = useRef<PendingImage[]>([]);
  imagesRef.current = images;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const moodRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (moodRef.current && !moodRef.current.contains(e.target as Node)) {
        setShowMoods(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

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

  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      const current = imagesRef.current;
      const remaining = MAX_IMAGES_PER_DIARY - current.length;
      if (remaining <= 0) return;

      const accepted: File[] = [];
      const rejected: { name: string; reason: string }[] = [];
      for (const f of files) {
        if (accepted.length >= remaining) break;
        const mime = (f.type || "").toLowerCase();
        if (!ALLOWED_IMAGE_MIMES.has(mime)) {
          rejected.push({ name: f.name || "image", reason: "type" });
          continue;
        }
        if (f.size > MAX_DIARY_IMAGE_SIZE) {
          rejected.push({ name: f.name || "image", reason: "size" });
          continue;
        }
        accepted.push(f);
      }
      if (rejected.length) {
        for (const r of rejected) {
          toast.error(
            r.reason === "size"
              ? t("diary.imageTooLarge").replace("{{name}}", r.name)
              : t("diary.imageTypeUnsupported").replace("{{name}}", r.name),
          );
        }
      }
      if (!accepted.length) return;

      const newItems: PendingImage[] = accepted.map((f) => ({
        localKey: crypto.randomUUID(),
        id: null,
        previewUrl: URL.createObjectURL(f),
        status: "uploading",
      }));
      setImages((prev) => [...prev, ...newItems]);

      newItems.forEach((it, idx) => {
        const file = accepted[idx];
        api.diaryImages
          .upload(file)
          .then((res) => {
            setImages((prev) =>
              prev.map((p) =>
                p.localKey === it.localKey
                  ? { ...p, id: res.id, status: "ready" as const }
                  : p,
              ),
            );
          })
          .catch((err) => {
            console.error("Diary image upload failed:", err);
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
  const readyImageIds = images
    .filter((p) => p.status === "ready" && p.id)
    .map((p) => p.id!) as string[];

  const canSave =
    !saving &&
    !hasPendingUploads &&
    (text.trim().length > 0 || readyImageIds.length > 0);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const updated = await api.updateDiary(item.id, {
        contentText: text.trim(),
        mood,
        images: readyImageIds,
        visibility,
        tagIds: editorTags.map((t) => t.id),
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

  const toggleTag = (tag: Tag) => {
    setEditorTags((prev) =>
      prev.find((t) => t.id === tag.id)
        ? prev.filter((t) => t.id !== tag.id)
        : [...prev, tag]
    );
  };

  const selectedMoodEmoji = getMoodEmoji(mood);
  const remainingSlots = MAX_IMAGES_PER_DIARY - images.length;

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

        {/* 标签选择（支持创建新标签） */}
        <div className="mt-2">
          <GenericTagInput
            selectedTags={editorTags}
            onTagsChange={setEditorTags}
            placeholder="添加或创建标签..."
          />
        </div>

        {/* 图片缩略图 */}
        {images.length > 0 && (
          <div className="mt-2 grid grid-cols-4 sm:grid-cols-5 gap-2">
            {images.map((img) => (
              <div
                key={img.localKey}
                className="relative aspect-square rounded-lg overflow-hidden border border-app-border bg-app-hover/40 group/img"
              >
                <img
                  src={img.previewUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  draggable={false}
                />
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
                  aria-label={t("diary.removeImage")}
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
                ? t("diary.imageLimitReached").replace(
                    "{{n}}",
                    String(MAX_IMAGES_PER_DIARY),
                  )
                : t("diary.addImage")
            }
          >
            <ImagePlus size={15} />
            <span className="hidden sm:inline">{t("diary.image")}</span>
            {images.length > 0 && (
              <span className="text-[10px] text-tx-tertiary tabular-nums">
                {images.length}/{MAX_IMAGES_PER_DIARY}
              </span>
            )}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp,image/bmp"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        <div className="flex items-center gap-2">
          {/* 可见性范围选择 */}
          <select
            value={visibility}
            onChange={(e) => setVisibility(e.target.value)}
            className="text-[11px] bg-app-hover/80 border border-app-border text-tx-secondary rounded-full px-2.5 py-1 outline-none cursor-pointer focus:border-accent-primary/50 transition-all font-medium"
          >
            <option value="PRIVATE">🔒 自己可见</option>
            <option value="PUBLIC">🌐 公开</option>
          </select>
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
      d.setDate(d.getDate() - 6);
      return { from: ymd(d) };
    }
    case "month": {
      const d = new Date(now);
      d.setDate(d.getDate() - 29);
      return { from: ymd(d) };
    }
    case "custom":
      if (!customRange?.from && !customRange?.to) return null;
      return { from: customRange.from, to: customRange.to };
  }
}

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
  const { state } = useApp();
  const [items, setItems] = useState<Diary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [stats, setStats] = useState<DiaryStats | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const [visibilityFilter, setVisibilityFilter] = useState<string>("all");
  const [selectedTagId, setSelectedTagId] = useState<string>("all");

  const [preset, setPreset] = useState<RangePreset>("all");
  const [customRange, setCustomRange] = useState<DateRange>({});
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");
  const [calendarDate, setCalendarDate] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  const activeRange = useMemo(
    () => presetToRange(preset, customRange),
    [preset, customRange],
  );

  const loadTimeline = useCallback(
    async (reset = false) => {
      if (reset) setLoading(true);
      else setLoadingMore(true);

      try {
        const cursor = reset ? undefined : nextCursor || undefined;
        const data = await api.getDiaryTimeline(
          cursor,
          20,
          activeRange || undefined,
          visibilityFilter,
          selectedTagId === "all" ? undefined : selectedTagId,
          debouncedSearch || undefined,
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
    [nextCursor, activeRange, visibilityFilter, selectedTagId, debouncedSearch],
  );

  const loadStats = useCallback(async () => {
    try {
      const s = await api.getDiaryStats(activeRange || undefined);
      setStats(s);
    } catch {
      /* ignore */
    }
  }, [activeRange]);

  useEffect(() => {
    loadTimeline(true);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onWs = () => {
      setNextCursor(null);
      loadTimeline(true);
      loadStats();
    };
    window.addEventListener("nowen:workspace-changed", onWs);
    return () => window.removeEventListener("nowen:workspace-changed", onWs);
  }, [loadTimeline, loadStats]);

  const rangeKey = useMemo(() => JSON.stringify(activeRange), [activeRange]);
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    setNextCursor(null);
    loadTimeline(true);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeKey, visibilityFilter, selectedTagId, debouncedSearch]);

  const handlePost = useCallback(() => {
    setNextCursor(null);
    loadTimeline(true);
    loadStats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const handleUpdate = useCallback((updated: Diary) => {
    setItems((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, []);

  const handleFilterChange = useCallback(
    (next: RangePreset, range: DateRange) => {
      setPreset(next);
      setCustomRange(range);
    },
    [],
  );

  const handleCalendarDateSelect = useCallback((dateStr: string) => {
    setCalendarDate(dateStr);
    setViewMode("list");
    // 设置筛选范围为选中当天
    setPreset("custom");
    setCustomRange({ from: dateStr, to: dateStr });
  }, []);

  const isFiltering = preset !== "all" || visibilityFilter !== "all" || selectedTagId !== "all";

  const groupedItems = groupByDate(items, t);

  return (
    <div className="flex-1 flex h-full overflow-hidden bg-app-bg">
      {/* 左侧标签筛选栏 */}
      <div className="hidden md:flex w-[180px] min-w-[180px] shrink-0 flex-col border-r border-app-border bg-app-surface">
        <div className="p-3 border-b border-app-border">
          <h3 className="text-[11px] font-semibold text-tx-tertiary uppercase tracking-wider">标签筛选</h3>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          <button
            onClick={() => setSelectedTagId("all")}
            className={cn(
              "w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors",
              selectedTagId === "all" || !selectedTagId
                ? "bg-accent-primary/10 text-accent-primary font-medium"
                : "text-tx-secondary hover:bg-app-hover"
            )}
          >
            全部
          </button>
          {state.tags.map((tag) => (
            <button
              key={tag.id}
              onClick={() => setSelectedTagId(selectedTagId === tag.id ? "all" : tag.id)}
              className={cn(
                "w-full text-left px-2.5 py-1.5 rounded-md text-xs transition-colors flex items-center gap-2",
                selectedTagId === tag.id
                  ? "bg-accent-primary/10 text-accent-primary font-medium"
                  : "text-tx-secondary hover:bg-app-hover"
              )}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
              <span className="truncate">{tag.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <ScrollArea className="flex-1" ref={scrollRef}>
          <div className="max-w-[640px] mx-auto px-4 py-6 space-y-6">
          {/* 顶部标题 + 统计 + 视图切换 */}
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
            {/* 日历/列表切换 */}
            <button
              onClick={() => setViewMode((v) => (v === "list" ? "calendar" : "list"))}
              className={cn(
                "w-9 h-9 rounded-xl flex items-center justify-center transition-all",
                viewMode === "calendar"
                  ? "bg-accent-primary/10 text-accent-primary"
                  : "text-tx-tertiary hover:bg-app-hover",
              )}
              title={viewMode === "calendar" ? "列表视图" : "日历视图"}
            >
              {viewMode === "calendar" ? <Calendar size={18} /> : <CalendarDays size={18} />}
            </button>
          </div>

          {/* 筛选时间 + 可见性 + 标签 */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <FilterBar
              preset={preset}
              customRange={customRange}
              onChange={handleFilterChange}
            />

            <div className="flex flex-wrap items-center gap-3">
              {/* 搜索框 */}
              <div className="relative w-full sm:w-[160px]">
                <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-tx-tertiary" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜索说说..."
                  className="w-full text-[11px] pl-8 pr-3 py-1 bg-app-hover/80 border border-app-border text-tx-secondary rounded-full outline-none focus:border-accent-primary/50 transition-all font-medium"
                />
              </div>

              {/* 标签筛选 */}
              {state.tags.length > 0 && (
                <select
                  value={selectedTagId}
                  onChange={(e) => setSelectedTagId(e.target.value)}
                  className="text-[11px] bg-app-hover/80 border border-app-border text-tx-secondary rounded-full px-3 py-1 outline-none cursor-pointer focus:border-accent-primary/50 transition-all font-medium"
                >
                  <option value="all">🏷️ 所有标签</option>
                  {state.tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              )}

              {/* 可见性筛选 */}
              <div className="flex items-center gap-1 bg-app-hover/40 p-0.5 rounded-full border border-app-border/40 select-none">
                <button
                  onClick={() => setVisibilityFilter("all")}
                  className={cn(
                    "px-3 py-1 rounded-full text-[11px] font-medium transition-all flex items-center gap-1",
                    visibilityFilter === "all"
                      ? "bg-accent-primary text-white shadow-sm"
                      : "text-tx-tertiary hover:text-tx-secondary"
                  )}
                >
                  全部
                </button>
                <button
                  onClick={() => setVisibilityFilter("private")}
                  className={cn(
                    "px-3 py-1 rounded-full text-[11px] font-medium transition-all flex items-center gap-1",
                    visibilityFilter === "private"
                      ? "bg-accent-primary text-white shadow-sm"
                      : "text-tx-tertiary hover:text-tx-secondary"
                  )}
                >
                  <Lock size={10} />
                  自己可见
                </button>
                <button
                  onClick={() => setVisibilityFilter("public")}
                  className={cn(
                    "px-3 py-1 rounded-full text-[11px] font-medium transition-all flex items-center gap-1",
                    visibilityFilter === "public"
                      ? "bg-accent-primary text-white shadow-sm"
                      : "text-tx-tertiary hover:text-tx-secondary"
                  )}
                >
                  <Globe size={10} />
                  公开
                </button>
              </div>
            </div>
          </div>

          {/* 发布框 — 列表模式下显示 */}
          {viewMode === "list" && <ComposeBox onPost={handlePost} />}

          {/* 日历视图 / 时间线 */}
          {viewMode === "calendar" ? (
            <div className="py-4">
              <DiaryCalendar
                onDateSelect={handleCalendarDateSelect}
                tagId={selectedTagId !== "all" ? selectedTagId : undefined}
                search={debouncedSearch || undefined}
              />
            </div>
          ) : loading ? (
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
