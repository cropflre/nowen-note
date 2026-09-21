import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, RefreshCw, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "@/lib/api";
import type { MindMap, MindMapNode } from "@/types";

/** A document holds only an ID; the original mind map remains the single source of truth. */
const MINDMAP_HREF = /^mindmap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const MAX_PREVIEW_NODES = 120;
const MAX_PREVIEW_DEPTH = 12;

export function parseMindMapEmbedHref(href: string): string | null {
  return MINDMAP_HREF.exec(href)?.[1].toLowerCase() || null;
}

export function buildMindMapEmbedMarkdown(id: string): string | null {
  const normalized = parseMindMapEmbedHref(`mindmap:${id}`);
  return normalized ? `![[mindmap:${normalized}]]` : null;
}

function PreviewTree({ node, depth, budget }: { node: MindMapNode; depth: number; budget: { remaining: number } }) {
  if (budget.remaining <= 0 || depth > MAX_PREVIEW_DEPTH) return null;
  budget.remaining -= 1;
  return (
    <li className="min-w-0 list-none border-l border-accent-primary/25 pl-3 first:border-accent-primary/50">
      <span className="my-1 inline-block max-w-full break-words rounded-lg border border-app-border bg-app-surface px-3 py-1.5 text-tx-primary shadow-sm">
        {String(node.text || "未命名主题")}
      </span>
      {Array.isArray(node.children) && node.children.length > 0 && depth < MAX_PREVIEW_DEPTH && budget.remaining > 0 && (
        <ul className="ml-2 space-y-1 border-l border-app-border pl-2">
          {node.children.map((child, index) => <PreviewTree key={`${child.id || depth}-${index}`} node={child} depth={depth + 1} budget={budget} />)}
        </ul>
      )}
    </li>
  );
}

export default function MindMapEmbedCard({ href }: { href: string }) {
  const mapId = parseMindMapEmbedHref(href);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const [map, setMap] = useState<MindMap | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    setVisible(typeof IntersectionObserver === "undefined");
    setMap(null);
    setError(false);
    setScale(1);
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
    api.getMindMap(mapId).then((result) => {
      if (!alive) return;
      try {
        const data = JSON.parse(result.data);
        if (!data || !data.root || !Array.isArray(data.root.children)) throw new Error("Invalid mind map");
        setMap(result);
      } catch {
        setMap(null);
        setError(true);
      }
    }).catch(() => {
      if (alive) { setMap(null); setError(true); }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [mapId, visible, revision]);

  useEffect(() => {
    if (!visible) return;
    const refresh = () => setRevision((current) => current + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [visible]);

  let root: MindMapNode | null = null;
  if (map) {
    try { root = (JSON.parse(map.data) as { root: MindMapNode }).root; } catch { root = null; }
  }
  const budget = { remaining: MAX_PREVIEW_NODES };

  return (
    <div ref={hostRef} contentEditable={false} data-nowen-mindmap-embed={mapId || "invalid"} className="my-4 min-w-0 max-w-full overflow-hidden rounded-xl border border-app-border bg-app-surface">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-app-border px-3 py-2">
        <span className="min-w-0 truncate text-sm font-semibold text-tx-primary">{map?.title || "思维导图"}</span>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="缩小导图" title="缩小" disabled={!root} onClick={() => setScale((v) => Math.max(0.7, Math.round((v - 0.1) * 10) / 10))} className="rounded p-1 text-tx-secondary hover:bg-app-hover disabled:opacity-40"><ZoomOut size={15} /></button>
          <button type="button" aria-label="放大导图" title="放大" disabled={!root} onClick={() => setScale((v) => Math.min(1.6, Math.round((v + 0.1) * 10) / 10))} className="rounded p-1 text-tx-secondary hover:bg-app-hover disabled:opacity-40"><ZoomIn size={15} /></button>
          <button type="button" aria-label="刷新导图" title="刷新" onClick={() => setRevision((v) => v + 1)} className="rounded p-1 text-tx-secondary hover:bg-app-hover"><RefreshCw size={15} /></button>
          {map && <button type="button" onClick={() => {
            sessionStorage.setItem("pendingOpenMindMapId", map.id);
            window.dispatchEvent(new CustomEvent("nowen:request-open-embedded-mindmap", { detail: { id: map.id } }));
          }} className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-accent-primary hover:bg-app-hover"><ExternalLink size={13} />打开编辑</button>}
        </div>
      </div>
      <div className="min-h-24 max-h-[340px] overflow-auto overscroll-contain px-3 py-3" aria-label="思维导图只读预览">
        {!mapId || error ? <p role="status" className="flex items-center gap-2 text-sm text-tx-tertiary"><AlertTriangle size={15} />导图不存在、无权访问或数据无法读取</p>
          : loading || !visible ? <p className="text-sm text-tx-tertiary">正在加载思维导图…</p>
          : root ? <ul className="m-0 min-w-0 p-0 text-sm" style={{ fontSize: `${scale}em` }}><PreviewTree node={root} depth={0} budget={budget} /></ul>
          : <p className="text-sm text-tx-tertiary">暂无预览内容</p>}
      </div>
      <div className="border-t border-app-border px-3 py-1.5 text-[11px] text-tx-tertiary">引用原始导图 · 预览只读 · 删除此块不会删除源文件</div>
    </div>
  );
}
