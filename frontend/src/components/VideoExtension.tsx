/**
 * VideoExtension —— Tiptap 视频节点（链接接入版）
 * ----------------------------------------------------------------------------
 * 设计目标：
 *   1. 用户在富文本里粘一个视频 URL（直链 mp4 / B 站 / YouTube / 腾讯视频），
 *      自动渲染成对应的 <video> 或 <iframe>。
 *   2. 一个统一的 Tiptap 节点，atom + block + draggable + selectable，
 *      Backspace / Delete 能整体选中并删除。
 *   3. NodeView 在外层包一层 div，叠透明遮罩拦截 iframe 抢焦点，
 *      让节点在编辑器里"像图片一样可点击选中"。
 *   4. parseHTML 同时识别 <iframe> / <video> / <div data-video-platform>，
 *      让剪藏过来的视频内容也能落到这个节点（避免 schema 吞标签）。
 *   5. renderHTML 输出确定性的 HTML，所有导出/分享/历史链路无需额外适配。
 *
 * 当前支持平台：
 *   - 直链文件：.mp4 / .webm / .ogg / .ogv / .m4v
 *   - B 站：bilibili.com/video/BVxxx
 *   - YouTube：youtube.com/watch?v=xxx 或 youtu.be/xxx
 *   - 腾讯视频：v.qq.com/x/cover/.../xxx.html
 *   - 其它（unknown）：当作 iframe 直连，用户自负
 *
 * 后续可扩展：抖音 / 西瓜 / Vimeo / 优酷……扩 `parseVideoUrl` 即可。
 */

import { Node, mergeAttributes } from "@tiptap/core";
import { Node as PMNode } from "@tiptap/pm/model";
import {
  ReactNodeViewRenderer,
  NodeViewWrapper,
  type ReactNodeViewProps,
} from "@tiptap/react";
import React, { useState } from "react";
import { resolveAttachmentUrl } from "@/lib/api";

// ---------------------------------------------------------------------------
// URL 解析：把任意 URL 归一化为 { kind, embedUrl, platform }
// ---------------------------------------------------------------------------

export type VideoKind = "file" | "iframe";
export type VideoPlatform =
  | "file"
  | "bilibili"
  | "youtube"
  | "tencent"
  | "vimeo"
  | "unknown";

export interface ParsedVideo {
  kind: VideoKind;
  /** 实际渲染用的 URL（iframe.src 或 video.src） */
  embedUrl: string;
  platform: VideoPlatform;
}

export interface VideoFileInput {
  previewUrl: string;
  url?: string;
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}

const FILE_EXTS = /\.(mp4|webm|ogg|ogv|m4v|mov)(\?.*)?$/i;

export function parseVideoUrl(rawUrl: string): ParsedVideo | null {
  const url = (rawUrl || "").trim();
  if (!url) return null;

  // SEC-XSS-01-E-RV1: 站内附件相对路径（new URL 无法解析，提前处理）
  if (url.startsWith("/api/attachments/") && FILE_EXTS.test(url)) {
    return { kind: "file", embedUrl: url, platform: "file" };
  }

  // 解析 URL
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }

  // SEC-XSS-01-E-RV1: 协议白名单 — 只允许 http/https
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return null;
  }

  // 直链文件：扩展名识别（协议验证通过后才判断，防止 javascript:xxx.mp4 绕过）
  if (FILE_EXTS.test(url)) {
    return { kind: "file", embedUrl: url, platform: "file" };
  }

  const host = u.hostname.toLowerCase();

  // B 站
  // https://www.bilibili.com/video/BV1xx411c7mD/?xxx
  // https://b23.tv/xxxx (短链不解析，原样 iframe)
  if (host.includes("bilibili.com")) {
    const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    if (m) {
      const id = m[1];
      const isAv = /^av/i.test(id);
      const param = isAv ? `aid=${id.slice(2)}` : `bvid=${id}`;
      // page 参数（分 P 视频）
      const p = u.searchParams.get("p");
      const pageQ = p ? `&page=${encodeURIComponent(p)}` : "";
      return {
        kind: "iframe",
        embedUrl: `https://player.bilibili.com/player.html?${param}${pageQ}&autoplay=0&high_quality=1`,
        platform: "bilibili",
      };
    }
    // player.bilibili.com 直接的 iframe 链接，原样
    if (host.includes("player.bilibili.com")) {
      return { kind: "iframe", embedUrl: url, platform: "bilibili" };
    }
  }

  // YouTube
  if (host.includes("youtube.com") || host.includes("youtu.be")) {
    let videoId = "";
    if (host.includes("youtu.be")) {
      videoId = u.pathname.replace(/^\//, "").split("/")[0];
    } else if (u.pathname.startsWith("/embed/")) {
      videoId = u.pathname.replace(/^\/embed\//, "").split("/")[0];
      // 已经是 embed 链接，原样使用
      if (videoId) return { kind: "iframe", embedUrl: url, platform: "youtube" };
    } else {
      videoId = u.searchParams.get("v") || "";
    }
    if (videoId) {
      return {
        kind: "iframe",
        embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}`,
        platform: "youtube",
      };
    }
  }

  // 腾讯视频
  // https://v.qq.com/x/cover/<cid>/<vid>.html
  // https://v.qq.com/x/page/<vid>.html
  if (host.includes("v.qq.com")) {
    const m =
      u.pathname.match(/\/(?:cover\/[^/]+|page)\/([A-Za-z0-9]+)\.html/) ||
      u.pathname.match(/\/x\/cover\/[^/]+\/([A-Za-z0-9]+)/);
    if (m) {
      return {
        kind: "iframe",
        embedUrl: `https://v.qq.com/txp/iframe/player.html?vid=${m[1]}`,
        platform: "tencent",
      };
    }
  }

  // Vimeo
  // https://vimeo.com/123456789
  if (host.includes("vimeo.com")) {
    const m = u.pathname.match(/\/(\d+)/);
    if (m) {
      return {
        kind: "iframe",
        embedUrl: `https://player.vimeo.com/video/${m[1]}`,
        platform: "vimeo",
      };
    }
  }

  // SEC-XSS-01-E: 未知平台不再降级为 iframe，避免任意 URL 注入
  return null;
}

// ---------------------------------------------------------------------------
// React NodeView：包一层 div，叠透明遮罩拦 iframe 焦点
// ---------------------------------------------------------------------------

export function createVideoFileAttrs(input: VideoFileInput) {
  const previewUrl = input.previewUrl || input.url || "";
  return {
    src: previewUrl,
    platform: "file",
    kind: "file",
    originalUrl: input.url || previewUrl,
    attachmentId: input.attachmentId || "",
    filename: input.filename || "",
    mimeType: input.mimeType || "",
    size: input.size || 0,
  };
}

export function getVideoDisplayStyle(ratio: number | null): {
  isPortrait: boolean;
  wrapper: React.CSSProperties;
  video: React.CSSProperties;
} {
  const safeRatio = typeof ratio === "number" && Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  const isPortrait = safeRatio !== null && safeRatio < 1;
  const aspectRatio = safeRatio ? String(safeRatio) : "16 / 9";
  const maxWidth = safeRatio === null
    ? "min(480px, 100%)"
    : isPortrait
      ? "min(320px, 100%)"
      : "min(640px, 100%)";
  const width = safeRatio === null
    ? "min(480px, 100%)"
    : isPortrait
      ? "min(320px, calc(100vw - 48px))"
      : "min(640px, 100%)";

  return {
    isPortrait,
    wrapper: {
      width: "fit-content",
      maxWidth,
      margin: "12px auto",
      borderRadius: 10,
      overflow: "hidden",
      background: "#000",
    },
    video: {
      width,
      maxWidth: "100%",
      aspectRatio,
      objectFit: "contain",
      background: "#000",
      display: "block",
    },
  };
}

export function shouldStopVideoNodeEvent({ event }: { event: Event }): boolean {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest("video, [data-video-toolbar]"));
}

const VideoNodeView: React.FC<ReactNodeViewProps> = ({ node, selected, deleteNode }) => {
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
  const copyLink = () => {
    const value = originalUrl || src;
    if (!value) return;
    void navigator.clipboard?.writeText(value).catch(() => {});
  };

  // 当节点未被选中时，遮罩拦截鼠标事件，避免 iframe 抢焦点；
  // 选中后允许穿透，让用户能正常点击播放按钮。
  return (
    <NodeViewWrapper
      as="div"
      className="video-node-wrapper"
      data-video-platform={platform}
      data-selected={selected ? "true" : "false"}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...(kind === "file" ? displayStyle.wrapper : {}),
        position: "relative",
        margin: kind === "file" ? displayStyle.wrapper.margin : "12px auto",
        maxWidth: kind === "file" ? displayStyle.wrapper.maxWidth : "720px",
        outline: selected ? "2px solid var(--color-accent-primary, #3b82f6)" : "none",
        borderRadius: kind === "file" ? displayStyle.wrapper.borderRadius : 8,
        overflow: "hidden",
        background: "#000",
      }}
    >
      {kind === "file" ? (
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
            <div
              data-video-toolbar
              contentEditable={false}
              style={videoToolbarOverlayStyle}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {filename}
              </span>
              <button type="button" onClick={copyLink} style={videoToolbarButtonStyle}>复制</button>
              <button type="button" onClick={() => window.open(openUrl, "_blank", "noopener,noreferrer")} style={videoToolbarButtonStyle}>打开</button>
              <a href={downloadUrl} download={filename} style={videoToolbarButtonStyle}>下载</a>
              <button type="button" onClick={deleteNode} style={videoToolbarDangerButtonStyle}>删除</button>
            </div>
          )}
        </>
      ) : (
        <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9" }}>
          <iframe
            src={src}
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: 0 }}
          />
          {/* 未选中时透明遮罩，吃掉点击事件防止 iframe 抢焦点 / 防止误触播放
              选中后移除遮罩，用户即可正常操作 */}
          {!selected && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                cursor: "pointer",
                background: "transparent",
              }}
              title="单击选中，再次单击播放"
            />
          )}
        </div>
      )}
      {/* 平台标识小角标（仅 iframe 类显示），方便用户辨识 */}
      {kind === "iframe" && platform !== "unknown" && (
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

// ---------------------------------------------------------------------------
// Tiptap Node 定义
// ---------------------------------------------------------------------------

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    video: {
      /** 通过 URL 插入视频；URL 解析失败返回 false */
      setVideo: (url: string) => ReturnType;
      /** 通过已上传的附件插入视频预览节点 */
      setVideoFile: (input: VideoFileInput) => ReturnType;
    };
  }
}

export const Video = Node.create({
  name: "video",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      src: { default: "" },
      platform: { default: "unknown" },
      kind: { default: "iframe" },
      /** 原始 URL，用于编辑节点时回填 / 导出 markdown 兜底链接 */
      originalUrl: { default: "" },
      attachmentId: { default: "" },
      filename: { default: "" },
      mimeType: { default: "" },
      size: { default: 0 },
    };
  },

  parseHTML() {
    // 三种来源：
    //  1. 我们自己 renderHTML 输出的 <div data-video-platform>
    //  2. 剪藏过来的 <iframe src="...">（B 站 / YouTube / 腾讯等 embed 链接）
    //  3. 剪藏过来的 <video src="...">
    return [
      {
        tag: "div[data-video-platform]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const src = el.getAttribute("data-src") || "";
          if (!src) return false;
          return {
            src,
            platform: el.getAttribute("data-video-platform") || "unknown",
            kind: (el.getAttribute("data-kind") as VideoKind) || "iframe",
            originalUrl: el.getAttribute("data-original-url") || src,
            attachmentId: el.getAttribute("data-attachment-id") || "",
            filename: el.getAttribute("data-filename") || "",
            mimeType: el.getAttribute("data-mime-type") || "",
            size: Number(el.getAttribute("data-size") || 0),
          };
        },
      },
      {
        tag: "iframe[src]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const src = el.getAttribute("src") || "";
          if (!src) return false;
          // 只接管视频平台 iframe，普通 iframe（地图、表单等）放行给其它处理
          const parsed = parseVideoUrl(src);
          if (!parsed || parsed.platform === "unknown") return false;
          return {
            src: parsed.embedUrl,
            platform: parsed.platform,
            kind: parsed.kind,
            originalUrl: src,
            attachmentId: el.getAttribute("data-attachment-id") || "",
            filename: el.getAttribute("data-filename") || "",
            mimeType: el.getAttribute("data-mime-type") || "",
            size: Number(el.getAttribute("data-size") || 0),
          };
        },
      },
      {
        tag: "video[src]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const src = el.getAttribute("src") || "";
          if (!src) return false;
          return {
            src,
            platform: "file",
            kind: "file",
            originalUrl: src,
          };
        },
      },
      {
        // <video><source src=".."></video> 形式
        tag: "video > source[src]",
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          const src = el.getAttribute("src") || "";
          if (!src) return false;
          return {
            src,
            platform: "file",
            kind: "file",
            originalUrl: src,
            attachmentId: el.getAttribute("data-attachment-id") || "",
            filename: el.getAttribute("data-filename") || "",
            mimeType: el.getAttribute("data-mime-type") || "",
            size: Number(el.getAttribute("data-size") || 0),
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    const src = (node.attrs.src as string) || "";
    const platform = (node.attrs.platform as string) || "unknown";
    const kind = (node.attrs.kind as string) || "iframe";
    const originalUrl = (node.attrs.originalUrl as string) || src;
    const attachmentId = (node.attrs.attachmentId as string) || "";
    const filename = (node.attrs.filename as string) || "";
    const mimeType = (node.attrs.mimeType as string) || "";
    const size = Number(node.attrs.size || 0);

    // 序列化为一个带语义属性的 div，里面挂真正的播放标签。
    // 这样导出 HTML / 分享页 / 历史 JSON → HTML 都是一份可直接渲染的内容；
    // parseHTML 也能从这份 HTML 反向恢复成节点。
    const inner: any =
      kind === "file"
        ? [
            "video",
            {
              src,
              controls: "true",
              preload: "metadata",
              playsinline: "true",
              "data-attachment-id": attachmentId,
              "data-filename": filename,
              "data-mime-type": mimeType,
              "data-size": String(size),
              style: "width:100%;display:block;aspect-ratio:16/9;background:#000;",
            },
          ]
        : [
            "iframe",
            {
              src,
              allow: "autoplay; fullscreen; encrypted-media; picture-in-picture",
              allowfullscreen: "true",
              referrerpolicy: "no-referrer",
              sandbox: "allow-scripts allow-same-origin allow-presentation allow-popups",
              style: "width:100%;aspect-ratio:16/9;border:0;display:block;",
            },
          ];

    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-video-platform": platform,
        "data-kind": kind,
        "data-src": src,
        "data-original-url": originalUrl,
        "data-attachment-id": attachmentId,
        "data-filename": filename,
        "data-mime-type": mimeType,
        "data-size": String(size),
        class: "video-embed",
        style: "margin:12px auto;max-width:720px;border-radius:8px;overflow:hidden;background:#000;",
      }),
      inner,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(VideoNodeView, {
      stopEvent: shouldStopVideoNodeEvent,
    });
  },

  addCommands() {
    return {
      setVideo:
        (url: string) =>
        ({ chain }) => {
          const parsed = parseVideoUrl(url);
          if (!parsed) return false;
          return chain()
            .focus()
            .insertContent({
              type: this.name,
              attrs: {
                src: parsed.embedUrl,
                platform: parsed.platform,
                kind: parsed.kind,
                originalUrl: url,
              },
            })
            .run();
        },
      setVideoFile:
        (input: VideoFileInput) =>
        ({ chain }) => {
          const attrs = createVideoFileAttrs(input);
          if (!attrs.src) return false;
          return chain()
            .focus()
            .insertContent({
              type: this.name,
              attrs,
            })
            .run();
        },
    };
  },
});

// ---------------------------------------------------------------------------
// 工具函数：从 Tiptap JSON 节点构造导出用的 markdown / HTML 片段
// ---------------------------------------------------------------------------

/**
 * 给 contentFormat.ts 的 Turndown 用：
 * 把 video 节点导出为 HTML 块 + 一行兜底链接，保证：
 *   - 支持 HTML 块的 MD 渲染器（含我们自己）能播放
 *   - 不支持的（GitHub README 等）至少看到点击跳转链接
 */
export function videoNodeToMarkdown(attrs: {
  src?: string;
  kind?: VideoKind;
  platform?: VideoPlatform | string;
  originalUrl?: string;
  attachmentId?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
}): string {
  const src = attrs.src || "";
  const kind = attrs.kind || "iframe";
  const platform = attrs.platform || "unknown";
  const originalUrl = attrs.originalUrl || src;
  const attachmentId = attrs.attachmentId || "";
  const filename = attrs.filename || "";
  const mimeType = attrs.mimeType || "";
  const size = attrs.size || 0;
  if (!src) return "";

  const tag =
    kind === "file"
      ? `<video src="${escapeAttr(src)}" controls playsinline preload="metadata" data-attachment-id="${escapeAttr(attachmentId)}" data-filename="${escapeAttr(filename)}" data-mime-type="${escapeAttr(mimeType)}" data-size="${escapeAttr(String(size))}" style="width:100%;display:block;aspect-ratio:16/9;background:#000;"></video>`
      : `<iframe src="${escapeAttr(src)}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" style="width:100%;aspect-ratio:16/9;border:0;display:block;"></iframe>`;

  const wrapper = `<div data-video-platform="${escapeAttr(String(platform))}" data-kind="${escapeAttr(kind)}" data-src="${escapeAttr(src)}" data-original-url="${escapeAttr(originalUrl)}" data-attachment-id="${escapeAttr(attachmentId)}" data-filename="${escapeAttr(filename)}" data-mime-type="${escapeAttr(mimeType)}" data-size="${escapeAttr(String(size))}" class="video-embed" style="margin:12px auto;max-width:720px;border-radius:8px;overflow:hidden;background:#000;">${tag}</div>`;

  // 前后空行让 MD 解析器把它当作 HTML 块；后面追加一行兜底链接（点击跳源页）
  const fallback = `\n\n[🎬 视频链接](${originalUrl})\n`;
  return `\n\n${wrapper}${fallback}\n`;
}

function escapeAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 类型守卫：判断 ProseMirror 节点是否为 video 节点 */
export function isVideoNode(node: PMNode): boolean {
  return node.type.name === "video";
}

const videoToolbarButtonStyle: React.CSSProperties = {
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

const videoToolbarDangerButtonStyle: React.CSSProperties = {
  ...videoToolbarButtonStyle,
  borderColor: "rgba(248,113,113,.55)",
  color: "#fecaca",
};

const videoToolbarOverlayStyle: React.CSSProperties = {
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
