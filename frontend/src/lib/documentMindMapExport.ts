import { api } from "@/lib/api";
import type { MindMap } from "@/types";
import {
  buildMindMapSnapshot,
  mindMapSnapshotToSvg,
  parseMindMapSnapshotData,
} from "@/lib/mindMapSnapshot";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EMBED_RE = new RegExp(
  `<div\\b([^>]*?)data-nowen-block-embed=(["'])mindmap:(${ID})\\2([^>]*)>[\\s\\S]*?<\\/div>`,
  "gi",
);
const MAX_EXPORT_MINDMAPS = 20;
const MAX_CONCURRENCY = 4;

export type MindMapExportLoader = (id: string) => Promise<Pick<MindMap, "id" | "title" | "data" | "updatedAt">>;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function extractMindMapEmbedIdsFromHtml(html: string): string[] {
  const ids: string[] = [];
  EMBED_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EMBED_RE.exec(html || "")) !== null) {
    const id = String(match[3] || "").toLowerCase();
    if (id && !ids.includes(id)) ids.push(id);
    if (ids.length >= MAX_EXPORT_MINDMAPS) break;
  }
  return ids;
}

function renderUnavailable(id: string): string {
  return [
    `<section data-nowen-mindmap-export="${escapeHtml(id)}" data-nowen-mindmap-export-unavailable="1" style="margin:16px 0;border:1px solid #d0d7de;border-radius:12px;padding:14px;background:#f6f8fa;break-inside:avoid">`,
    '<div style="font-size:13px;font-weight:600;color:#24292f;margin-bottom:4px">思维导图</div>',
    '<div style="font-size:12px;color:#6e7781">导图已删除、无权访问或暂时无法生成静态快照。</div>',
    "</section>",
  ].join("");
}

export function renderMindMapExportSnapshot(
  map: Pick<MindMap, "id" | "title" | "data" | "updatedAt">,
): string {
  const data = parseMindMapSnapshotData(map.data);
  if (!data) return renderUnavailable(map.id);

  try {
    const snapshot = buildMindMapSnapshot(data, { maxNodes: 240, padding: 38 });
    const svg = mindMapSnapshotToSvg(snapshot, {
      title: map.title || "思维导图",
      background: "#ffffff",
      className: "nowen-mindmap-export-svg",
    });
    const ratio = snapshot.bounds.height / Math.max(1, snapshot.bounds.width);
    const height = Math.max(180, Math.min(420, Math.round(760 * ratio)));
    const truncated = snapshot.truncated
      ? '<div style="font-size:11px;color:#b45309;padding:0 12px 8px">节点较多，导出快照仅展示前 240 个节点。</div>'
      : "";
    return [
      `<section data-nowen-mindmap-export="${escapeHtml(map.id)}" style="margin:16px 0;border:1px solid #d0d7de;border-radius:12px;overflow:hidden;background:#fff;break-inside:avoid;page-break-inside:avoid">`,
      `<div style="padding:9px 12px;border-bottom:1px solid #d8dee4;font-size:13px;font-weight:600;color:#24292f">${escapeHtml(map.title || "思维导图")}</div>`,
      `<div style="height:${height}px;min-height:180px;overflow:hidden;padding:10px">${svg}</div>`,
      truncated,
      '<div style="padding:7px 12px;border-top:1px solid #d8dee4;font-size:11px;color:#6e7781">思维导图静态快照 · 导出后不再与源导图联动</div>',
      "</section>",
    ].join("");
  } catch {
    return renderUnavailable(map.id);
  }
}

/**
 * 打印/PDF/图片导出使用静态快照，而不是把 mindmap:<uuid> 或私有 API 写入产物。
 * 同一导图在一篇文档内只请求一次；失败时 fail closed 为可读占位。
 */
export async function hydrateMindMapEmbedsForExport(
  html: string,
  loader: MindMapExportLoader = (id) => api.getMindMap(id),
): Promise<string> {
  if (!html || !/data-nowen-block-embed=["']mindmap:/i.test(html)) return html;

  const ids = extractMindMapEmbedIdsFromHtml(html);
  const rendered = new Map<string, string>();
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      try {
        const map = await loader(id);
        rendered.set(id, renderMindMapExportSnapshot(map));
      } catch {
        rendered.set(id, renderUnavailable(id));
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, Math.max(1, ids.length)) }, () => worker()),
  );

  EMBED_RE.lastIndex = 0;
  return html.replace(EMBED_RE, (_full, _before, _quote, rawId) => {
    const id = String(rawId || "").toLowerCase();
    return rendered.get(id) || renderUnavailable(id);
  });
}
