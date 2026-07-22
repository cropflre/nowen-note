import {
    siyuanSyToMarkdown as legacySiyuanSyToMarkdown,
    siyuanTimestampToIso,
    type SiyuanNode,
    type SiyuanSyMarkdownResult,
} from "./siyuanSyParserLegacy";

export type { SiyuanNode, SiyuanSyMarkdownResult } from "./siyuanSyParserLegacy";
export { siyuanTimestampToIso };

const SAFE_IFRAME_PROTOCOLS = new Set(["http:", "https:"]);
const CALLOUT_TYPE_ALIASES: Record<string, "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION"> = {
    note: "NOTE",
    info: "NOTE",
    abstract: "NOTE",
    summary: "NOTE",
    tldr: "NOTE",
    quote: "NOTE",
    tip: "TIP",
    hint: "TIP",
    success: "TIP",
    check: "TIP",
    done: "TIP",
    important: "IMPORTANT",
    question: "IMPORTANT",
    help: "IMPORTANT",
    faq: "IMPORTANT",
    example: "IMPORTANT",
    warning: "WARNING",
    warn: "WARNING",
    attention: "WARNING",
    caution: "CAUTION",
    danger: "CAUTION",
    error: "CAUTION",
    failure: "CAUTION",
    fail: "CAUTION",
    bug: "CAUTION",
};

/** Decode SiYuan's icon format (for example `1f3af` or `1f468-200d-1f4bb`). */
export function decodeSiyuanEmoji(value: unknown): string {
    if (typeof value !== "string") return "";
    const raw = value.trim();
    if (!raw) return "";

    const compact = raw.replace(/^emoji:/i, "");
    if (/^[0-9a-f]{2,8}(?:[-_\s][0-9a-f]{2,8})*$/i.test(compact)) {
        try {
            const codePoints = compact
                .split(/[-_\s]+/)
                .filter(Boolean)
                .map((part) => Number.parseInt(part, 16));
            if (codePoints.every((point) => Number.isFinite(point) && point > 0 && point <= 0x10ffff)) {
                return String.fromCodePoint(...codePoints);
            }
        } catch {
            return "";
        }
    }

    if (!/[\\/]/.test(raw) && !/\.[a-z0-9]{2,8}$/i.test(raw) && Array.from(raw).length <= 16) {
        return raw;
    }
    return "";
}

function readString(node: SiyuanNode, keys: string[]): string {
    for (const key of keys) {
        const direct = node[key];
        if (typeof direct === "string" && direct.trim()) return direct.trim();
        const property = node.Properties?.[key];
        if (typeof property === "string" && property.trim()) return property.trim();
        if (typeof direct === "boolean" || typeof direct === "number") return String(direct);
        if (typeof property === "boolean" || typeof property === "number") return String(property);
    }
    return "";
}

function extractIframeSrc(node: SiyuanNode): string {
    const raw = readString(node, ["src", "href", "url", "Data", "Tokens", "HTML", "html"]);
    const candidate = raw.match(/\bsrc=["']([^"']+)["']/i)?.[1] || raw.match(/\(([^)]+)\)/)?.[1] || raw;
    const value = candidate.trim();
    if (!value) return "";
    try {
        const parsed = new URL(value);
        return SAFE_IFRAME_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : "";
    } catch {
        return /^(?:\/|\.\/|\.\.\/|assets\/)/i.test(value) ? value : "";
    }
}

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function normalizeCalloutType(node: SiyuanNode): "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION" {
    const raw = readString(node, ["CalloutType", "calloutType", "type"]).toLowerCase();
    return CALLOUT_TYPE_ALIASES[raw] || "NOTE";
}

function readCalloutFold(node: SiyuanNode): "+" | "-" | "" {
    const raw = readString(node, ["CalloutFold", "calloutFold", "fold", "folded", "collapsed", "open"]).toLowerCase();
    if (["-", "true", "1", "collapsed", "closed", "close"].includes(raw)) return "-";
    if (["+", "false", "0", "expanded", "open"].includes(raw)) return "+";
    return "";
}

function calloutAsBlockquote(node: SiyuanNode, preparedChildren: SiyuanNode[]): SiyuanNode {
    const type = normalizeCalloutType(node);
    const title = readString(node, ["CalloutTitle", "calloutTitle", "title", "Title"]);
    const fold = readCalloutFold(node);
    const marker = `[!${type}]${fold}${title ? ` ${title}` : ""}`;
    return {
        ...node,
        Type: "NodeBlockquote",
        Children: [
            {
                Type: "NodeParagraph",
                Children: [{ Type: "NodeText", Data: marker }],
            },
            ...preparedChildren,
        ],
    };
}

function prepareNode(node: SiyuanNode): SiyuanNode {
    const preparedChildren = node.Children?.map(prepareNode) || [];
    const copy: SiyuanNode = {
        ...node,
        Properties: node.Properties ? { ...node.Properties } : undefined,
        Children: preparedChildren,
    };

    if (copy.Type === "NodeKramdownBlockIAL") {
        // The legacy renderer already ignores span IAL markers. Normalize block IAL
        // to that marker type so source metadata never becomes a visible paragraph.
        copy.Type = "NodeKramdownSpanIAL";
        return copy;
    }

    if (copy.Type === "NodeCallout") return calloutAsBlockquote(copy, preparedChildren);

    if (copy.Type === "NodeEmoji") {
        const emoji = decodeSiyuanEmoji(readString(copy, ["Data", "Tokens", "unicode", "emoji", "icon"]));
        if (emoji) {
            copy.Type = "NodeText";
            copy.Data = emoji;
            copy.Children = [];
        }
    }

    if (copy.Type === "NodeIFrame") {
        const src = extractIframeSrc(copy);
        if (src) {
            copy.Type = "NodeHTMLBlock";
            copy.Data = `<iframe src="${escapeHtmlAttribute(src)}" title="SiYuan embed" loading="lazy" allowfullscreen></iframe>`;
            copy.Children = [];
        }
    }

    return copy;
}

function collectHtmlAssetRefs(node: SiyuanNode, images: Set<string>, attachments: Set<string>): void {
    if (node.Type === "NodeHTMLBlock" || node.Type === "NodeInlineHTML") {
        const raw = readString(node, ["Data", "Tokens", "HTML", "html"]);
        const tagPattern = /<(img|video|audio|source|iframe)\b[^>]*?\bsrc=["']([^"']+)["'][^>]*>/gi;
        let match: RegExpExecArray | null;
        while ((match = tagPattern.exec(raw)) !== null) {
            const ref = match[2]?.trim();
            if (!ref) continue;
            if (match[1].toLowerCase() === "img") images.add(ref);
            else attachments.add(ref);
        }
    }
    for (const child of node.Children || []) collectHtmlAssetRefs(child, images, attachments);
}

function countNodeType(node: SiyuanNode, type: string): number {
    let count = node.Type === type ? 1 : 0;
    for (const child of node.Children || []) count += countNodeType(child, type);
    return count;
}

/**
 * Compatibility wrapper around the mature SiYuan parser.
 *
 * Real `.sy` nodes are normalized before the legacy data-plane renderer runs:
 * Callout becomes canonical GFM-alert Markdown, block IAL is hidden, iframe is
 * retained as sanitized HTML and emoji is decoded. This keeps Markdown import,
 * live preview and complete preview on the same source representation.
 */
export function siyuanSyToMarkdown(doc: SiyuanNode): SiyuanSyMarkdownResult {
    const iframeCount = countNodeType(doc, "NodeIFrame");
    const calloutCount = countNodeType(doc, "NodeCallout");
    const prepared = prepareNode(doc);
    const result = legacySiyuanSyToMarkdown(prepared);
    const images = new Set(result.stats.images);
    const attachments = new Set(result.stats.attachments);
    const unsupportedNodes = { ...result.stats.unsupportedNodes };
    const warnings = [...result.warnings];

    collectHtmlAssetRefs(prepared, images, attachments);

    if (iframeCount > 0) {
        unsupportedNodes.NodeIFrame = (unsupportedNodes.NodeIFrame || 0) + iframeCount;
        warnings.push("Siyuan iframe is preserved in Markdown; rich text uses a supported video or a downgraded safe link.");
    }
    if (calloutCount > 0) {
        // Retain an import-report entry because rich text represents the alert with
        // supported blockquote/paragraph nodes rather than a native callout schema.
        unsupportedNodes.NodeCallout = (unsupportedNodes.NodeCallout || 0) + calloutCount;
        warnings.push("Siyuan callout was mapped to a styled blockquote with its type, title, fold state and body preserved.");
    }

    return {
        ...result,
        warnings,
        stats: {
            ...result.stats,
            unsupportedNodes,
            images: [...images].sort((a, b) => a.localeCompare(b)),
            attachments: [...attachments].sort((a, b) => a.localeCompare(b)),
        },
    };
}
