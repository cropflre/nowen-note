/**
 * Mermaid 预览 React 组件
 *
 * 用途：
 *   - 编辑器内 `CodeBlockView` 当语言 = mermaid 时切换到预览状态时使用
 *   - 分享页 Markdown 路径下的 ReactMarkdown `code` renderer 使用
 *   - 任何需要把一段 mermaid 源码直接显示为 SVG 的地方
 *
 * 行为：
 *   - 异步调用 `renderMermaid`，loading 阶段展示一个轻量占位
 *   - 渲染成功：直接 dangerouslySetInnerHTML 注入 SVG（mermaid 自己出的
 *     SVG 已经是 well-formed，且 securityLevel:'strict' 已经在 lib 里设了）
 *   - 渲染失败：显示红色错误条 + 折叠的原始源码，便于用户修复
 *   - source 变化时 debounce 250ms 再渲染，避免编辑时每个字符都触发
 *   - 主题变更后强制重渲染（订阅 `nowen:theme-change`，由 ThemeProvider 抛出）
 *   - 渲染成功后右上角悬浮"放大"按钮，点击进入全屏 Lightbox 预览，
 *     支持滚轮缩放 / 拖拽平移 / 双击复位 / Esc 关闭，便于查看大图。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { renderMermaid, resetMermaidTheme } from "@/lib/mermaidRenderer";
import { sanitizeSvg } from "@/lib/sanitizeHtml";
import { AlertTriangle, Loader2, Maximize2, Minus, Plus, RotateCcw, X, Copy, Download, Code } from "lucide-react";

import { toast } from "@/lib/toast";
interface MermaidViewProps {
  /** Mermaid 源码 */
  source: string;
  /** debounce 毫秒；编辑器场景需要稍长，渲染场景给 0 */
  debounceMs?: number;
  /** 渲染失败时是否显示折叠的源码（默认 true） */
  showSourceOnError?: boolean;
  className?: string;
}

// 缩放范围与步进；范围给得足够宽，应付内容很多的图
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 6;
const ZOOM_STEP = 0.2;

/**
 * 全屏 Mermaid Lightbox：
 *   - 暗色蒙层 + 居中显示 SVG
 *   - 滚轮缩放（指针位置为锚点）/ 拖拽平移 / 双击复位
 *   - 右上角工具条（缩小、当前缩放、放大、复位、关闭）
 *   - Esc 关闭，点击蒙层空白区域关闭（点击图本身不会关闭）
 */
const MermaidLightbox: React.FC<{ svg: string; onClose: () => void }> = ({ svg, onClose }) => {
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const draggingRef = useRef<{ startX: number; startY: number; baseTx: number; baseTy: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setScale(1);
    setTx(0);
    setTy(0);
  }, []);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") setScale((s) => Math.min(ZOOM_MAX, +(s + ZOOM_STEP).toFixed(2)));
      else if (e.key === "-" || e.key === "_") setScale((s) => Math.max(ZOOM_MIN, +(s - ZOOM_STEP).toFixed(2)));
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, reset]);

  // 打开 Lightbox 期间禁止背景滚动
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // 滚轮缩放：以指针所在位置为锚点缩放，避免居中缩放导致内容跳出视口
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    // 指针相对 stage 中心的偏移
    const px = e.clientX - rect.left - rect.width / 2;
    const py = e.clientY - rect.top - rect.height / 2;
    const delta = -e.deltaY;
    setScale((prev) => {
      const factor = delta > 0 ? 1.1 : 1 / 1.1;
      const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(prev * factor).toFixed(3)));
      // 缩放锚点公式：保持指针下的内容点在屏幕上不变
      // newTx = px - (px - prevTx) * (next/prev)
      setTx((prevTx) => px - (px - prevTx) * (next / prev));
      setTy((prevTy) => py - (py - prevTy) * (next / prev));
      return next;
    });
  }, []);

  // 拖拽平移
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // 只允许鼠标左键 / 触摸 / 笔；忽略中右键
    if (e.button !== 0 && e.pointerType === "mouse") return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    draggingRef.current = { startX: e.clientX, startY: e.clientY, baseTx: tx, baseTy: ty };
  }, [tx, ty]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = draggingRef.current;
    if (!d) return;
    setTx(d.baseTx + (e.clientX - d.startX));
    setTy(d.baseTy + (e.clientY - d.startY));
  }, []);

  const onPointerUp = useCallback(() => {
    draggingRef.current = null;
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/85 backdrop-blur-sm flex items-center justify-center select-none"
      onClick={(e) => {
        // 仅点击蒙层本身才关闭；点到 stage / 工具条不关
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* 顶部工具条 */}
      <div
        className="absolute top-3 right-3 flex items-center gap-1 rounded-lg bg-black/60 border border-white/10 px-1.5 py-1 text-white/90 text-xs"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="p-1.5 rounded hover:bg-white/10 disabled:opacity-40"
          title="缩小 ( - )"
          disabled={scale <= ZOOM_MIN + 0.001}
          onClick={() => setScale((s) => Math.max(ZOOM_MIN, +(s - ZOOM_STEP).toFixed(2)))}
        >
          <Minus size={14} />
        </button>
        <span className="min-w-[3.5rem] text-center tabular-nums">{Math.round(scale * 100)}%</span>
        <button
          className="p-1.5 rounded hover:bg-white/10 disabled:opacity-40"
          title="放大 ( + )"
          disabled={scale >= ZOOM_MAX - 0.001}
          onClick={() => setScale((s) => Math.min(ZOOM_MAX, +(s + ZOOM_STEP).toFixed(2)))}
        >
          <Plus size={14} />
        </button>
        <div className="w-px h-4 bg-white/15 mx-1" />
        <button
          className="p-1.5 rounded hover:bg-white/10"
          title="复位 ( 0 )"
          onClick={reset}
        >
          <RotateCcw size={14} />
        </button>
        <button
          className="p-1.5 rounded hover:bg-white/10"
          title="关闭 ( Esc )"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      {/* 底部提示 */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-[11px] text-white/60 pointer-events-none">
        滚轮缩放 · 拖拽平移 · 双击复位 · Esc 关闭
      </div>

      {/* 舞台：承接缩放 / 拖拽 */}
      <div
        ref={stageRef}
        className="w-full h-full flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing touch-none"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
      >
        <div
          className="mermaid-lightbox-content"
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transformOrigin: "center center",
            transition: draggingRef.current ? "none" : "transform 80ms ease-out",
            // 让内嵌 SVG 拥有充足的展开空间；mermaid 输出 SVG 自带 viewBox，
            // 这里给一个相对宽度的最大值，保证小图不会被强制拉伸到全屏。
            maxWidth: "92vw",
            maxHeight: "88vh",
          }}
          dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }}
        />
      </div>
    </div>,
    document.body
  );
};

export const MermaidView: React.FC<MermaidViewProps> = ({
  source,
  debounceMs = 250,
  showSourceOnError = true,
  className,
}) => {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  // 用计数器代替 timestamp，主题变更时 +1 触发重渲染
  const [themeTick, setThemeTick] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const cancelledRef = useRef(false);

  // 监听 <html> 上 dark/light class 变化（next-themes 切换主题时会改这里）
  // 主题变了就重置 mermaid 配置并触发本组件重渲染。比抛自定义事件更通用：
  // 不依赖 ThemeProvider 主动配合，任何让 documentElement.class 变化的途径
  // （手动 toggle、系统切换、外部插件）都能捕获。
  useEffect(() => {
    if (typeof document === "undefined") return;
    let lastIsDark = document.documentElement.classList.contains("dark");
    const observer = new MutationObserver(() => {
      const isDark = document.documentElement.classList.contains("dark");
      if (isDark !== lastIsDark) {
        lastIsDark = isDark;
        resetMermaidTheme();
        setThemeTick((v) => v + 1);
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    if (!source.trim()) {
      setSvg("");
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      renderMermaid(source).then((res) => {
        if (cancelledRef.current) return;
        setSvg(res.svg);
        setError(res.error);
        setLoading(false);
      });
    }, debounceMs);

    return () => {
      cancelledRef.current = true;
      clearTimeout(timer);
    };
    // themeTick 加入依赖以便主题变更后重新渲染
  }, [source, debounceMs, themeTick]);

  if (loading) {
    return (
      <div className={`mermaid-view-loading flex items-center justify-center py-8 text-tx-tertiary ${className ?? ""}`}>
        <Loader2 size={16} className="animate-spin mr-2" />
        <span className="text-xs">渲染流程图...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`mermaid-view-error rounded-md border border-red-300/60 bg-red-50/60 dark:bg-red-900/20 dark:border-red-700/40 p-3 ${className ?? ""}`}>
        <div className="flex items-start gap-2 text-red-600 dark:text-red-300 text-xs">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium">Mermaid 语法错误</div>
            <div className="mt-1 break-words whitespace-pre-wrap opacity-90">{error}</div>
          </div>
        </div>
        {showSourceOnError && (
          <>
            <details className="mt-2">
              <summary className="text-[11px] cursor-pointer text-tx-tertiary">查看源码</summary>
              <pre className="mt-1 text-[11px] font-mono whitespace-pre-wrap break-words text-tx-secondary opacity-90">
                {source}
              </pre>
            </details>
            <button
              type="button"
              className="mt-2 flex items-center gap-1 px-2 py-1 rounded text-[11px] text-tx-tertiary hover:text-tx-secondary hover:bg-app-hover transition-colors"
              onClick={() => {
                navigator.clipboard.writeText(source).then(() => toast.success("已复制源码")).catch(() => {});
              }}
            >
              <Copy size={11} />
              复制源码
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      <div
        className={`mermaid-view group relative flex justify-center py-2 overflow-auto ${className ?? ""}`}
      >
        {/* 右上角工具组：hover 显示 */}
        <div className="absolute top-1.5 right-1.5 z-10 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            className="p-1.5 rounded-md bg-app-surface/85 border border-app-border text-tx-secondary hover:text-tx-primary hover:bg-app-hover shadow-sm"
            title="复制源码"
            onClick={(e) => {
              e.preventDefault(); e.stopPropagation();
              navigator.clipboard.writeText(source).then(() => toast.success("已复制源码")).catch(() => {});
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Code size={13} />
          </button>
          <button
            type="button"
            className="p-1.5 rounded-md bg-app-surface/85 border border-app-border text-tx-secondary hover:text-tx-primary hover:bg-app-hover shadow-sm"
            title="复制 SVG"
            onClick={(e) => {
              e.preventDefault(); e.stopPropagation();
              navigator.clipboard.writeText(svg).then(() => toast.success("已复制 SVG")).catch(() => {});
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className="p-1.5 rounded-md bg-app-surface/85 border border-app-border text-tx-secondary hover:text-tx-primary hover:bg-app-hover shadow-sm"
            title="下载 SVG"
            onClick={(e) => {
              e.preventDefault(); e.stopPropagation();
              const blob = new Blob([svg], { type: "image/svg+xml" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url; a.download = "mermaid.svg"; a.click();
              URL.revokeObjectURL(url);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Download size={13} />
          </button>
          <button
            type="button"
            className="p-1.5 rounded-md bg-app-surface/85 border border-app-border text-tx-secondary hover:text-tx-primary hover:bg-app-hover shadow-sm"
            title="放大预览"
            onClick={(e) => {
              e.preventDefault(); e.stopPropagation();
              setPreviewOpen(true);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Maximize2 size={13} />
          </button>
        </div>
        <div
          className="mermaid-view-svg w-full flex justify-center"
          // mermaid 出的 svg 已是受控来源，且 securityLevel:'strict' 不会执行任意脚本
          dangerouslySetInnerHTML={{ __html: sanitizeSvg(svg) }}
        />
      </div>
      {previewOpen && svg && (
        <MermaidLightbox svg={svg} onClose={() => setPreviewOpen(false)} />
      )}
    </>
  );
};

export default MermaidView;
