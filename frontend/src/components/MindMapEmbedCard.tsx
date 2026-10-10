import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Edit3,
  ExternalLink,
  Maximize2,
  Minimize2,
  RefreshCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { api } from "@/lib/api";
import type { MindMap } from "@/types";
import {
  buildMindMapSnapshot,
  mindMapSnapshotToSvg,
  parseMindMapSnapshotData,
  type MindMapSnapshot,
} from "@/lib/mindMapSnapshot";
import { pushMindMapAppPath } from "@/lib/mindMapDeepLink";
import {
  DOCUMENT_MINDMAP_CHANGED_EVENT,
  invalidateDocumentMindMapCache,
  loadDocumentMindMap,
  type DocumentMindMapChangedDetail,
} from "@/lib/documentMindMapRuntime";

const EmbeddedMindMapEditor = lazy(() => import("./MindMapEditor"));

/** A document holds only an ID; the original mind map remains the single source of truth. */
const MINDMAP_HREF = /^mindmap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function parseMindMapEmbedHref(href: string): string | null {
  return MINDMAP_HREF.exec(href)?.[1].toLowerCase() || null;
}

export function buildMindMapEmbedMarkdown(id: string): string | null {
  const normalized = parseMindMapEmbedHref(`mindmap:${id}`);
  return normalized ? `![[mindmap:${normalized}]]` : null;
}

function snapshotHeight(snapshot: MindMapSnapshot, fullscreen = false): number {
  if (fullscreen) return Math.max(480, Math.min(1200, snapshot.bounds.height));
  const ratio = snapshot.bounds.height / Math.max(1, snapshot.bounds.width);
  return Math.max(180, Math.min(340, Math.round(760 * ratio)));
}

function SnapshotSurface({
  snapshot,
  title,
  scale,
  fullscreen = false,
}: {
  snapshot: MindMapSnapshot;
  title: string;
  scale: number;
  fullscreen?: boolean;
}) {
  const svg = useMemo(
    () => mindMapSnapshotToSvg(snapshot, { title }),
    [snapshot, title],
  );
  const height = snapshotHeight(snapshot, fullscreen);
  return (
    <div
      className={fullscreen ? "h-full w-full overflow-auto overscroll-contain" : "w-full overflow-auto overscroll-contain"}
      data-nowen-mindmap-static-host="true"
    >
      <div
        className="mx-auto"
        style={{
          width: fullscreen ? `${Math.max(100, Math.round(scale * 100))}%` : `${Math.round(scale * 100)}%`,
          minWidth: fullscreen ? "100%" : "70%",
          height: fullscreen ? "100%" : `${Math.max(140, Math.round(height * scale))}px`,
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

export default function MindMapEmbedCard({ href }: { href: string }) {
  const mapId = parseMindMapEmbedHref(href);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [map, setMap] = useState<MindMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [cacheState, setCacheState] = useState<{ source: "network" | "cache"; cachedAt?: number }>({ source: "network" });
  const [revision, setRevision] = useState(0);
  const [scale, setScale] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setVisible(typeof IntersectionObserver === "undefined");
    setMap(null);
    setError(false);
    setCacheState({ source: "network" });
    setScale(1);
    setFullscreen(false);
    setEditing(false);
    if (!mapId || typeof IntersectionObserver === "undefined") return;
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, [mapId]);

  useEffect(() => {
    if (!mapId || !visible) return;
    let alive = true;
    setLoading(true);
    setError(false);
    loadDocumentMindMap(mapId, { fetcher: (id) => api.getMindMap(id) }).then((result) => {
      if (!alive) return;
      const data = parseMindMapSnapshotData(result.map.data);
      if (!data) {
        setMap(null);
        setError(true);
        return;
      }
      setMap(result.map as MindMap);
      setCacheState({ source: result.source, cachedAt: result.cachedAt });
    }).catch(() => {
      if (alive) {
        setMap(null);
        setError(true);
        setCacheState({ source: "network" });
      }
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [mapId, visible, revision]);

  useEffect(() => {
    if (!visible) return;
    const refresh = () => setRevision((current) => current + 1);
    const onMindMapChanged = (event: Event) => {
      const detail = (event as CustomEvent<DocumentMindMapChangedDetail>).detail;
      if (!mapId || detail?.id !== mapId) return;
      if (detail.kind === "deleted") {
        void invalidateDocumentMindMapCache(mapId);
        setMap(null);
        setError(true);
        setCacheState({ source: "network" });
        return;
      }
      refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener(DOCUMENT_MINDMAP_CHANGED_EVENT, onMindMapChanged as EventListener);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(DOCUMENT_MINDMAP_CHANGED_EVENT, onMindMapChanged as EventListener);
    };
  }, [mapId, visible]);

  useEffect(() => {
    if (!fullscreen) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [fullscreen]);


  useEffect(() => {
    if (!editing) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditing(false);
    };
    const onWorkspaceChanged = () => setEditing(false);
    window.addEventListener("keydown", onEscape);
    window.addEventListener("nowen:workspace-changed", onWorkspaceChanged);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onEscape);
      window.removeEventListener("nowen:workspace-changed", onWorkspaceChanged);
    };
  }, [editing]);

  const snapshot = useMemo(() => {
    if (!map) return null;
    const data = parseMindMapSnapshotData(map.data);
    if (!data) return null;
    try {
      return buildMindMapSnapshot(data);
    } catch {
      return null;
    }
  }, [map]);

  const openEditor = () => {
    if (!map) return;
    // Route is the source of truth; AppLayout will switch the module and MindMapEditor
    // will select the UUID from /mindmaps/:id. Keep the old event out of this path.
    pushMindMapAppPath(map.id);
  };


  const openEmbeddedEditor = () => {
    if (!map || map.canEdit !== true) return;
    setFullscreen(false);
    setEditing(true);
  };

  const toolbar = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        aria-label="缩小导图"
        title="缩小"
        disabled={!snapshot}
        onClick={() => setScale((value) => Math.max(0.7, Math.round((value - 0.1) * 10) / 10))}
        className="rounded p-1 text-tx-secondary hover:bg-app-hover disabled:opacity-40"
      >
        <ZoomOut size={15} />
      </button>
      <button
        type="button"
        aria-label="放大导图"
        title="放大"
        disabled={!snapshot}
        onClick={() => setScale((value) => Math.min(1.8, Math.round((value + 0.1) * 10) / 10))}
        className="rounded p-1 text-tx-secondary hover:bg-app-hover disabled:opacity-40"
      >
        <ZoomIn size={15} />
      </button>
      <button
        type="button"
        aria-label={fullscreen ? "退出导图全屏" : "全屏查看导图"}
        title={fullscreen ? "退出全屏" : "全屏查看"}
        disabled={!snapshot}
        onClick={() => setFullscreen((value) => !value)}
        className="rounded p-1 text-tx-secondary hover:bg-app-hover disabled:opacity-40"
      >
        {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </button>
      <button
        type="button"
        aria-label="刷新导图"
        title="刷新"
        onClick={() => setRevision((value) => value + 1)}
        className="rounded p-1 text-tx-secondary hover:bg-app-hover"
      >
        <RefreshCw size={15} />
      </button>
      {map?.canEdit === true && (
        <button
          type="button"
          onClick={openEmbeddedEditor}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-accent-primary hover:bg-app-hover"
        >
          <Edit3 size={13} />文档内编辑
        </button>
      )}
      {map && (
        <button
          type="button"
          onClick={openEditor}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-accent-primary hover:bg-app-hover"
        >
          <ExternalLink size={13} />打开编辑器
        </button>
      )}
    </div>
  );

  const body = !mapId || error
    ? <p role="status" className="flex items-center gap-2 text-sm text-tx-tertiary"><AlertTriangle size={15} />导图不存在、无权访问或数据无法读取</p>
    : loading || !visible
      ? <p className="text-sm text-tx-tertiary">正在加载思维导图…</p>
      : snapshot
        ? (
          <>
            <SnapshotSurface snapshot={snapshot} title={map?.title || "思维导图"} scale={scale} />
            {snapshot.truncated && (
              <p className="mt-2 text-xs text-amber-600">导图节点较多，正文仅展示前 240 个节点；打开原导图可查看完整内容。</p>
            )}
          </>
        )
        : <p className="text-sm text-tx-tertiary">暂无可渲染的预览内容</p>;

  return (
    <>
      <div
        ref={hostRef}
        contentEditable={false}
        data-nowen-mindmap-embed={mapId || "invalid"}
        className="my-4 min-w-0 max-w-full overflow-hidden rounded-xl border border-app-border bg-app-surface"
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-app-border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-semibold text-tx-primary">{map?.title || "思维导图"}</span>
            {cacheState.source === "cache" && (
              <span
                className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600"
                title={cacheState.cachedAt ? `缓存于 ${new Date(cacheState.cachedAt).toLocaleString()}` : "离线缓存"}
              >
                离线快照
              </span>
            )}
          </div>
          {toolbar}
        </div>
        <div className="min-h-24 max-h-[380px] overflow-auto overscroll-contain px-3 py-3" aria-label="思维导图只读预览">
          {body}
        </div>
        <div className="border-t border-app-border px-3 py-1.5 text-[11px] text-tx-tertiary">
          {cacheState.source === "cache"
            ? "离线只读快照 · 联网后自动刷新 · 删除此块不会删除源文件"
            : "引用原始导图 · SVG 只读快照 · 删除此块不会删除源文件"}
        </div>
      </div>
      {editing && mapId && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-[10030] flex items-center justify-center bg-black/45 p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="在文档中编辑思维导图"
          data-document-mindmap-editor-dialog="true"
        >
          <div className="h-full w-full overflow-hidden bg-app-bg shadow-2xl sm:h-[min(88vh,900px)] sm:max-w-[1500px] sm:rounded-2xl sm:border sm:border-app-border">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-tx-tertiary">
                  正在加载思维导图编辑器…
                </div>
              }
            >
              <EmbeddedMindMapEditor
                embeddedMode
                embeddedMindMapId={mapId}
                onRequestClose={() => {
                  setEditing(false);
                  setRevision((value) => value + 1);
                }}
                onSaved={(updated) => {
                  setMap(updated);
                  setCacheState({ source: "network" });
                }}
              />
            </Suspense>
          </div>
        </div>,
        document.body,
      )}
      {fullscreen && snapshot && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[10020] flex flex-col bg-app-bg/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="思维导图全屏预览">
          <div className="flex items-center justify-between gap-3 border-b border-app-border bg-app-surface px-4 py-3 shadow-sm">
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-tx-primary">{map?.title || "思维导图"}</div>
              <div className="text-[11px] text-tx-tertiary">只读预览 · Esc 退出</div>
            </div>
            <div className="flex items-center gap-2">
              {toolbar}
              <button type="button" onClick={() => setFullscreen(false)} className="rounded-lg border border-app-border px-3 py-1.5 text-xs text-tx-primary hover:bg-app-hover">
                完成
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 p-3 sm:p-5">
            <SnapshotSurface snapshot={snapshot} title={map?.title || "思维导图"} scale={scale} fullscreen />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
