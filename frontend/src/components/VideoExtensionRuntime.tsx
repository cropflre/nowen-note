import React, { useCallback, useState } from "react";
import {
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
} from "@tiptap/react";
import { resolveAttachmentUrl } from "@/lib/api";
import { useLazyNodeView } from "@/hooks/useLazyNodeView";
import {
  Video as BaseVideo,
  getVideoDisplayStyle,
  shouldStopVideoNodeEvent,
  type VideoKind,
  type VideoPlatform,
} from "./VideoExtension";

export * from "./VideoExtension";

const toolbarButtonStyle: React.CSSProperties = {
  border: "1px solid rgba(255,255,255,.25)",
  borderRadius: 4,
  padding: "1px 6px",
  color: "#fff",
  background: "rgba(255,255,255,.08)",
  cursor: "pointer",
  fontSize: 11,
  textDecoration: "none",
  lineHeight: "18px",
};

const toolbarDangerButtonStyle: React.CSSProperties = {
  ...toolbarButtonStyle,
  borderColor: "rgba(248,113,113,.55)",
  color: "#fecaca",
};

const toolbarOverlayStyle: React.CSSProperties = {
  position: "absolute",
  top: 6,
  left: 6,
  right: 6,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 6px",
  color: "#fff",
  background: "rgba(0,0,0,.62)",
  borderRadius: 6,
  fontSize: 11,
  backdropFilter: "blur(6px)",
};

function DeferredVideoPlaceholder({
  kind,
  platform,
  requiresInteraction,
  onLoad,
}: {
  kind: VideoKind;
  platform: VideoPlatform;
  requiresInteraction: boolean;
  onLoad: () => void;
}) {
  const label = kind === "file" ? "视频" : `${platform === "unknown" ? "网页" : platform} 嵌入内容`;
  return (
    <div
      contentEditable={false}
      data-video-placeholder=""
      style={{
        width: "100%",
        minHeight: 180,
        aspectRatio: "16 / 9",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 16,
        color: "rgba(255,255,255,.76)",
        background: "linear-gradient(135deg, #111827, #1f2937)",
        textAlign: "center",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600 }}>{label}暂未加载</span>
      <span style={{ fontSize: 11, opacity: 0.72 }}>
        {requiresInteraction
          ? "轻量编辑模式下需手动加载，正文编辑与保存不受影响"
          : "滚动到附近后会自动加载"}
      </span>
      <button
        type="button"
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onLoad();
        }}
        style={{
          marginTop: 2,
          border: "1px solid rgba(255,255,255,.28)",
          borderRadius: 7,
          padding: "5px 10px",
          color: "#fff",
          background: "rgba(255,255,255,.10)",
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        立即加载
      </button>
    </div>
  );
}

export const LazyVideoNodeView: React.FC<ReactNodeViewProps> = ({
  node,
  selected,
  deleteNode,
}) => {
  const src: string = node.attrs.src || "";
  const platform: VideoPlatform = node.attrs.platform || "unknown";
  const kind: VideoKind = node.attrs.kind || "iframe";
  const [ratio, setRatio] = useState<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const displayStyle = getVideoDisplayStyle(ratio);
  const displaySrc = kind === "file" ? resolveAttachmentUrl(src) : src;
  const filename: string = node.attrs.filename || "视频";
  const originalUrl: string = node.attrs.originalUrl || src;
  const openUrl = resolveAttachmentUrl(originalUrl || src);
  const downloadUrl = `${openUrl}${openUrl.includes("?") ? "&" : "?"}download=1`;
  const {
    lazyEnabled,
    requiresInteraction,
    shouldRenderHeavyContent,
    observeRef,
    requestRender,
  } = useLazyNodeView<HTMLDivElement>({
    forceMount: selected,
    rootMargin: "1200px 0px",
    manualInLightweight: true,
  });
  const setWrapperRef = useCallback((element: HTMLDivElement | null) => {
    observeRef(element);
  }, [observeRef]);

  const copyLink = () => {
    const value = originalUrl || src;
    if (!value) return;
    void navigator.clipboard?.writeText(value).catch(() => {});
  };

  return (
    <NodeViewWrapper
      as="div"
      ref={setWrapperRef}
      className="video-node-wrapper"
      data-video-platform={platform}
      data-selected={selected ? "true" : "false"}
      data-heavy-node-state={shouldRenderHeavyContent ? "mounted" : "deferred"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...(kind === "file" ? displayStyle.wrapper : {}),
        position: "relative",
        width: kind === "file" ? displayStyle.wrapper.width : "100%",
        margin: kind === "file" ? displayStyle.wrapper.margin : "12px auto",
        maxWidth: kind === "file" ? displayStyle.wrapper.maxWidth : "720px",
        outline: selected ? "2px solid var(--color-accent-primary, #3b82f6)" : "none",
        borderRadius: kind === "file" ? displayStyle.wrapper.borderRadius : 8,
        overflow: "hidden",
        background: "#000",
        contentVisibility: lazyEnabled ? "auto" : undefined,
        containIntrinsicSize: lazyEnabled ? "auto 360px" : undefined,
      }}
    >
      {!shouldRenderHeavyContent ? (
        <DeferredVideoPlaceholder
          kind={kind}
          platform={platform}
          requiresInteraction={requiresInteraction}
          onLoad={requestRender}
        />
      ) : kind === "file" ? (
        <>
          <video
            src={displaySrc}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth && video.videoHeight) {
                setRatio(video.videoWidth / video.videoHeight);
              }
            }}
            style={displayStyle.video}
          >
            您的浏览器不支持 video 标签。
          </video>
          {(hovered || selected) && (
            <div data-video-toolbar contentEditable={false} style={toolbarOverlayStyle}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {filename}
              </span>
              <button type="button" onClick={copyLink} style={toolbarButtonStyle}>复制</button>
              <button type="button" onClick={() => window.open(openUrl, "_blank", "noopener,noreferrer")} style={toolbarButtonStyle}>打开</button>
              <a href={downloadUrl} download={filename} style={toolbarButtonStyle}>下载</a>
              <button type="button" onClick={deleteNode} style={toolbarDangerButtonStyle}>删除</button>
            </div>
          )}
        </>
      ) : (
        <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9" }}>
          <iframe
            src={src}
            loading="lazy"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          />
          {!selected && (
            <div
              style={{ position: "absolute", inset: 0, cursor: "pointer", background: "transparent" }}
              title="单击选中，再次单击播放"
            />
          )}
        </div>
      )}

      {shouldRenderHeavyContent && kind === "iframe" && platform !== "unknown" && (
        <div
          contentEditable={false}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            padding: "2px 8px",
            fontSize: 11,
            color: "#fff",
            background: "rgba(0,0,0,.55)",
            borderRadius: 4,
            pointerEvents: "none",
            textTransform: "capitalize",
          }}
        >
          {platform}
        </div>
      )}
    </NodeViewWrapper>
  );
};

/** Keep the original schema, commands and serializers; replace only the expensive NodeView. */
export const Video = BaseVideo.extend({
  addNodeView() {
    return ReactNodeViewRenderer(LazyVideoNodeView, {
      stopEvent: shouldStopVideoNodeEvent,
    });
  },
});
