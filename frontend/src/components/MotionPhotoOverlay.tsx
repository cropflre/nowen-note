import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAttachmentVideoRenderSource } from "@/hooks/useAttachmentVideoRenderSource";
import { getAttachmentAccessSnapshot, getAttachmentRenderSource, subscribeAttachmentAccess } from "@/lib/noteAttachmentAccessBridge";
import { fetchPhotoMediaInfo, photoMediaUrl, type PhotoMediaInfo } from "@/lib/photoMedia";
import { downloadAttachment } from "@/lib/downloadFile";

/** 照片保留现有布局和缩放行为；用户点按标记才加载、播放短视频。 */
export function MotionPhotoOverlay({ source, enabled = true }: { source: string; enabled?: boolean }) {
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [info, setInfo] = useState<{ key: string; value: PhotoMediaInfo } | null>(null);
  const infoCache = useRef<typeof info>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [syncRevision, setSyncRevision] = useState(0);
  const accessRevision = useSyncExternalStore(subscribeAttachmentAccess, getAttachmentAccessSnapshot, getAttachmentAccessSnapshot);
  const infoUrl = enabled ? photoMediaUrl(source, "info") : "";
  const media = info?.key === infoUrl ? info.value : null;
  const videoUrl = media?.hasMotion && playing ? photoMediaUrl(source, "motion") : "";
  const video = useAttachmentVideoRenderSource(videoUrl, { enabled: playing });
  useEffect(() => {
    if (playing && video.error) { setPlaying(false); setFailed(true); }
  }, [playing, video.error]);

  useEffect(() => {
    setPlaying(false);
    setFailed(false);
  }, [infoUrl]);

  useEffect(() => {
    if (!root.current || !enabled) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [enabled, source]);

  useEffect(() => {
    if (!infoUrl || !visible) return;
    if (infoCache.current?.key === infoUrl && infoCache.current.value.motionStatus !== "missing-companion") return;
    const controller = new AbortController();
    fetchPhotoMediaInfo(infoUrl, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) { infoCache.current = { key: infoUrl, value }; setInfo(infoCache.current); }
      })
      .catch(() => { /* 元数据不可用时继续展示静态照片。 */ });
    return () => controller.abort();
  }, [infoUrl, visible, accessRevision, syncRevision]);

  useEffect(() => {
    const refresh = () => setSyncRevision((value) => value + 1);
    window.addEventListener("nowen:sync-snapshot-applied", refresh);
    return () => window.removeEventListener("nowen:sync-snapshot-applied", refresh);
  }, []);

  return (
    <span ref={root} contentEditable={false} className="pointer-events-none absolute inset-0" data-motion-photo={media?.kind}>
      {playing && video.renderSrc && (
        <video
          key={video.renderKey}
          src={video.renderSrc}
          autoPlay
          muted
          playsInline
          controls
          className="pointer-events-auto absolute inset-0 h-full w-full rounded-[inherit] bg-black object-contain"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onEnded={() => setPlaying(false)}
          onError={() => { setPlaying(false); setFailed(true); }}
        />
      )}
      {media?.hasMotion && (
        <button
          type="button"
          className="pointer-events-auto absolute bottom-2 left-2 rounded-full bg-black/65 px-2.5 py-1.5 text-xs leading-none text-white shadow"
          aria-label={playing ? "返回静态照片" : "播放动态照片"}
          onPointerDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); setFailed(false); setPlaying((value) => !value); }}
        >
          ◉ {playing ? "停止" : media.kind === "live-photo" ? "LIVE" : "Motion"}
        </button>
      )}
      {media?.motionStatus === "missing-companion" && (
        <span className="absolute bottom-2 left-2 rounded bg-black/65 px-2 py-1 text-xs leading-normal text-white">LIVE · 缺少配对视频</span>
      )}
      {failed && <span role="status" className="absolute left-2 right-2 top-2 rounded bg-black/70 px-2 py-1 text-xs leading-normal text-white">动态内容暂时无法播放，仍可查看照片或下载原件</span>}
      {media?.hasMotionOriginal && media.canDownloadOriginal !== false && (
        <button type="button" className="pointer-events-auto absolute bottom-2 right-2 rounded bg-black/65 px-2 py-1 text-xs leading-normal text-white"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault(); event.stopPropagation();
            void downloadAttachment(photoMediaUrl(source, "motion-original"), "Live Photo.mov");
          }}>动态原件</button>
      )}
    </span>
  );
}

/** 分享页的只读 HTML 保留原渲染器，照片上的交互通过 Portal 复用。 */
export function SharedPhotoMotionBridge({ rootRef, revision }: { rootRef: RefObject<HTMLDivElement>; revision: string }) {
  const accessRevision = useSyncExternalStore(subscribeAttachmentAccess, getAttachmentAccessSnapshot, getAttachmentAccessSnapshot);
  const [photos, setPhotos] = useState<Array<{ host: HTMLSpanElement; source: string; image: HTMLImageElement }>>([]);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const created: Array<{ host: HTMLSpanElement; image: HTMLImageElement }> = [];
    const next: Array<{ host: HTMLSpanElement; source: string; image: HTMLImageElement }> = [];
    for (const image of root.querySelectorAll<HTMLImageElement>("img")) {
      const source = image.getAttribute("src") || "";
      if (!getAttachmentRenderSource(source).attachmentId) continue;
      const host = document.createElement("span");
      host.style.cssText = "position:relative;display:inline-block;max-width:100%;line-height:0";
      image.parentNode?.insertBefore(host, image);
      host.appendChild(image);
      created.push({ host, image });
      next.push({ host, source, image });
    }
    setPhotos(next);
    return () => {
      for (const { host, image } of created) {
        if (host.parentNode && image.parentNode === host) { host.parentNode.insertBefore(image, host); host.remove(); }
      }
    };
  }, [rootRef, revision, accessRevision]);
  return <>{photos.map(({ host, source, image }, index) => createPortal(<SharedPhotoOverlay source={source} image={image} />, host, `photo-${index}`))}</>;
}

function SharedPhotoOverlay({ source, image }: { source: string; image: HTMLImageElement }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const error = () => setFailed(true);
    const loaded = () => setFailed(false);
    image.addEventListener("error", error); image.addEventListener("load", loaded);
    if (image.complete && image.naturalWidth === 0) error();
    return () => { image.removeEventListener("error", error); image.removeEventListener("load", loaded); };
  }, [image]);
  return failed ? <span role="status" className="absolute inset-0 flex min-h-20 min-w-48 flex-col items-center justify-center gap-2 rounded bg-app-hover p-3 text-xs leading-normal text-tx-tertiary">
    照片暂时无法预览<button type="button" className="underline" onClick={(event) => { event.stopPropagation(); void downloadAttachment(source, image.alt || "photo"); }}>下载原件</button>
  </span> : <MotionPhotoOverlay source={source} />;
}
