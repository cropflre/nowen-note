import React, { useMemo, useState } from "react";
import { Copy, Download, ExternalLink, Film } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAttachmentVideoRenderSource } from "@/hooks/useAttachmentVideoRenderSource";

interface MarkdownVideoPreviewProps {
  src: string;
  title?: string;
}

type VideoOrientation = "unknown" | "portrait" | "landscape";

function getVideoDisplayStyle(orientation: VideoOrientation): React.CSSProperties {
  if (orientation === "portrait") {
    return { width: "min(320px, calc(100vw - 48px))" };
  }
  if (orientation === "landscape") {
    return { width: "min(640px, 100%)" };
  }
  return { width: "min(480px, 100%)" };
}

export function MarkdownVideoPreview({ src, title }: MarkdownVideoPreviewProps) {
  const [orientation, setOrientation] = useState<VideoOrientation>("unknown");
  const filename = title || "video";
  const media = useAttachmentVideoRenderSource(src);
  const playbackUrl = media.renderSrc;
  const displayStyle = useMemo(() => getVideoDisplayStyle(orientation), [orientation]);

  const copyUrl = async () => {
    const ok = await copyText(src);
    if (ok) toast.success("已复制视频链接");
    else toast.error("复制失败");
  };

  return (
    <figure className="my-4 w-full">
      <div
        className="group overflow-hidden rounded-lg border border-app-border bg-zinc-950 shadow-sm"
        style={displayStyle}
      >
        <div className="flex items-center gap-1 border-b border-white/10 bg-zinc-900 px-2 py-1.5 text-white">
          <Film size={13} className="shrink-0 opacity-80" />
          <span className="min-w-0 flex-1 truncate text-xs text-white/80">{filename}</span>
          <button
            type="button"
            onClick={copyUrl}
            className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
            title="复制链接"
          >
            <Copy size={13} />
          </button>
          <a
            href={playbackUrl || undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
            title="打开"
            aria-disabled={!playbackUrl}
            onClick={(event) => { if (!playbackUrl) event.preventDefault(); }}
          >
            <ExternalLink size={13} />
          </a>
          <a
            href={playbackUrl || undefined}
            download={filename}
            className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
            title="下载"
            aria-disabled={!playbackUrl}
            onClick={(event) => { if (!playbackUrl) event.preventDefault(); }}
          >
            <Download size={13} />
          </a>
        </div>
        <div className="flex max-h-[70vh] min-h-[160px] items-center justify-center bg-black">
          <video
            key={media.renderKey}
            src={playbackUrl || undefined}
            controls
            playsInline
            preload="metadata"
            className={cn(
              "block max-h-[70vh] max-w-full bg-black object-contain",
              orientation === "portrait" ? "aspect-[9/16]" : "aspect-video",
            )}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setOrientation(video.videoHeight > video.videoWidth ? "portrait" : "landscape");
              }
            }}
          >
            您的浏览器不支持 video 标签。
          </video>
          {media.error && <span className="px-3 py-2 text-xs text-amber-300">附件授权失败，请重新打开笔记</span>}
        </div>
      </div>
    </figure>
  );
}
