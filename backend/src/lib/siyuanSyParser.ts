import {
    siyuanSyToMarkdown as legacySiyuanSyToMarkdown,
    siyuanTimestampToIso,
    type SiyuanNode,
    type SiyuanSyMarkdownResult,
} from "./siyuanSyParserLegacy";

export type { SiyuanNode, SiyuanSyMarkdownResult } from "./siyuanSyParserLegacy";
export { siyuanTimestampToIso };

const SAFE_IFRAME_PROTOCOLS = new Set(["http:", "https:"]);

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

    // Real Unicode emoji may already be stored directly. Do not treat custom icon
    // filenames/paths as emoji because Nowen cannot resolve SiYuan's custom asset here.
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
        // Relative URLs are retained so imported attachment references can still be
        // rewritten by the package importer. MarkdownPreview applies the final guard.
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

function prepareNode(node: SiyuanNode): SiyuanNode {
    const copy: SiyuanNode = {
        ...node,
        Properties: node.Properties ? { ...node.Properties } : undefined,
        Children: node.Children?.map(prepareNode),
    };

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
 * The legacy converter remains responsible for all existing block fidelity. We only
 * normalize pieces it previously dropped: emoji nodes, iframe nodes and asset refs
 * embedded inside raw HTML. Iframes become raw HTML and are rendered later by the
 * sanitized Markdown preview or converted into supported Tiptap video/link nodes.
 */
export function siyuanSyToMarkdown(doc: SiyuanNode): SiyuanSyMarkdownResult {
    const iframeCount = countNodeType(doc, "NodeIFrame");
    const prepared = prepareNode(doc);
    const result = legacySiyuanSyToMarkdown(prepared);
    const images = new Set(result.stats.images);
    const attachments = new Set(result.stats.attachments);
    const unsupportedNodes = { ...result.stats.unsupportedNodes };
    const warnings = [...result.warnings];

    collectHtmlAssetRefs(prepared, images, attachments);

    // Keep the historical import-reporting contract even though the enhanced parser
    // normalizes iframe nodes before the legacy parser sees them. The content itself is
    // still preserved as a supported video or a safe link by the rich-text converter.
    if (iframeCount > 0) {
        unsupportedNodes.NodeIFrame = (unsupportedNodes.NodeIFrame || 0) + iframeCount;
        warnings.push("Siyuan iframe content was downgraded to a supported video or safe link.");
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
