export type ImportedTiptapNode = {
    type: string;
    attrs?: Record<string, unknown>;
    content?: ImportedTiptapNode[];
    text?: string;
    marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
};

export interface SiyuanTiptapEnhancementResult {
    content: string;
    contentText: string;
    repairedInvalidDocument: boolean;
    stats: {
        callouts: number;
        embedLinks: number;
        audioLinks: number;
        widgetLinks: number;
        removedIal: number;
    };
}

const IAL_RE = /^\s*\{:\s*[\s\S]*\}\s*$/;
const CALLOUT_RE = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[+-])?(?:\s+.*)?$/i;
const CALLOUT_ICONS: Record<string, string> = {
    NOTE: "✏️",
    TIP: "💡",
    IMPORTANT: "❗",
    WARNING: "⚠️",
    CAUTION: "🚨",
};

function textNode(value: string, marks?: ImportedTiptapNode["marks"]): ImportedTiptapNode {
    return { type: "text", text: value, ...(marks?.length ? { marks } : {}) };
}

function mergeMark(node: ImportedTiptapNode, mark: { type: string; attrs?: Record<string, unknown> }): ImportedTiptapNode {
    if (node.type !== "text") return node;
    const marks = [...(node.marks || [])];
    if (!marks.some((item) => item.type === mark.type)) marks.push(mark);
    return { ...node, marks };
}

function nodeText(node: ImportedTiptapNode | undefined): string {
    if (!node) return "";
    if (node.type === "text") return node.text || "";
    if (node.type === "hardBreak") return "\n";
    return (node.content || []).map(nodeText).join("");
}

function isIalParagraph(node: ImportedTiptapNode): boolean {
    return node.type === "paragraph" && IAL_RE.test(nodeText(node));
}

function enhanceLinkedLabel(
    node: ImportedTiptapNode,
    stats: SiyuanTiptapEnhancementResult["stats"],
): ImportedTiptapNode {
    if (node.type !== "paragraph" || !Array.isArray(node.content)) return node;

    const mapping: Record<string, { icon: string; key: "embedLinks" | "audioLinks" | "widgetLinks" }> = {
        "嵌入内容": { icon: "🔗", key: "embedLinks" },
        "音频附件": { icon: "🔊", key: "audioLinks" },
        "挂件内容": { icon: "🧩", key: "widgetLinks" },
    };

    const index = node.content.findIndex((child) => (
        child.type === "text" &&
        typeof child.text === "string" &&
        mapping[child.text] &&
        child.marks?.some((mark) => mark.type === "link" && typeof mark.attrs?.href === "string")
    ));
    if (index < 0) return node;

    const target = node.content[index];
    const config = mapping[target.text!];
    const alreadyPrefixed = index > 0 && node.content[index - 1]?.type === "text" && node.content[index - 1]?.text === `${config.icon} `;
    const content = [...node.content];
    content[index] = mergeMark(target, { type: "bold" });
    if (!alreadyPrefixed) content.splice(index, 0, textNode(`${config.icon} `));
    stats[config.key] += 1;
    return { ...node, content };
}

function enhanceCallout(
    node: ImportedTiptapNode,
    stats: SiyuanTiptapEnhancementResult["stats"],
): ImportedTiptapNode {
    if (node.type !== "blockquote" || !Array.isArray(node.content)) return node;
    const firstParagraph = node.content.find((child) => child.type === "paragraph");
    if (!firstParagraph?.content?.length) return node;
    const firstTextIndex = firstParagraph.content.findIndex((child) => child.type === "text" && !!child.text);
    if (firstTextIndex < 0) return node;
    const firstText = firstParagraph.content[firstTextIndex];
    const match = (firstText.text || "").match(CALLOUT_RE);
    if (!match) return node;

    const type = match[1].toUpperCase();
    const icon = CALLOUT_ICONS[type] || CALLOUT_ICONS.NOTE;
    const paragraphContent = [...firstParagraph.content];
    paragraphContent[firstTextIndex] = mergeMark(firstText, { type: "bold" });
    if (!paragraphContent.some((child) => child.type === "text" && child.text === ` ${icon}`)) {
        paragraphContent.splice(firstTextIndex + 1, 0, textNode(` ${icon}`));
    }

    const content = node.content.map((child) => child === firstParagraph
        ? { ...firstParagraph, content: paragraphContent }
        : child);
    stats.callouts += 1;
    return { ...node, content };
}

function enhanceNode(
    node: ImportedTiptapNode,
    stats: SiyuanTiptapEnhancementResult["stats"],
): ImportedTiptapNode | null {
    if (!node || typeof node.type !== "string") return null;
    if (isIalParagraph(node)) {
        stats.removedIal += 1;
        return null;
    }

    let next: ImportedTiptapNode = { ...node };
    if (Array.isArray(node.content)) {
        const content = node.content
            .map((child) => enhanceNode(child, stats))
            .filter((child): child is ImportedTiptapNode => !!child);
        next.content = content;
    }

    next = enhanceCallout(next, stats);
    next = enhanceLinkedLabel(next, stats);
    return next;
}

function collectSearchText(node: ImportedTiptapNode): string {
    if (node.type === "text") return node.text || "";
    if (node.type === "hardBreak") return "\n";
    if (node.type === "mathInline" || node.type === "mathBlock") {
        return typeof node.attrs?.latex === "string" ? node.attrs.latex : "";
    }
    const separator = ["paragraph", "heading", "blockquote", "listItem", "taskItem", "codeBlock"].includes(node.type)
        ? "\n"
        : " ";
    return (node.content || []).map(collectSearchText).filter(Boolean).join(separator);
}

function fallbackDocument(fallbackText: string): ImportedTiptapNode {
    return {
        type: "doc",
        content: [{
            type: "paragraph",
            ...(fallbackText.trim() ? { content: [textNode(fallbackText.trim())] } : {}),
        }],
    };
}

/**
 * Keep SiYuan rich-text imports inside Nowen's existing Tiptap schema while making
 * every intentional downgrade visible. This runs after the core converter so it
 * cannot introduce unknown node types into the editor.
 */
export function enhanceSiyuanImportedTiptap(
    rawContent: string,
    fallbackText = "",
): SiyuanTiptapEnhancementResult {
    const stats: SiyuanTiptapEnhancementResult["stats"] = {
        callouts: 0,
        embedLinks: 0,
        audioLinks: 0,
        widgetLinks: 0,
        removedIal: 0,
    };

    let parsed: ImportedTiptapNode;
    let repairedInvalidDocument = false;
    try {
        parsed = JSON.parse(rawContent) as ImportedTiptapNode;
        if (!parsed || parsed.type !== "doc" || !Array.isArray(parsed.content)) throw new Error("invalid Tiptap root");
    } catch {
        parsed = fallbackDocument(fallbackText);
        repairedInvalidDocument = true;
    }

    const enhanced = enhanceNode(parsed, stats) || fallbackDocument(fallbackText);
    if (!Array.isArray(enhanced.content) || enhanced.content.length === 0) {
        enhanced.content = fallbackDocument(fallbackText).content;
        repairedInvalidDocument = true;
    }

    const contentText = collectSearchText(enhanced).replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return {
        content: JSON.stringify(enhanced),
        contentText: contentText || fallbackText.trim(),
        repairedInvalidDocument,
        stats,
    };
}
