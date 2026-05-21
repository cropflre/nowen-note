// AttachmentMediaPreview.tsx —— 视频/音频内联预览
//
// 浏览器原生支持范围：
//   - video/mp4 (H.264 + AAC)、video/webm、video/ogg
//   - audio/mpeg、audio/wav、audio/ogg、audio/webm、audio/aac、audio/flac (部分浏览器)
//
// 不支持的格式（avi/mkv/flv/mov-HEVC 等）：
//   - 不引入 ffmpeg.wasm（25MB wasm，移动端会爆）
//   - 不引入 video.js（增加 ~150KB）
//   - 直接给个友好提示 + 下载按钮，让用户用本地播放器
//
// 关键：URL 必须带 ?inline=1，否则后端会带 Content-Disposition: attachment，
// 浏览器会触发下载而不是渲染 <video>/<audio>。
import React, { useMemo } from "react";
import { Download, Film } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  url: string;
  filename: string;
  mimeType: string;
  /** 'video' | 'audio'。由外层判断后传入，组件本身不再做 mime 嗅探 */
  kind: "video" | "audio";
  heightClass?: string;
}

// 浏览器原生（绝大多数环境）能解码的 MIME / 扩展名集合。
// 列表保守一点，宁可降级到"下载提示"也不要黑屏。
const NATIVE_VIDEO_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
]);
const NATIVE_VIDEO_EXTS = new Set(["mp4", "webm", "ogg", "ogv", "m4v"]);

const NATIVE_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
  "audio/mp4",
  "audio/flac",
]);
const NATIVE_AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "webm", "aac", "m4a", "flac"]);

function getExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx < 0) return "";
  return filename.slice(idx + 1).toLowerCase();
}

function isNativelySupported(mime: string, filename: string, kind: "video" | "audio"): boolean {
  const m = mime.toLowerCase();
  const ext = getExt(filename);
  if (kind === "video") {
    return NATIVE_VIDEO_MIMES.has(m) || NATIVE_VIDEO_EXTS.has(ext);
  }
  return NATIVE_AUDIO_MIMES.has(m) || NATIVE_AUDIO_EXTS.has(ext);
}

export default function AttachmentMediaPreview({
  url,
  filename,
  mimeType,
  kind,
  heightClass,
}: Props) {
  // 必须带 inline=1，否则后端会强制 Content-Disposition: attachment
  const inlineUrl = useMemo(() => {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}inline=1`;
  }, [url]);

  const supported = isNativelySupported(mimeType, filename, kind);
  const minH = heightClass ?? (kind === "video" ? "min-h-[400px]" : "min-h-[120px]");

  if (!supported) {
    return (
      <div className={cn("relative w-full flex flex-col items-center justify-center gap-2 text-tx-tertiary px-6 text-center py-8", minH)}>
        <Film size={20} className="text-tx-tertiary" />
        <div className="text-xs">浏览器不支持该格式的内联预览</div>
        <div className="text-[10px] text-tx-tertiary/70">
          {mimeType || "未知类型"} · 请下载后用本地播放器打开
        </div>
        <a
          href={url}
          download={filename}
          className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] bg-app-surface border border-app-border hover:bg-app-hover text-tx-primary"
        >
          <Download size={11} />
          下载原文件
        </a>
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className={cn("relative w-full bg-zinc-950 flex items-center justify-center", minH)}>
        <video
          src={inlineUrl}
          controls
          preload="metadata"
          className="max-w-full max-h-full"
          // crossOrigin 不设：附件下载是同源 /api/attachments/<id>，浏览器自动带 cookie 即可
        >
          您的浏览器不支持 video 标签。
        </video>
      </div>
    );
  }

  // audio
  return (
    <div className="w-full p-4 flex flex-col items-center gap-2">
      <div className="text-xs text-tx-secondary truncate max-w-full">{filename}</div>
      <audio src={inlineUrl} controls preload="metadata" className="w-full">
        您的浏览器不支持 audio 标签。
      </audio>
    </div>
  );
}
