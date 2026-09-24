import { api } from "@/lib/api";
import {
  buildMindMapSnapshot,
  mindMapSnapshotToSvg,
  parseMindMapSnapshotData,
} from "@/lib/mindMapSnapshot";
import type { MindMap } from "@/types";

const MINDMAP_HREF_RE = /^mindmap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface MindMapExportMaterializeResult {
  html: string;
  materialized: number;
  failed: number;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseMindMapExportHref(href: string): string | null {
  return MINDMAP_HREF_RE.exec(String(href || "").trim())?.[1].toLowerCase() || null;
}

export function renderMindMapExportFigure(map: Pick<MindMap, "id" | "title" | "data">): string | null {
  const data = parseMindMapSnapshotData(map.data);
  if (!data) return null;

  try {
    const snapshot = buildMindMapSnapshot(data, { maxNodes: 240, padding: 38 });
    const svg = mindMapSnapshotToSvg(snapshot, {
      title: map.title || "思维导图",
      background: "#ffffff",
      className: "nowen-mindmap-export-svg",
    });
    const ratio = snapshot.bounds.height / Math.max(1, snapshot.bounds.width);
    const height = Math.max(180, Math.min(420, Math.round(720 * ratio)));
    const truncated = snapshot.truncated
      ? '<div class="nowen-mindmap-export-warning">节点较多，导出快照仅展示前 240 个节点。</div>'
      : "";

    return [
      '<figure class="nowen-mindmap-export" data-nowen-mindmap-export="static">',
      `<figcaption class="nowen-mindmap-export-title">${escapeHtml(map.title || "思维导图")}</figcaption>`,
      `<div class="nowen-mindmap-export-canvas" style="height:${height}px">${svg}</div>`,
      truncated,
      "</figure>",
    ].join("");
  } catch {
    return null;
  }
}

function renderMissingMindMapExport(): string {
  return [
    '<div class="nowen-mindmap-export nowen-mindmap-export-missing" data-nowen-mindmap-export="missing">',
    '<strong>思维导图</strong>',
    '<span>导图已删除、无权访问或暂时无法生成导出快照。</span>',
    "</div>",
  ].join("");
}

/**
 * Replace live mind-map reference nodes with self-contained SVG snapshots before PDF/image/print
 * rendering. Export failure of one map never aborts the surrounding note.
 */
export async function materializeMindMapEmbedsInHtml(
  html: string,
  resolveMap: (id: string) => Promise<MindMap> = (id) => api.getMindMap(id),
): Promise<MindMapExportMaterializeResult> {
  if (!html || !/data-nowen-block-embed=["']mindmap:/i.test(html)) {
    return { html, materialized: 0, failed: 0 };
  }
  if (typeof document === "undefined") {
    return { html, materialized: 0, failed: 0 };
  }

  const template = document.createElement("template");
  template.innerHTML = html;
  const nodes = Array.from(template.content.querySelectorAll<HTMLElement>("[data-nowen-block-embed]"))
    .filter((node) => parseMindMapExportHref(node.getAttribute("data-nowen-block-embed") || ""));

  const cache = new Map<string, Promise<MindMap>>();
  let materialized = 0;
  let failed = 0;

  for (const node of nodes) {
    const id = parseMindMapExportHref(node.getAttribute("data-nowen-block-embed") || "");
    if (!id) continue;
    let request = cache.get(id);
    if (!request) {
      request = resolveMap(id);
      cache.set(id, request);
    }

    try {
      const map = await request;
      const figure = renderMindMapExportFigure(map);
      if (!figure) throw new Error("INVALID_MINDMAP_DATA");
      const holder = document.createElement("template");
      holder.innerHTML = figure;
      node.replaceWith(holder.content);
      materialized += 1;
    } catch (error) {
      console.warn("[mindmap-export] failed to materialize embedded mind map", { id, error });
      const holder = document.createElement("template");
      holder.innerHTML = renderMissingMindMapExport();
      node.replaceWith(holder.content);
      failed += 1;
    }
  }

  return { html: template.innerHTML, materialized, failed };
}
