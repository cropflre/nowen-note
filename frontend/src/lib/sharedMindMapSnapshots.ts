import type { SharedMindMapSnapshot } from "@/types";
import {
  buildMindMapSnapshot,
  mindMapSnapshotToSvg,
  parseMindMapSnapshotData,
} from "@/lib/mindMapSnapshot";

const MINDMAP_ID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARKDOWN_EMBED_RE = new RegExp(`!\\[\\[mindmap:(${MINDMAP_ID_PATTERN})\\]\\]`, "gi");
const HREF_RE = new RegExp(`^mindmap:(${MINDMAP_ID_PATTERN})$`, "i");

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function parseSharedMindMapHref(href: string): string | null {
  return HREF_RE.exec(String(href || "").trim())?.[1].toLowerCase() || null;
}

export function renderSharedMindMapPlaceholder(href: string): string {
  const id = parseSharedMindMapHref(href);
  return id
    ? `<div class="shared-mindmap-block" data-shared-mindmap-id="${id}"><span>正在加载思维导图…</span></div>`
    : "";
}

export function preprocessSharedMindMapMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  const fenced: string[] = [];
  let text = markdown.replace(/\`\`\`[\s\S]*?\`\`\`|~~~[\s\S]*?~~~/g, (match) => {
    const index = fenced.push(match) - 1;
    return `\u0000NOWEN_SHARED_MINDMAP_CODE_${index}\u0000`;
  });

  MARKDOWN_EMBED_RE.lastIndex = 0;
  text = text.replace(MARKDOWN_EMBED_RE, (_match, id) => (
    `\n\n<div class="shared-mindmap-block" data-shared-mindmap-id="${String(id).toLowerCase()}"><span>正在加载思维导图…</span></div>\n\n`
  ));

  return text.replace(/\u0000NOWEN_SHARED_MINDMAP_CODE_(\d+)\u0000/g, (_match, index) => (
    fenced[Number(index)] || ""
  ));
}

function renderUnavailable(): string {
  return [
    '<div style="border:1px solid rgba(148,163,184,.35);border-radius:12px;padding:14px;background:rgba(148,163,184,.06)">',
    '<div style="font-size:13px;font-weight:600;margin-bottom:4px">思维导图</div>',
    '<div style="font-size:12px;opacity:.7">该导图未随当前分享公开、已删除，或分享作者已失去访问权限。</div>',
    "</div>",
  ].join("");
}

export function renderSharedMindMapSnapshot(snapshot: SharedMindMapSnapshot): string {
  const data = parseMindMapSnapshotData(snapshot.data);
  if (!data) return renderUnavailable();

  try {
    const layout = buildMindMapSnapshot(data, { maxNodes: 240, padding: 38 });
    const svg = mindMapSnapshotToSvg(layout, { title: snapshot.title });
    const ratio = layout.bounds.height / Math.max(1, layout.bounds.width);
    const height = Math.max(180, Math.min(380, Math.round(760 * ratio)));
    const truncated = layout.truncated
      ? '<div style="font-size:11px;color:#b45309;margin-top:6px">节点较多，分享页仅展示前 240 个节点。</div>'
      : "";
    return [
      '<div style="border:1px solid rgba(148,163,184,.35);border-radius:12px;overflow:hidden;background:rgba(255,255,255,.02)">',
      `<div style="padding:9px 12px;border-bottom:1px solid rgba(148,163,184,.25);font-size:13px;font-weight:600">${escapeHtml(snapshot.title || "思维导图")}</div>`,
      `<div style="height:${height}px;min-height:180px;overflow:auto;padding:10px">${svg}</div>`,
      truncated,
      '<div style="padding:7px 12px;border-top:1px solid rgba(148,163,184,.25);font-size:11px;opacity:.65">共享只读快照 · 不暴露私有导图接口</div>',
      "</div>",
    ].join("");
  } catch {
    return renderUnavailable();
  }
}

export function hydrateSharedMindMapPlaceholders(
  root: HTMLElement,
  snapshots: Record<string, SharedMindMapSnapshot> | undefined,
): number {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(".shared-mindmap-block[data-shared-mindmap-id]:not([data-rendered])"),
  );

  for (const block of blocks) {
    const id = String(block.getAttribute("data-shared-mindmap-id") || "").toLowerCase();
    block.setAttribute("data-rendered", "1");
    const snapshot = snapshots?.[id];
    block.innerHTML = snapshot ? renderSharedMindMapSnapshot(snapshot) : renderUnavailable();
  }

  return blocks.length;
}
