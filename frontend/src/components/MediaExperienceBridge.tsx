import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { Keyboard } from "@capacitor/keyboard";
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Clipboard,
  Download,
  FileVideo2,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { resolveAttachmentUrl } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/toast";
import {
  appendDownloadFlag,
  dispatchMediaFilesToEditor,
  findActiveEditorDropTarget,
  formatMediaBytes,
  formatMediaDuration,
  prepareMediaFiles,
  type MediaKind,
  type PreparedMediaFile,
} from "@/lib/mediaExperience";
import {
  listenMediaUploadLifecycle,
  type MediaUploadLifecycleDetail,
} from "@/lib/mediaUploadLifecycle";

type QueuePhase = "choose" | "preflight" | "uploading" | "done";

type QueueItem = PreparedMediaFile & {
  previewUrl: string;
  validationError: boolean;
};

type VideoEntry = {
  id: string;
  video: HTMLVideoElement;
  wrapper: HTMLElement;
};

type ReplacementContext = {
  wrapper: HTMLElement;
  video: HTMLVideoElement;
};

const videoIds = new WeakMap<HTMLVideoElement, string>();
let nextVideoId = 1;

function videoId(video: HTMLVideoElement): string {
  let id = videoIds.get(video);
  if (!id) {
    id = `nowen-video-${nextVideoId++}`;
    videoIds.set(video, id);
  }
  return id;
}

function isMobileMediaViewport(): boolean {
  if (typeof window === "undefined") return false;
  return Capacitor.isNativePlatform()
    || window.matchMedia("(max-width: 767px), (pointer: coarse)").matches;
}

async function hideKeyboard(): Promise<void> {
  try {
    if (Capacitor.isNativePlatform()) await Keyboard.hide();
  } catch {
    // Web and desktop do not expose a native keyboard plugin.
  }
}

function openNativePicker(options: {
  accept: string;
  multiple: boolean;
  capture?: "environment";
  onFiles: (files: File[]) => void;
}): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = options.accept;
  input.multiple = options.multiple;
  if (options.capture) input.setAttribute("capture", options.capture);
  input.style.position = "fixed";
  input.style.left = "-9999px";
  input.style.opacity = "0";
  input.onchange = () => {
    const files = Array.from(input.files || []);
    input.remove();
    if (files.length) options.onFiles(files);
    void hideKeyboard();
  };
  input.oncancel = () => input.remove();
  document.body.appendChild(input);
  input.click();
}

function requestVideoFullscreen(video: HTMLVideoElement): Promise<void> | void {
  const candidate = video as HTMLVideoElement & {
    webkitEnterFullscreen?: () => void;
    webkitRequestFullscreen?: () => Promise<void>;
  };
  if (video.requestFullscreen) return video.requestFullscreen();
  if (candidate.webkitRequestFullscreen) return candidate.webkitRequestFullscreen();
  candidate.webkitEnterFullscreen?.();
}

function sourceForVideo(video: HTMLVideoElement, wrapper: HTMLElement): string {
  return wrapper.dataset.originalUrl
    || video.getAttribute("src")
    || video.currentSrc
    || "";
}

function filenameForVideo(wrapper: HTMLElement): string {
  return wrapper.dataset.filename || "video";
}

function triggerVideoDownload(video: HTMLVideoElement, wrapper: HTMLElement): void {
  const src = sourceForVideo(video, wrapper);
  if (!src) return;
  const anchor = document.createElement("a");
  anchor.href = appendDownloadFlag(resolveAttachmentUrl(src));
  anchor.download = filenameForVideo(wrapper);
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function findOriginalVideoButton(wrapper: HTMLElement, pattern: RegExp): HTMLButtonElement | null {
  const buttons = Array.from(wrapper.querySelectorAll<HTMLButtonElement>("button"));
  return buttons.find((button) => {
    if (button.closest("[data-nowen-video-portal]")) return false;
    const label = `${button.title || ""} ${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`;
    return pattern.test(label);
  }) || null;
}

function selectVideoNode(wrapper: HTMLElement): void {
  const rect = wrapper.getBoundingClientRect();
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + Math.max(4, rect.width / 2),
    clientY: rect.top + Math.max(4, rect.height / 2),
    view: window,
  };
  wrapper.dispatchEvent(new MouseEvent("mousedown", init));
  wrapper.dispatchEvent(new MouseEvent("click", init));
}

async function deleteVideoNode(wrapper: HTMLElement): Promise<boolean> {
  if (!wrapper.isConnected) return true;
  selectVideoNode(wrapper);
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  const button = findOriginalVideoButton(wrapper, /删除|delete/i);
  if (button) {
    button.click();
    return true;
  }

  const editor = wrapper.closest<HTMLElement>('.ProseMirror[contenteditable="true"]');
  if (!editor) return false;
  editor.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Backspace",
    code: "Backspace",
    bubbles: true,
    cancelable: true,
  }));
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  return !wrapper.isConnected;
}

function capturePoster(video: HTMLVideoElement): void {
  if (video.dataset.nowenPosterAttempted === "1" || video.readyState < 2) return;
  video.dataset.nowenPosterAttempted = "1";
  try {
    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) return;
    const maxWidth = 640;
    const scale = Math.min(1, maxWidth / sourceWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const poster = canvas.toDataURL("image/jpeg", 0.76);
    if (poster.length < 1_500_000) video.poster = poster;
  } catch {
    // Cross-origin platform videos and unsupported codecs keep their normal first-frame UI.
  }
}

function VideoOverlay({
  entry,
  onOpenActions,
  onStateChange,
}: {
  entry: VideoEntry;
  onOpenActions: (entry: VideoEntry) => void;
  onStateChange: () => void;
}) {
  const { video, wrapper } = entry;
  const failed = Boolean(video.error);
  const playing = !video.paused && !video.ended;
  const duration = Number.isFinite(video.duration) ? video.duration : 0;

  const play = async () => {
    try {
      if (playing) video.pause();
      else await video.play();
      onStateChange();
    } catch {
      toast.error("无法播放该视频，请检查编码格式或网络连接");
    }
  };

  return createPortal(
    <div
      data-nowen-video-portal="overlay"
      className="pointer-events-none absolute inset-0 z-[3] rounded-xl"
    >
      {failed ? (
        <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl bg-black/70 px-4 text-center text-white">
          <AlertTriangle size={24} />
          <div className="text-sm font-medium">视频加载失败</div>
          <div className="text-xs text-white/70">可能是文件编码不受支持、链接失效或网络中断</div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              video.dataset.nowenPosterAttempted = "0";
              video.load();
              onStateChange();
            }}
            className="mt-1 flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-xs hover:bg-white/25"
          >
            <RefreshCw size={14} /> 重试加载
          </button>
        </div>
      ) : (
        <>
          {!playing && (
            <button
              type="button"
              aria-label="播放视频"
              onClick={(event) => { event.stopPropagation(); void play(); }}
              className="pointer-events-auto absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur transition-transform active:scale-95"
            >
              <Play size={25} fill="currentColor" className="ml-1" />
            </button>
          )}
          {duration > 0 && (
            <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white backdrop-blur">
              {formatMediaDuration(duration)}
            </span>
          )}
          <button
            type="button"
            aria-label="全屏播放"
            onClick={(event) => { event.stopPropagation(); void requestVideoFullscreen(video); }}
            className="pointer-events-auto absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-lg bg-black/55 text-white backdrop-blur hover:bg-black/70"
          >
            <Maximize2 size={17} />
          </button>
          <button
            type="button"
            aria-label="视频操作"
            onClick={(event) => { event.stopPropagation(); onOpenActions(entry); }}
            className="pointer-events-auto absolute right-2 top-2 flex h-9 items-center gap-1.5 rounded-lg bg-black/55 px-2.5 text-xs text-white backdrop-blur hover:bg-black/70 md:hidden"
          >
            <Video size={15} /> 操作
          </button>
        </>
      )}
      <button
        type="button"
        aria-label={playing ? "暂停" : "播放"}
        onDoubleClick={(event) => { event.stopPropagation(); void requestVideoFullscreen(video); }}
        onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); onOpenActions(entry); }}
        className="pointer-events-auto absolute inset-0 -z-10 rounded-xl bg-transparent"
      />
      <span className="sr-only">{filenameForVideo(wrapper)}</span>
    </div>,
    wrapper,
  );
}

export default function MediaExperienceBridge() {
  const [isMobile, setIsMobile] = useState(isMobileMediaViewport);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [requestedKind, setRequestedKind] = useState<MediaKind>("image");
  const [queuePhase, setQueuePhase] = useState<QueuePhase>("choose");
  const [items, setItems] = useState<QueueItem[]>([]);
  const [videoEntries, setVideoEntries] = useState<VideoEntry[]>([]);
  const [videoVersion, setVideoVersion] = useState(0);
  const [activeVideo, setActiveVideo] = useState<VideoEntry | null>(null);
  const replacementRef = useRef(new Map<File | Blob, ReplacementContext>());
  const watchdogRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const enhancedVideosRef = useRef(new WeakSet<HTMLVideoElement>());

  const clearQueueFiles = useCallback(() => {
    setItems((previous) => {
      previous.forEach((item) => URL.revokeObjectURL(item.previewUrl));
      return [];
    });
  }, []);

  const closePicker = useCallback(() => {
    if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    watchdogRef.current = null;
    closeTimerRef.current = null;
    clearQueueFiles();
    setPickerOpen(false);
    setQueuePhase("choose");
    void hideKeyboard();
  }, [clearQueueFiles]);

  const openPickerSheet = useCallback((kind: MediaKind) => {
    if (!isMobile) return;
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    clearQueueFiles();
    setRequestedKind(kind);
    setQueuePhase("choose");
    setPickerOpen(true);
    void hideKeyboard();
  }, [clearQueueFiles, isMobile]);

  const receiveFiles = useCallback((files: File[]) => {
    clearQueueFiles();
    const prepared = prepareMediaFiles(files);
    if (files.length > prepared.length) {
      toast.info(`一次最多插入 ${prepared.length} 个媒体文件，其余文件未加入队列`);
    }
    setItems(prepared.map((item) => ({
      ...item,
      previewUrl: URL.createObjectURL(item.file),
      validationError: Boolean(item.error),
    })));
    setQueuePhase("preflight");
    setPickerOpen(true);
    void hideKeyboard();
  }, [clearQueueFiles]);

  const chooseFiles = useCallback((source: "gallery" | "camera" | "files") => {
    const capture = source === "camera" ? "environment" as const : undefined;
    openNativePicker({
      accept: source === "camera"
        ? requestedKind === "video" ? "video/*" : "image/*"
        : "image/*,video/*",
      multiple: source !== "camera",
      capture,
      onFiles: receiveFiles,
    });
    void hideKeyboard();
  }, [receiveFiles, requestedKind]);

  const startUpload = useCallback((retryOnly = false) => {
    const selected = items.filter((item) => {
      if (!item.kind || item.validationError) return false;
      return retryOnly ? item.status === "error" : item.status === "ready" || item.status === "error";
    });
    if (!selected.length) return;

    setQueuePhase("uploading");
    setItems((previous) => previous.map((item) => selected.some((candidate) => candidate.id === item.id)
      ? { ...item, status: "ready", error: undefined }
      : item));

    const target = findActiveEditorDropTarget(document);
    if (!dispatchMediaFilesToEditor(selected.map((item) => item.file), { target })) {
      setItems((previous) => previous.map((item) => selected.some((candidate) => candidate.id === item.id)
        ? { ...item, status: "error", error: "没有找到可编辑的笔记正文" }
        : item));
      setQueuePhase("done");
      return;
    }

    if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = window.setTimeout(() => {
      setItems((previous) => previous.map((item) =>
        item.status === "ready" || item.status === "uploading"
          ? { ...item, status: "error", error: "上传等待超时，请检查网络后重试" }
          : item));
      setQueuePhase("done");
    }, 120_000);
    void hideKeyboard();
  }, [items]);

  const finishReplacement = useCallback((detail: MediaUploadLifecycleDetail, context: ReplacementContext) => {
    const result = detail.result as { attachmentId?: string; url?: string } | undefined;
    const marker = result?.attachmentId || result?.url || "";
    let attempts = 0;
    const locate = async () => {
      attempts += 1;
      const replacement = Array.from(document.querySelectorAll<HTMLVideoElement>(".video-node-wrapper video"))
        .find((candidate) => {
          if (candidate === context.video) return false;
          const source = candidate.getAttribute("src") || candidate.currentSrc || "";
          return marker ? source.includes(marker) : candidate.closest(".video-node-wrapper") !== context.wrapper;
        });
      if (!replacement && attempts < 50) {
        window.setTimeout(() => { void locate(); }, 100);
        return;
      }
      if (!replacement) {
        toast.info("新视频已插入，但无法定位旧视频，请手动删除旧节点");
        return;
      }
      const removed = await deleteVideoNode(context.wrapper);
      if (removed) toast.success("视频已替换");
      else toast.info("新视频已插入，请手动删除旧视频");
      setActiveVideo(null);
    };
    window.setTimeout(() => { void locate(); }, 80);
  }, []);

  useEffect(() => listenMediaUploadLifecycle((detail) => {
    setItems((previous) => previous.map((item) => {
      if (item.file !== detail.file) return item;
      if (detail.phase === "start") return { ...item, status: "uploading", error: undefined };
      if (detail.phase === "success") return { ...item, status: "success", error: undefined };
      return { ...item, status: "error", error: detail.error || "上传失败" };
    }));

    const replacement = replacementRef.current.get(detail.file);
    if (replacement && detail.phase !== "start") {
      replacementRef.current.delete(detail.file);
      if (detail.phase === "success") finishReplacement(detail, replacement);
    }
  }), [finishReplacement]);

  useEffect(() => {
    if (!pickerOpen || queuePhase !== "uploading") return;
    const uploadable = items.filter((item) => item.kind && !item.validationError);
    if (!uploadable.length) return;
    const settled = uploadable.every((item) => item.status === "success" || item.status === "error");
    if (!settled) return;
    if (watchdogRef.current) window.clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    setQueuePhase("done");
    if (uploadable.every((item) => item.status === "success")) {
      closeTimerRef.current = window.setTimeout(closePicker, 1400);
    }
  }, [items, pickerOpen, queuePhase, closePicker]);

  useEffect(() => {
    if (!pickerOpen && !activeVideo) return;
    const editor = document.querySelector<HTMLElement>(
      '.ProseMirror[contenteditable="true"], .cm-content[contenteditable="true"]',
    );
    const previousInputMode = editor?.getAttribute("inputmode") ?? null;
    editor?.setAttribute("inputmode", "none");
    void hideKeyboard();
    const timers = [80, 260, 700].map((delay) => window.setTimeout(() => void hideKeyboard(), delay));
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      if (editor) {
        if (previousInputMode === null) editor.removeAttribute("inputmode");
        else editor.setAttribute("inputmode", previousInputMode);
      }
    };
  }, [pickerOpen, activeVideo]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px), (pointer: coarse)");
    const update = () => setIsMobile(isMobileMediaViewport());
    query.addEventListener?.("change", update);
    window.addEventListener("resize", update);
    return () => {
      query.removeEventListener?.("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    const intercept = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("button");
      if (!button || button.closest("[data-nowen-media-sheet]")) return;
      const imageIcon = button.querySelector("svg.lucide-image-plus");
      const videoIcon = button.querySelector("svg.lucide-film");
      if (!imageIcon && !videoIcon) return;
      if (!button.closest(".ProseMirror, .cm-editor, [data-editor-toolbar], .note-editor")) {
        // Toolbar buttons are sometimes siblings of the content root; their title is a safe fallback.
        const label = `${button.title || ""} ${button.getAttribute("aria-label") || ""}`;
        if (!/图片|image|视频|video/i.test(label)) return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      openPickerSheet(videoIcon ? "video" : "image");
    };
    document.addEventListener("click", intercept, true);
    return () => document.removeEventListener("click", intercept, true);
  }, [isMobile, openPickerSheet]);

  const openVideoActions = useCallback((entry: VideoEntry) => {
    selectVideoNode(entry.wrapper);
    setActiveVideo(entry);
    void hideKeyboard();
  }, []);

  useEffect(() => {
    let frame = 0;
    const reconcile = () => {
      frame = 0;
      const entries = Array.from(document.querySelectorAll<HTMLVideoElement>(".video-node-wrapper video"))
        .map((video) => {
          const wrapper = video.closest<HTMLElement>(".video-node-wrapper");
          if (!wrapper) return null;
          return { id: videoId(video), video, wrapper } satisfies VideoEntry;
        })
        .filter((entry): entry is VideoEntry => Boolean(entry));
      setVideoEntries(entries);

      for (const entry of entries) {
        const { video, wrapper } = entry;
        wrapper.style.maxWidth = "100%";
        video.playsInline = true;
        video.preload = "metadata";
        if (!enhancedVideosRef.current.has(video)) {
          enhancedVideosRef.current.add(video);
          const refresh = () => {
            if (video.readyState >= 2) capturePoster(video);
            setVideoVersion((value) => value + 1);
          };
          ["loadedmetadata", "loadeddata", "canplay", "play", "pause", "ended", "error", "emptied"]
            .forEach((name) => video.addEventListener(name, refresh));
          video.addEventListener("dblclick", () => void requestVideoFullscreen(video));

          let longPressTimer = 0;
          let startX = 0;
          let startY = 0;
          wrapper.addEventListener("pointerdown", (event) => {
            if (!isMobileMediaViewport()) return;
            startX = event.clientX;
            startY = event.clientY;
            longPressTimer = window.setTimeout(() => openVideoActions(entry), 520);
          }, { passive: true });
          wrapper.addEventListener("pointermove", (event) => {
            if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) {
              window.clearTimeout(longPressTimer);
            }
          }, { passive: true });
          wrapper.addEventListener("pointerup", () => window.clearTimeout(longPressTimer), { passive: true });
          wrapper.addEventListener("pointercancel", () => window.clearTimeout(longPressTimer), { passive: true });
          wrapper.addEventListener("contextmenu", (event) => {
            if (!isMobileMediaViewport()) return;
            event.preventDefault();
            openVideoActions(entry);
          });
          refresh();
        }

        for (const child of Array.from(wrapper.children)) {
          if (!(child instanceof HTMLElement)) continue;
          if (child.dataset.nowenVideoPortal) continue;
          if (child.getAttribute("contenteditable") === "false" && child.querySelector("button")) {
            child.dataset.nowenOriginalVideoToolbar = "1";
            child.style.display = isMobile ? "none" : "";
          }
        }
      }

      if (activeVideo && !activeVideo.wrapper.isConnected) setActiveVideo(null);
    };
    const schedule = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(reconcile);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "data-selected"],
    });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [activeVideo, isMobile, openVideoActions]);

  const replaceActiveVideo = useCallback(() => {
    const entry = activeVideo;
    if (!entry) return;
    openNativePicker({
      accept: "video/*",
      multiple: false,
      onFiles: (files) => {
        const file = files[0];
        if (!file) return;
        const prepared = prepareMediaFiles([file])[0];
        if (!prepared || prepared.kind !== "video" || prepared.error) {
          toast.error(prepared?.error || "请选择视频文件");
          return;
        }
        replacementRef.current.set(file, { wrapper: entry.wrapper, video: entry.video });
        clearQueueFiles();
        setItems([{
          ...prepared,
          previewUrl: URL.createObjectURL(file),
          validationError: false,
        }]);
        setQueuePhase("uploading");
        setPickerOpen(true);
        const target = findActiveEditorDropTarget(document);
        if (!dispatchMediaFilesToEditor([file], { target, near: entry.wrapper })) {
          replacementRef.current.delete(file);
          setItems((previous) => previous.map((item) => ({
            ...item,
            status: "error",
            error: "没有找到可编辑的笔记正文",
          })));
          setQueuePhase("done");
        }
        setActiveVideo(null);
      },
    });
  }, [activeVideo, clearQueueFiles]);

  const deleteActiveVideo = useCallback(async () => {
    if (!activeVideo) return;
    const removed = await deleteVideoNode(activeVideo.wrapper);
    if (!removed) toast.error("无法删除视频节点，请重新选中后重试");
    setActiveVideo(null);
  }, [activeVideo]);

  const queueSummary = useMemo(() => {
    const valid = items.filter((item) => item.kind && !item.validationError);
    return {
      valid,
      totalBytes: valid.reduce((sum, item) => sum + item.file.size, 0),
      success: valid.filter((item) => item.status === "success").length,
      failed: valid.filter((item) => item.status === "error").length,
      active: valid.filter((item) => item.status === "uploading").length,
    };
  }, [items]);

  return (
    <>
      {videoEntries.map((entry) => (
        <VideoOverlay
          key={`${entry.id}-${videoVersion}`}
          entry={entry}
          onOpenActions={openVideoActions}
          onStateChange={() => setVideoVersion((value) => value + 1)}
        />
      ))}

      {pickerOpen && (
        <div
          data-nowen-media-sheet="picker"
          className="fixed inset-0 z-[190] flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:px-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && queuePhase !== "uploading") closePicker();
          }}
        >
          <section className="flex max-h-[88dvh] w-full flex-col overflow-hidden rounded-t-3xl border border-app-border bg-app-elevated shadow-2xl sm:max-w-xl sm:rounded-2xl">
            <header className="flex items-center gap-3 border-b border-app-border px-4 py-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-primary/10 text-accent-primary">
                {requestedKind === "video" ? <Video size={20} /> : <ImageIcon size={20} />}
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-tx-primary">插入图片与视频</h2>
                <p className="text-xs text-tx-tertiary">
                  {queuePhase === "choose" ? "从相册、相机或文件管理器选择" : `${queueSummary.valid.length} 项 · ${formatMediaBytes(queueSummary.totalBytes)}`}
                </p>
              </div>
              <button
                type="button"
                onClick={closePicker}
                className="rounded-lg p-2 text-tx-tertiary hover:bg-app-hover hover:text-tx-primary"
                title={queuePhase === "uploading" ? "上传将在后台继续" : "关闭"}
              >
                <X size={18} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4">
              {queuePhase === "choose" ? (
                <div className="grid grid-cols-3 gap-3">
                  <button type="button" onClick={() => chooseFiles("gallery")} className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-2xl border border-app-border bg-app-surface text-sm text-tx-secondary active:bg-app-hover">
                    <ImageIcon size={26} className="text-accent-primary" />
                    <span className="font-medium text-tx-primary">系统相册</span>
                    <span className="text-[11px] text-tx-tertiary">支持多选</span>
                  </button>
                  <button type="button" onClick={() => chooseFiles("camera")} className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-2xl border border-app-border bg-app-surface text-sm text-tx-secondary active:bg-app-hover">
                    <Camera size={26} className="text-accent-primary" />
                    <span className="font-medium text-tx-primary">{requestedKind === "video" ? "拍视频" : "拍照"}</span>
                    <span className="text-[11px] text-tx-tertiary">调用系统相机</span>
                  </button>
                  <button type="button" onClick={() => chooseFiles("files")} className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-2xl border border-app-border bg-app-surface text-sm text-tx-secondary active:bg-app-hover">
                    <FolderOpen size={26} className="text-accent-primary" />
                    <span className="font-medium text-tx-primary">选择文件</span>
                    <span className="text-[11px] text-tx-tertiary">图片或视频</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-2">
                  {items.map((item) => (
                    <div key={item.id} className={cn(
                      "rounded-xl border p-2.5",
                      item.status === "error" ? "border-red-500/25 bg-red-500/5" : "border-app-border bg-app-bg/45",
                    )}>
                      <div className="flex items-center gap-3">
                        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-black/8">
                          {item.kind === "image" ? (
                            <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
                          ) : item.kind === "video" ? (
                            <video src={item.previewUrl} muted playsInline preload="metadata" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-red-500"><AlertTriangle size={20} /></div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-tx-primary">{item.file.name || "未命名媒体"}</p>
                          <p className="mt-0.5 text-[11px] text-tx-tertiary">
                            {item.kind === "video" ? "视频" : item.kind === "image" ? "图片" : "不支持"} · {formatMediaBytes(item.file.size)}
                          </p>
                          {(item.error || item.warning) && (
                            <p className={cn("mt-1 text-xs", item.error ? "text-red-500" : "text-amber-500")}>{item.error || item.warning}</p>
                          )}
                        </div>
                        <div className="shrink-0">
                          {item.status === "ready" && <span className="text-xs text-tx-tertiary">等待</span>}
                          {item.status === "uploading" && <Loader2 size={18} className="animate-spin text-accent-primary" />}
                          {item.status === "success" && <CheckCircle2 size={19} className="text-emerald-500" />}
                          {item.status === "error" && !item.validationError && <RefreshCw size={18} className="text-red-500" />}
                        </div>
                      </div>
                      {item.status === "uploading" && (
                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-app-hover">
                          <div className="h-full w-1/2 animate-pulse rounded-full bg-accent-primary" />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {queuePhase !== "choose" && (
              <footer className="border-t border-app-border px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                <div className="mb-2 flex items-center justify-between text-xs text-tx-tertiary">
                  <span>成功 {queueSummary.success} · 失败 {queueSummary.failed} · 上传中 {queueSummary.active}</span>
                  <button type="button" onClick={() => chooseFiles("gallery")} disabled={queuePhase === "uploading"} className="text-accent-primary disabled:opacity-40">重新选择</button>
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={closePicker} className="h-11 flex-1 rounded-xl border border-app-border text-sm text-tx-secondary active:bg-app-hover">
                    {queuePhase === "uploading" ? "后台继续" : "取消"}
                  </button>
                  {queuePhase === "done" && queueSummary.failed > 0 ? (
                    <button type="button" onClick={() => startUpload(true)} className="flex h-11 flex-[1.5] items-center justify-center gap-2 rounded-xl bg-accent-primary text-sm font-medium text-white">
                      <RefreshCw size={16} /> 重试失败项
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startUpload(false)}
                      disabled={queuePhase === "uploading" || queueSummary.valid.length === 0}
                      className="flex h-11 flex-[1.5] items-center justify-center gap-2 rounded-xl bg-accent-primary text-sm font-medium text-white disabled:opacity-45"
                    >
                      {queuePhase === "uploading" ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                      {queuePhase === "uploading" ? "正在上传" : `插入 ${queueSummary.valid.length} 项`}
                    </button>
                  )}
                </div>
              </footer>
            )}
          </section>
        </div>
      )}

      {activeVideo && isMobile && activeVideo.wrapper.isConnected && (
        <div data-nowen-media-sheet="video-actions" className="fixed inset-0 z-[195] flex items-end bg-black/35" onMouseDown={(event) => { if (event.target === event.currentTarget) setActiveVideo(null); }}>
          <section className="w-full rounded-t-3xl border border-app-border bg-app-elevated px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-12px_30px_rgba(15,23,42,0.18)]">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-app-border" />
            <div className="mb-3 flex items-center justify-between">
              <div className="min-w-0">
                <h3 className="font-semibold text-tx-primary">视频操作</h3>
                <p className="max-w-[75vw] truncate text-xs text-tx-tertiary">{filenameForVideo(activeVideo.wrapper)}</p>
              </div>
              <button type="button" onClick={() => setActiveVideo(null)} className="rounded-lg p-2 text-tx-tertiary active:bg-app-hover"><X size={18} /></button>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={() => { activeVideo.video.paused ? void activeVideo.video.play() : activeVideo.video.pause(); setVideoVersion((value) => value + 1); }} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-app-border bg-app-surface text-xs text-tx-secondary active:bg-app-hover">
                {activeVideo.video.paused ? <Play size={19} /> : <Pause size={19} />} {activeVideo.video.paused ? "播放" : "暂停"}
              </button>
              <button type="button" onClick={() => void requestVideoFullscreen(activeVideo.video)} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-app-border bg-app-surface text-xs text-tx-secondary active:bg-app-hover"><Maximize2 size={19} /> 全屏</button>
              <button type="button" onClick={replaceActiveVideo} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-app-border bg-app-surface text-xs text-tx-secondary active:bg-app-hover"><RotateCcw size={19} /> 替换</button>
              <button type="button" onClick={() => triggerVideoDownload(activeVideo.video, activeVideo.wrapper)} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-app-border bg-app-surface text-xs text-tx-secondary active:bg-app-hover"><Download size={19} /> 下载</button>
              <button type="button" onClick={() => { void copyText(sourceForVideo(activeVideo.video, activeVideo.wrapper)).then((ok) => toast[ok ? "success" : "error"](ok ? "视频地址已复制" : "复制失败")); }} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-app-border bg-app-surface text-xs text-tx-secondary active:bg-app-hover"><Clipboard size={19} /> 复制地址</button>
              <button type="button" onClick={() => void deleteActiveVideo()} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-red-500/25 bg-red-500/5 text-xs text-red-500 active:bg-red-500/10"><Trash2 size={19} /> 删除</button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
