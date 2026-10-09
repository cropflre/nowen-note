/**
 * Tiptap JSON Schema 修复工具
 *
 * 背景：历史导入路径（早期 docx/md 导入）可能向数据库写入了 schema 不合法的
 * Tiptap JSON——典型如表格节点 content 不满足 contentMatch（缺 tableRow，
 * 或 tableRow 内出现非 tableCell/tableHeader 的子节点等）。这种脏 JSON 通过
 * `editor.commands.setContent(json)` 加载时不会立即报错，但**任何后续
 * transaction**（光标移动、SearchReplacePanel 装饰、保存重绘等）都会触发
 * `Called contentMatchAt on a node with invalid content`，整个编辑器崩溃。
 *
 * 修复思路：JSON → HTML → JSON 做一次 round-trip。
 *   - JSON → HTML（generateHTML）：用 DOMSerializer.toDOM，按每个节点自己的
 *     `toDOM` 规则输出**结构良好的 HTML**（即使原 doc 的 contentMatch 不合
 *     法，单节点 toDOM 仍能拼出 <table><tr><td>... 这种合法 HTML 结构）。
 *   - HTML → JSON（generateJSON）：parseHTML 走 ProseMirror 的 schema-aware
 *     parser，自动丢非法内容、补必需包裹，但不创建 EditorView。
 *
 * 临时解析时不能保留真实图片 URL：即使不挂载视图，DOMSerializer / HTML 解析
 * 生成 img 元素也可能触发未授权网络请求。使用无网络的 data: 占位地址完成
 * round-trip，再在返回 JSON 中恢复原 src，避免覆盖持久化附件引用。
 *
 * 注意：直接 `new Editor({ content: dirtyJson })` 没用——Tiptap 的
 * createNodeFromContent 对 JSON 走的是 `schema.nodeFromJSON`，纯反序列化、
 * 不做 contentMatch 校验，dirty in / dirty out。必须经过 HTML 中转。
 *
 * 与 importService.repairHtmlViaHeadlessEditor 同思路；两者复用同一份
 * tiptapExtensions（schema 真理），避免修复后的 doc 与正主编辑器 schema 漂移。
 */
import { generateHTML, generateJSON } from "@tiptap/core";
import { tiptapExtensions } from "./importService";

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

/** Only the transient schema-repair copy contains these network-free image URLs. */
function maskImageSources(json: unknown): { sanitized: unknown; sources: Map<string, string> } {
  const sources = new Map<string, string>();
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (!value || typeof value !== "object") return value;

    const node = value as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...node };
    if (node.type === "image" && node.attrs && typeof node.attrs === "object") {
      const attrs = { ...(node.attrs as Record<string, unknown>) };
      if (typeof attrs.src === "string" && attrs.src) {
        const placeholder = `data:,nowen-schema-repair-image-${sources.size}`;
        sources.set(placeholder, attrs.src);
        attrs.src = placeholder;
      }
      copy.attrs = attrs;
    }
    if (Array.isArray(node.content)) copy.content = node.content.map(rewrite);
    return copy;
  };
  return { sanitized: rewrite(json), sources };
}

function restoreImageSources(value: unknown, sources: Map<string, string>): unknown {
  if (Array.isArray(value)) return value.map((node) => restoreImageSources(node, sources));
  if (!value || typeof value !== "object") return value;

  const node = value as Record<string, unknown>;
  const copy: Record<string, unknown> = { ...node };
  if (node.type === "image" && node.attrs && typeof node.attrs === "object") {
    const attrs = { ...(node.attrs as Record<string, unknown>) };
    if (typeof attrs.src === "string" && sources.has(attrs.src)) {
      attrs.src = sources.get(attrs.src)!;
      copy.attrs = attrs;
    }
  }
  if (Array.isArray(node.content)) copy.content = node.content.map((child) => restoreImageSources(child, sources));
  return copy;
}

/**
 * 把可能脏的 Tiptap JSON 修复成合 schema 的 JSON。
 * 失败时返回一个空 doc，避免上层把脏 JSON 直接喂进真编辑器导致崩溃。
 */
export function repairTiptapJson(json: unknown): unknown {
  if (!json || typeof json !== "object") return EMPTY_DOC;

  // ─── 诊断日志（A 阶段）────────────────────────────────────────────
  // 把每次进入 repair 的 input 暴露到 window，崩溃时方便用户直接从 console
  // 拿到原始脏 JSON 贴给我；同时打概要日志让我能在不读取整个 doc 的情况下
  // 判断 round-trip 路径是否走到。
  try {
    const doc = json as any;
    const summary = {
      type: doc?.type,
      childCount: Array.isArray(doc?.content) ? doc.content.length : 0,
      childTypes: Array.isArray(doc?.content)
        ? doc.content.slice(0, 20).map((n: any) => n?.type)
        : [],
    };
    console.log("[tiptapSchemaRepair] input doc:", summary);
    (window as any).__lastDirtyDoc = json;
  } catch { /* ignore */ }

  // 第一步：JSON → HTML。
  // generateHTML 内部仍用 Node.fromJSON 建 doc，然后用 DOMSerializer 输出 HTML。
  // 即使 doc 的 contentMatch 非法，单节点 toDOM 也能拼出结构良好的 <table><tr><td>。
  let html: string;
  let originalImageSources = new Map<string, string>();
  try {
    // Never create even detached <img> nodes with real network URLs while repairing.
    const masked = maskImageSources(json);
    html = generateHTML(masked.sanitized as any, tiptapExtensions);
    originalImageSources = masked.sources;
    console.log("[tiptapSchemaRepair] HTML length:", html.length);
  } catch (e) {
    // 极端情况下 nodeFromJSON 因为 attrs 类型错误抛了——直接放弃，给空 doc
    console.warn("[tiptapSchemaRepair] generateHTML failed:", e);
    return EMPTY_DOC;
  }

  // 第二步：HTML → JSON。
  // parseHTML 走 schema-aware parser，contentMatch 不合法的子节点会被丢弃 /
  // 必需的包裹会被补上。这才是 schema fixup 的真正入口。
  try {
    // No Editor/EditorView here: rendering ProseMirror image DOM would issue
    // /api/attachments/:id before its signed URL is available.
    const out = restoreImageSources(generateJSON(html, tiptapExtensions), originalImageSources);
    try {
      (window as any).__lastRepairedDoc = out;
      const summary = {
        type: (out as any)?.type,
        childCount: Array.isArray((out as any)?.content) ? (out as any).content.length : 0,
        childTypes: Array.isArray((out as any)?.content)
          ? (out as any).content.slice(0, 20).map((n: any) => n?.type)
          : [],
      };
      console.log("[tiptapSchemaRepair] output doc:", summary);
    } catch { /* ignore */ }
    return out;
  } catch (e) {
    console.warn("[tiptapSchemaRepair] schema-aware generateJSON failed:", e);
    return EMPTY_DOC;
  }
}
