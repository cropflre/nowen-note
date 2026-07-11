import type { SiyuanNode } from "./siyuanSyParser";

export interface TiptapJsonNode {
    type: string;
    attrs?: Record<string, unknown>;
    content?: TiptapJsonNode[];
    text?: string;
    marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface SiyuanTiptapConvertOptions {
    resolveAssetUrl?: (raw: string) => string | null;
}

interface ExtractedInlineStyle {
    cssText: string;
    color?: string;
    backgroundColor?: string;
    fontSize?: string;
    extraMarkTypes: string[];
}

const MARKER_NODE_TYPES = new Set([
    "NodeHeadingC8hMarker",
    "NodeBang",
    "NodeOpenBracket",
    "NodeCloseBracket",
    "NodeOpenParen",
    "NodeCloseParen",
    "NodeOpenBrace",
    "NodeCloseBrace",
    "NodeKramdownSpanIAL",
    "NodeBlockquoteMarker",
    "NodeCodeBlockFenceOpenMarker",
    "NodeCodeBlockFenceCloseMarker",
    "NodeCodeBlockFenceInfoMarker",
    "NodeMathBlockOpenMarker",
    "NodeMathBlockCloseMarker",
    "NodeSuperBlockOpenMarker",
    "NodeSuperBlockLayoutMarker",
    "NodeSuperBlockCloseMarker",
    "NodeTaskListItemMarker",
]);

const MEDIA_BLOCK_NODE_TYPES = new Set(["NodeImage", "NodeVideo", "NodeAudio", "NodeIFrame", "NodeWidget"]);

function getValue(node: SiyuanNode | undefined, keys: string[]): unknown {
    if (!node) return undefined;
    for (const key of keys) {
        if (node[key] !== undefined) return node[key];
        if (node.Properties?.[key] !== undefined) return node.Properties[key];
    }
    const lowerKeys = new Set(keys.map((key) => key.toLowerCase()));
    for (const [key, value] of Object.entries(node.Properties || {})) {
        if (lowerKeys.has(key.toLowerCase())) return value;
    }
    for (const [key, value] of Object.entries(node)) {
        if (lowerKeys.has(key.toLowerCase())) return value;
    }
    return undefined;
}

function getString(node: SiyuanNode | undefined, keys: string[]): string {
    const value = getValue(node, keys);
    return typeof value === "string" ? value : value == null ? "" : String(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Object.prototype.toString.call(value) === "[object Object]";
}

function serializeUnknownValue(value: unknown): unknown | undefined {
    if (value == null) return undefined;
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? trimmed : undefined;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
            const serialized = serializeUnknownValue(item);
            if (serialized !== undefined) out.push(serialized);
        }
        return out.length > 0 ? out : undefined;
    }
    if (isPlainObject(value)) {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
            const serialized = serializeUnknownValue(item);
            if (serialized !== undefined) out[key] = serialized;
        }
        return Object.keys(out).length > 0 ? out : undefined;
    }
    return undefined;
}

function toStyleString(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (!isPlainObject(value)) return "";
    const parts: string[] = [];
    for (const [key, val] of Object.entries(value)) {
        const text = typeof val === "string" ? val.trim() : val == null ? "" : String(val);
        if (!key.trim() || !text) continue;
        parts.push(`${key.trim()}: ${text}`);
    }
    return parts.join("; ");
}

function extractStyleFromKramdownData(raw: string): string {
    const text = raw.trim();
    if (!text) return "";

    const styleAttr = text.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
    if (styleAttr) return styleAttr.trim();

    const ialBody = text.match(/^\{:\s*([\s\S]*?)\s*\}$/)?.[1];
    if (ialBody) {
        const ialStyle = ialBody.match(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/i)?.[2];
        if (ialStyle) return ialStyle.trim();
    }

    if (/^[a-zA-Z-]+\s*:/.test(text)) return text;
    return "";
}

function mergeCssDeclarations(styleTexts: string[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const styleText of styleTexts) {
        for (const part of styleText.split(";")) {
            const idx = part.indexOf(":");
            if (idx <= 0) continue;
            const key = part.slice(0, idx).trim().toLowerCase();
            const value = part.slice(idx + 1).trim();
            if (!key || !value) continue;
            map.set(key, value);
        }
    }
    return map;
}

function extractInlineStyle(node: SiyuanNode): ExtractedInlineStyle | null {
    const candidates: string[] = [];

    const ownStyle = toStyleString(getValue(node, ["style", "Style", "TextMarkStyle"]));
    if (ownStyle) candidates.push(ownStyle);

    for (const child of node.Children || []) {
        if (child.Type !== "NodeKramdownSpanIAL") continue;
        const childStyle = toStyleString(getValue(child, ["style", "Style"]));
        if (childStyle) candidates.push(childStyle);
        const fromData = extractStyleFromKramdownData(getString(child, ["Data", "Tokens", "HTML", "html", "Text", "text"]));
        if (fromData) candidates.push(fromData);
    }

    const css = mergeCssDeclarations(candidates);
    if (css.size === 0) return null;

    const extra = new Set<string>();
    const fontWeight = (css.get("font-weight") || "").toLowerCase();
    if (/\b(bold|[6-9]00)\b/.test(fontWeight)) extra.add("strong");
    const fontStyle = (css.get("font-style") || "").toLowerCase();
    if (fontStyle.includes("italic") || fontStyle.includes("oblique")) extra.add("em");
    const textDecoration = `${css.get("text-decoration") || ""} ${css.get("text-decoration-line") || ""}`.toLowerCase();
    if (textDecoration.includes("underline")) extra.add("u");
    if (textDecoration.includes("line-through")) extra.add("strike");

    return {
        cssText: Array.from(css.entries()).map(([key, value]) => `${key}: ${value}`).join("; "),
        color: css.get("color"),
        backgroundColor: css.get("background-color"),
        fontSize: css.get("font-size"),
        extraMarkTypes: Array.from(extra),
    };
}

function toPositiveInt(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : Number(String(value || "").trim());
    if (!Number.isFinite(parsed)) return undefined;
    const rounded = Math.trunc(parsed);
    return rounded > 0 ? rounded : undefined;
}

function readCellColwidth(node: SiyuanNode): number[] | undefined {
    const raw = getValue(node, ["colwidth", "ColWidth", "colWidth", "TableCellWidth", "width"]);
    if (raw == null) return undefined;
    if (Array.isArray(raw)) {
        const numbers = raw
            .map((item) => toPositiveInt(item))
            .filter((item): item is number => item !== undefined);
        return numbers.length > 0 ? numbers : undefined;
    }
    if (typeof raw === "string") {
        const numbers = raw
            .split(/[\s,|]+/)
            .map((item) => toPositiveInt(item))
            .filter((item): item is number => item !== undefined);
        return numbers.length > 0 ? numbers : undefined;
    }
    const parsed = toPositiveInt(raw);
    return parsed ? [parsed] : undefined;
}

function looksLikeAssetOrUrl(value: string): boolean {
    return /^(https?:|data:|blob:|file:|\/|\.\/|\.\.\/|assets\/)/i.test(value.trim()) ||
        /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|ogg|ogv|m4v|mov|mp3|wav|m4a|flac|aac)([?#].*)?$/i.test(value);
}

const VIDEO_FILE_EXT_RE = /\.(mp4|webm|ogg|ogv|m4v|mov)([?#].*)?$/i;

function extractSrc(text: string): string {
    return text.match(/\bsrc=["']([^"']+)["']/i)?.[1] || text.match(/\(([^)]+)\)/)?.[1] || text.trim();
}

function parseSupportedVideoUrl(rawUrl: string, resolvedUrl = rawUrl): { src: string; platform: string; kind: "file" | "iframe" } | null {
    const url = rawUrl.trim();
    if (!url) return null;
    if (VIDEO_FILE_EXT_RE.test(url)) return { src: resolvedUrl, platform: "file", kind: "file" };

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    const host = parsed.hostname.toLowerCase();
    if (host.includes("bilibili.com")) {
        const match = parsed.pathname.match(/\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
        if (match) {
            const id = match[1];
            const param = /^av/i.test(id) ? `aid=${id.slice(2)}` : `bvid=${id}`;
            const page = parsed.searchParams.get("p");
            const pageQuery = page ? `&page=${encodeURIComponent(page)}` : "";
            return {
                src: `https://player.bilibili.com/player.html?${param}${pageQuery}&autoplay=0&high_quality=1`,
                platform: "bilibili",
                kind: "iframe",
            };
        }
        if (host.includes("player.bilibili.com")) return { src: url, platform: "bilibili", kind: "iframe" };
    }

    if (host.includes("youtube.com") || host.includes("youtu.be")) {
        let videoId = "";
        if (host.includes("youtu.be")) {
            videoId = parsed.pathname.replace(/^\//, "").split("/")[0];
        } else if (parsed.pathname.startsWith("/embed/")) {
            videoId = parsed.pathname.replace(/^\/embed\//, "").split("/")[0];
            if (videoId) return { src: url, platform: "youtube", kind: "iframe" };
        } else {
            videoId = parsed.searchParams.get("v") || "";
        }
        if (videoId) {
            return {
                src: `https://www.youtube-nocookie.com/embed/${videoId}`,
                platform: "youtube",
                kind: "iframe",
            };
        }
    }

    if (host.includes("v.qq.com")) {
        const match =
            parsed.pathname.match(/\/(?:cover\/[^/]+|page)\/([A-Za-z0-9]+)\.html/) ||
            parsed.pathname.match(/\/x\/cover\/[^/]+\/([A-Za-z0-9]+)/);
        if (match) {
            return {
                src: `https://v.qq.com/txp/iframe/player.html?vid=${match[1]}`,
                platform: "tencent",
                kind: "iframe",
            };
        }
    }

    if (host.includes("vimeo.com")) {
        const match = parsed.pathname.match(/\/(\d+)/);
        if (match) {
            return {
                src: `https://player.vimeo.com/video/${match[1]}`,
                platform: "vimeo",
                kind: "iframe",
            };
        }
    }

    return null;
}

function getHeadingLevel(node: SiyuanNode): number {
    const raw =
        getString(node, ["HeadingLevel", "headingLevel", "level", "Level"]) ||
        getString((node.Children || []).find((child) => child.Type === "NodeHeadingC8hMarker"), ["Data"]);
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(3, Math.max(1, parsed));
}

function isTaskItem(node: SiyuanNode): boolean {
    return (node.Children || []).some((child) => child.Type === "NodeTaskListItemMarker") ||
        getString(node, ["TaskChecked", "checked", "Checked"]).trim() !== "";
}

function isCheckedTask(node: SiyuanNode): boolean {
    const data = [
        getString(node, ["Data"]),
        getString(node, ["TaskChecked", "checked", "Checked"]),
        ...(node.Children || []).map((child) => getString(child, ["Data"])),
    ]
        .join(" ")
        .toLowerCase();
    return data.includes("[x]") || data.includes("checked") || data.includes("done") || data.includes("true");
}

function isOrderedList(node: SiyuanNode): boolean {
    const hint = [
        node.Type,
        getString(node, ["ListData", "SubType", "subType", "listType", "type"]),
        getString(node, ["Data"]),
    ].join(" ").toLowerCase();
    return /\b(ordered|order|ol|number)\b/.test(hint);
}

function withMark(node: TiptapJsonNode, mark: { type: string; attrs?: Record<string, unknown> }): TiptapJsonNode {
    if (node.type !== "text") return node;
    return { ...node, marks: [...(node.marks || []), mark] };
}

function textNode(text: string, marks?: TiptapJsonNode["marks"]): TiptapJsonNode[] {
    if (!text) return [];
    return [{ type: "text", text, ...(marks?.length ? { marks } : {}) }];
}

function trimParagraphBoundary(content: TiptapJsonNode[]): TiptapJsonNode[] {
    const next = content.map((item) => ({ ...item }));
    while (next[0]?.type === "text" && !next[0].marks?.length) {
        next[0].text = (next[0].text || "").replace(/^\s+/, "");
        if (next[0].text) break;
        next.shift();
    }
    while (next[next.length - 1]?.type === "text" && !next[next.length - 1].marks?.length) {
        const last = next[next.length - 1];
        last.text = (last.text || "").replace(/\s+$/, "");
        if (last.text) break;
        next.pop();
    }
    return next;
}

function renderTextMark(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const markTypes = getString(node, ["TextMarkType", "type", "markType"])
        .toLowerCase()
        .split(/\s+/)
        .map((value) => value.trim())
        .filter(Boolean);
    const inlineStyle = extractInlineStyle(node);
    const normalizedMarkTypes = Array.from(new Set([
        ...markTypes,
        ...(inlineStyle?.extraMarkTypes || []),
    ]));
    const rawText = getString(node, ["TextMarkTextContent", "Text", "text", "Data"]);
    const inlineMath = getString(node, ["TextMarkInlineMathContent", "inlineMath", "math"]);
    const inlineMemo = getString(node, ["TextMarkInlineMemoContent", "inlineMemo", "memo"]);
    const href = getString(node, ["TextMarkAHref", "href", "url", "dest"]);
    const blockRefId = getString(node, ["TextMarkBlockRefID", "BlockRefID", "id", "ID"]);

    if (normalizedMarkTypes.includes("inline-math")) {
        const latex = inlineMath || rawText || renderPlainText(node);
        return latex.trim() ? [{ type: "mathInline", attrs: { latex: latex.trim() } }] : [];
    }

    let content = rawText ? textNode(rawText) : renderInlineContent(node, options);
    if (normalizedMarkTypes.includes("inline-memo")) {
        const memoText = inlineMemo || rawText || renderPlainText(node);
        content = memoText ? textNode(memoText) : [];
    }
    if (normalizedMarkTypes.includes("tag")) {
        const base = (rawText || renderPlainText(node)).replace(/^#|#$/g, "").trim();
        content = base ? textNode(`#${base}#`) : [];
    }
    if (normalizedMarkTypes.includes("block-ref") && content.length === 0) {
        content = textNode(blockRefId ? `[块引用:${blockRefId}]` : "[块引用]");
    }
    if (normalizedMarkTypes.includes("file-annotation-ref") && content.length === 0) {
        content = textNode("[文件标注]");
    }

    for (const markType of normalizedMarkTypes) {
        switch (markType) {
            case "strong":
                content = content.map((item) => withMark(item, { type: "bold" }));
                break;
            case "em":
                content = content.map((item) => withMark(item, { type: "italic" }));
                break;
            case "s":
            case "strike":
                content = content.map((item) => withMark(item, { type: "strike" }));
                break;
            case "code":
            case "kbd":
                content = content.map((item) => withMark(item, { type: "code" }));
                break;
            case "u":
                content = content.map((item) => withMark(item, { type: "underline" }));
                break;
            case "mark":
                content = content.map((item) =>
                    withMark(item, {
                        type: "highlight",
                        attrs: inlineStyle?.backgroundColor ? { color: inlineStyle.backgroundColor } : undefined,
                    })
                );
                break;
            case "a":
                if (href) content = content.map((item) => withMark(item, { type: "link", attrs: { href } }));
                break;
            default:
                break;
        }
    }

    if (inlineStyle?.color || inlineStyle?.fontSize) {
        const attrs: Record<string, unknown> = {};
        if (inlineStyle.color) attrs.color = inlineStyle.color;
        if (inlineStyle.fontSize) attrs.fontSize = inlineStyle.fontSize;
        content = content.map((item) => withMark(item, { type: "textStyle", attrs }));
    }

    if (inlineStyle?.backgroundColor && !normalizedMarkTypes.includes("mark")) {
        content = content.map((item) => withMark(item, { type: "highlight", attrs: { color: inlineStyle.backgroundColor } }));
    }

    return content;
}

function renderInlineContent(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const out: TiptapJsonNode[] = [];
    for (const child of node.Children || []) {
        out.push(...renderInline(child, options));
    }
    return out;
}

function renderInline(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    if (MARKER_NODE_TYPES.has(node.Type)) return [];

    switch (node.Type) {
        case "NodeText":
        case "NodeCodeBlockCode":
        case "NodeMathBlockContent":
        case "NodeLinkText":
        case "NodeLinkDest":
            return textNode(getString(node, ["Data"]));
        case "NodeTextMark":
            return renderTextMark(node, options);
        case "NodeBr":
            return [{ type: "hardBreak" }];
        case "NodeBackslash":
        case "NodeBlockRef":
        case "NodeInlineHTML":
            return textNode(getString(node, ["Data", "Text", "text", "Tokens", "HTML", "html"]) || renderPlainText(node));
        default:
            return textNode(getString(node, ["Data"]) || renderPlainText(node));
    }
}

function renderParagraphLike(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const blocks: TiptapJsonNode[] = [];
    let inline: TiptapJsonNode[] = [];
    const flushParagraph = () => {
        const content = trimParagraphBoundary(inline);
        inline = [];
        if (content.length > 0) {
            blocks.push({ type: "paragraph", content });
        }
    };

    for (const child of node.Children || []) {
        if (MARKER_NODE_TYPES.has(child.Type)) continue;
        if (MEDIA_BLOCK_NODE_TYPES.has(child.Type)) {
            flushParagraph();
            blocks.push(...renderBlock(child, options));
            continue;
        }
        inline.push(...renderInline(child, options));
    }

    flushParagraph();
    if (blocks.length === 0) {
        const data = getString(node, ["Data"]);
        blocks.push(data ? { type: "paragraph", content: textNode(data) } : { type: "paragraph" });
    }
    return blocks;
}

function renderListItemContent(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const content: TiptapJsonNode[] = [];
    for (const child of node.Children || []) {
        if (MARKER_NODE_TYPES.has(child.Type)) continue;
        if (child.Type === "NodeParagraph") {
            const paragraph = renderParagraphLike(child, options).filter((item) => item.type === "paragraph");
            content.push(...paragraph);
            continue;
        }
        content.push(...renderBlock(child, options));
    }
    return content.length > 0 ? content : [{ type: "paragraph" }];
}

function renderList(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const items = (node.Children || []).filter((child) => child.Type === "NodeListItem");
    if (items.length === 0) return [];

    const taskList = items.some(isTaskItem);
    if (taskList) {
        return [{
            type: "taskList",
            content: items.map((item) => ({
                type: "taskItem",
                attrs: { checked: isCheckedTask(item) },
                content: renderListItemContent(item, options),
            })),
        }];
    }

    return [{
        type: isOrderedList(node) ? "orderedList" : "bulletList",
        content: items.map((item) => ({
            type: "listItem",
            content: renderListItemContent(item, options),
        })),
    }];
}

function resolveMediaSrc(raw: string, options: SiyuanTiptapConvertOptions): string {
    return options.resolveAssetUrl?.(raw) || raw;
}

function renderImage(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const childDest = getString((node.Children || []).find((child) => child.Type === "NodeLinkDest"), ["Data"]);
    const explicitSrc = getString(node, ["src", "href", "url"]);
    const data = getString(node, ["Data"]);
    const src = childDest || explicitSrc || (looksLikeAssetOrUrl(data) ? data : "");
    const alt =
        getString(node, ["alt", "title"]) ||
        getString((node.Children || []).find((child) => child.Type === "NodeLinkText"), ["Data"]) ||
        renderPlainText((node.Children || []).find((child) => child.Type === "NodeLinkText"));
    const title = getString((node.Children || []).find((child) => child.Type === "NodeLinkTitle"), ["Data"]);
    if (!src) return alt ? [{ type: "paragraph", content: textNode(alt) }] : [];
    return [{
        type: "image",
        attrs: {
            src: resolveMediaSrc(src, options),
            alt: alt || null,
            title: title || null,
        },
    }];
}

function renderVideo(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const raw = getString(node, ["src", "href", "url", "Data", "Tokens", "HTML", "html"]) || renderPlainText(node);
    const src = extractSrc(raw);
    if (!src) return [];
    const resolved = resolveMediaSrc(src, options);
    const parsed = parseSupportedVideoUrl(src, resolved) || { src: resolved, platform: "file", kind: "file" as const };
    return [{
        type: "video",
        attrs: {
            src: parsed.src,
            platform: parsed.platform,
            kind: parsed.kind,
            originalUrl: src,
        },
    }];
}

function renderIframe(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const raw = getString(node, ["src", "href", "url", "Data", "Tokens", "HTML", "html"]) || renderPlainText(node);
    const src = extractSrc(raw);
    if (!src) return [];
    const resolved = resolveMediaSrc(src, options);
    const parsed = parseSupportedVideoUrl(src, resolved);
    if (!parsed) return renderDeferredMedia(node, options, "嵌入内容");
    return [{
        type: "video",
        attrs: {
            src: parsed.src,
            platform: parsed.platform,
            kind: parsed.kind,
            originalUrl: src,
        },
    }];
}

function renderCodeBlock(node: SiyuanNode): TiptapJsonNode[] {
    const language =
        getString(node, ["CodeBlockInfo", "language", "lang"]) ||
        getString((node.Children || []).find((child) => child.Type === "NodeCodeBlockFenceInfoMarker"), ["Data"]);
    const code =
        getString(node, ["CodeBlockCode", "code", "Data"]) ||
        (node.Children || [])
            .filter((child) => child.Type === "NodeCodeBlockCode")
            .map((child) => getString(child, ["Data"]))
            .join("\n");
    return [{
        type: "codeBlock",
        attrs: { language: language.trim() || null },
        content: code ? [{ type: "text", text: code.replace(/\n$/, "") }] : undefined,
    }];
}

function renderBlockquote(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const content = renderBlocks(node.Children || [], options);
    return [{ type: "blockquote", content: content.length > 0 ? content : [{ type: "paragraph" }] }];
}

function renderCallout(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const rawType = getString(node, ["CalloutType", "calloutType", "type"]).toUpperCase();
    const allowed = new Set(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]);
    const type = allowed.has(rawType) ? rawType : "NOTE";
    const title = getString(node, ["CalloutTitle", "title", "Title"]);
    const marker = title ? `[!${type}] ${title}` : `[!${type}]`;
    const body = renderBlocks(node.Children || [], options);
    return [{
        type: "blockquote",
        content: [{ type: "paragraph", content: textNode(marker) }, ...body],
    }];
}

function extractMathLatex(node: SiyuanNode): string {
    return (
        getString(node, ["Data", "content", "latex"]) ||
        (node.Children || [])
            .filter((child) => child.Type === "NodeMathBlockContent")
            .map((child) => getString(child, ["Data"]))
            .join("\n")
    ).trim();
}

function renderMathBlock(node: SiyuanNode): TiptapJsonNode[] {
    const latex = extractMathLatex(node);
    return latex ? [{ type: "mathBlock", attrs: { latex } }] : [];
}

function renderHtmlBlock(node: SiyuanNode): TiptapJsonNode[] {
    const raw = getString(node, ["Data", "Tokens", "HTML", "html"]);
    const mermaid = raw.match(/<pre[^>]*>\s*<code[^>]*(?:language-|lang-)?mermaid[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/i)?.[1] ||
        raw.match(/<div[^>]*class=["'][^"']*mermaid[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (mermaid?.trim()) {
        return [{
            type: "codeBlock",
            attrs: { language: "mermaid" },
            content: [{ type: "text", text: mermaid.replace(/<[^>]+>/g, "").trim() }],
        }];
    }
    return raw.trim() ? [{ type: "codeBlock", attrs: { language: "html" }, content: [{ type: "text", text: raw.trim() }] }] : [];
}

function flattenTableRows(node: SiyuanNode): SiyuanNode[] {
    const rows: SiyuanNode[] = [];
    const visit = (current: SiyuanNode) => {
        if (current.Type === "NodeTableRow") {
            rows.push(current);
            return;
        }
        for (const child of current.Children || []) visit(child);
    };
    visit(node);
    return rows;
}

function renderTableCell(node: SiyuanNode, options: SiyuanTiptapConvertOptions, type: "tableHeader" | "tableCell"): TiptapJsonNode {
    const content = renderBlocks(node.Children || [], options);
    const attrs: Record<string, unknown> = {};
    const colspan = toPositiveInt(getValue(node, ["colspan", "ColSpan", "colSpan"]));
    const rowspan = toPositiveInt(getValue(node, ["rowspan", "RowSpan", "rowSpan"]));
    const colwidth = readCellColwidth(node);
    const align = getString(node, ["align", "Align", "TableCellAlign", "tableCellAlign", "Alignment"]).trim();

    if (colspan && colspan > 1) attrs.colspan = colspan;
    if (rowspan && rowspan > 1) attrs.rowspan = rowspan;
    if (colwidth && colwidth.length > 0) attrs.colwidth = colwidth;
    if (align) attrs.align = align;

    return {
        type,
        ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
        content: content.length > 0 ? content : [{ type: "paragraph" }],
    };
}

function renderTable(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    const rows: TiptapJsonNode[] = [];
    for (const [rowIndex, row] of flattenTableRows(node).entries()) {
        const cells = (row.Children || []).filter((cell) => cell.Type === "NodeTableCell");
        if (cells.length === 0) continue;
        const cellType = rowIndex === 0 ? "tableHeader" : "tableCell";
        rows.push({
            type: "tableRow",
            content: cells.map((cell) => renderTableCell(cell, options, cellType)),
        });
    }
    const attrs: Record<string, unknown> = {};
    const tableAligns = serializeUnknownValue(getValue(node, ["TableAligns", "tableAligns"]));
    const colgroup = serializeUnknownValue(getValue(node, ["colgroup", "ColGroup", "tableColgroup", "TableColGroup"]));
    if (tableAligns !== undefined) attrs.tableAligns = tableAligns;
    if (colgroup !== undefined) attrs.colgroup = colgroup;

    return rows.length > 0
        ? [{ type: "table", ...(Object.keys(attrs).length > 0 ? { attrs } : {}), content: rows }]
        : [];
}

function renderPlainText(node: SiyuanNode | undefined): string {
    if (!node) return "";
    const data = getString(node, ["Data", "Text", "text", "Tokens", "HTML", "html"]);
    if (data) return data;
    return (node.Children || []).map(renderPlainText).join("");
}

function renderDeferredMedia(node: SiyuanNode, options: SiyuanTiptapConvertOptions, label: string): TiptapJsonNode[] {
    const raw = getString(node, ["src", "href", "url", "Data", "Tokens", "HTML", "html"]) || renderPlainText(node);
    const src = extractSrc(raw);
    const text = src ? label : renderPlainText(node);
    if (!src) return text ? [{ type: "paragraph", content: textNode(text) }] : [];
    return [{
        type: "paragraph",
        content: [{
            type: "text",
            text: label,
            marks: [{ type: "link", attrs: { href: resolveMediaSrc(src, options) } }],
        }],
    }];
}

function renderBlock(node: SiyuanNode, options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    if (MARKER_NODE_TYPES.has(node.Type)) return [];

    switch (node.Type) {
        case "NodeDocument":
        case "NodeSuperBlock":
            return renderBlocks(node.Children || [], options);
        case "NodeHeading": {
            const content = renderInlineContent(node, options);
            return [{
                type: "heading",
                attrs: { level: getHeadingLevel(node) },
                content: content.length > 0 ? content : undefined,
            }];
        }
        case "NodeParagraph":
            return renderParagraphLike(node, options);
        case "NodeText":
        case "NodeTextMark":
        case "NodeBr":
            return [{ type: "paragraph", content: renderInline(node, options) }];
        case "NodeList":
            return renderList(node, options);
        case "NodeBlockquote":
            return renderBlockquote(node, options);
        case "NodeCallout":
            return renderCallout(node, options);
        case "NodeCodeBlock":
            return renderCodeBlock(node);
        case "NodeMathBlock":
            return renderMathBlock(node);
        case "NodeHTMLBlock":
            return renderHtmlBlock(node);
        case "NodeThematicBreak":
            return [{ type: "horizontalRule" }];
        case "NodeTable":
            return renderTable(node, options);
        case "NodeImage":
            return renderImage(node, options);
        case "NodeVideo":
            return renderVideo(node, options);
        case "NodeAudio":
            return renderDeferredMedia(node, options, "音频附件");
        case "NodeIFrame":
            return renderIframe(node, options);
        case "NodeWidget":
            return renderDeferredMedia(node, options, "挂件内容");
        default: {
            const childBlocks = renderBlocks(node.Children || [], options);
            if (childBlocks.length > 0) return childBlocks;
            const text = getString(node, ["Data"]) || renderPlainText(node);
            return text ? [{ type: "paragraph", content: textNode(text) }] : [];
        }
    }
}

function renderBlocks(nodes: SiyuanNode[], options: SiyuanTiptapConvertOptions): TiptapJsonNode[] {
    return nodes.flatMap((node) => renderBlock(node, options));
}

export function siyuanSyToTiptapJson(doc: SiyuanNode, options: SiyuanTiptapConvertOptions = {}): string {
    const content = renderBlock(doc, options);
    return JSON.stringify({
        type: "doc",
        content: content.length > 0 ? content : [{ type: "paragraph" }],
    });
}
