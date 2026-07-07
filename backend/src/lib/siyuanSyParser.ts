export interface SiyuanNode {
    ID?: string;
    Type: string;
    Data?: string;
    Properties?: Record<string, any>;
    Children?: SiyuanNode[];
    [key: string]: any;
}

export interface SiyuanSyMarkdownResult {
    title: string;
    markdown: string;
    plainText: string;
    updatedAt?: string;
    warnings: string[];
    stats: {
        unsupportedNodes: Record<string, number>;
        blockRefs: number;
        wikiLinks: number;
        tags: string[];
        images: string[];
        attachments: string[];
    };
}

interface RenderContext {
    warnings: string[];
    unsupportedNodes: Record<string, number>;
    blockRefs: number;
    wikiLinks: number;
    tags: Set<string>;
    images: Set<string>;
    attachments: Set<string>;
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

function getValue(node: SiyuanNode | undefined, keys: string[]): any {
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

function uniqueSorted(values: Iterable<string>): string[] {
    return Array.from(new Set(Array.from(values).map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
        a.localeCompare(b),
    );
}

function escapePipe(value: string): string {
    return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function escapeAttr(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeMarkdownLiteral(value: string): string {
    return value.replace(/([\\`*_{}\[\]()#+\-.!>|])/g, "\\$1");
}

function looksLikeAssetOrUrl(value: string): boolean {
    return /^(https?:|data:|blob:|file:|\/|\.\/|\.\.\/|assets\/)/i.test(value.trim()) ||
        /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|ogg|ogv|m4v|mov|mp3|wav|m4a|flac|aac)([?#].*)?$/i.test(value);
}

function normalizeImportedTitle(value: string): string {
    return value
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/\s+#{1,6}\s*$/, "")
        .trim();
}

function getTitle(node: SiyuanNode): string {
    const raw = (
        getString(node, ["title", "name", "Title", "Name"]) ||
        getString(node, ["Data"]) ||
        node.ID ||
        "Untitled"
    );
    const normalized = normalizeImportedTitle(raw);
    return normalized || "Untitled";
}

export function siyuanTimestampToIso(value?: string): string | undefined {
    const text = (value || "").trim();
    const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (!match) return undefined;
    const [, year, month, day, hour, minute, second] = match;
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    const hourNumber = Number(hour);
    const minuteNumber = Number(minute);
    const secondNumber = Number(second);
    if (
        monthNumber < 1 ||
        monthNumber > 12 ||
        dayNumber < 1 ||
        dayNumber > 31 ||
        hourNumber > 23 ||
        minuteNumber > 59 ||
        secondNumber > 59
    ) {
        return undefined;
    }
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

function addUnsupported(ctx: RenderContext, type: string, message?: string) {
    ctx.unsupportedNodes[type] = (ctx.unsupportedNodes[type] || 0) + 1;
    if (message) ctx.warnings.push(message);
}

function renderChildrenInline(node: SiyuanNode, ctx: RenderContext): string {
    return (node.Children || []).map((child) => renderInline(child, ctx)).join("");
}

function renderChildrenBlock(node: SiyuanNode, ctx: RenderContext): string {
    return (node.Children || [])
        .map((child) => renderBlock(child, ctx).trim())
        .filter(Boolean)
        .join("\n\n");
}

function textFromChildren(node: SiyuanNode, ctx: RenderContext): string {
    const inline = renderChildrenInline(node, ctx).trim();
    if (inline) return inline;
    return (node.Children || [])
        .map((child) => renderBlock(child, ctx).trim())
        .filter(Boolean)
        .join(" ");
}

function renderTextMark(node: SiyuanNode, ctx: RenderContext): string {
    const markType = getString(node, ["TextMarkType", "type", "markType"]).toLowerCase();
    const text = (
        getString(node, ["TextMarkTextContent", "Text", "text", "Data"]) ||
        renderChildrenInline(node, ctx)
    ).trim();
    const href = getString(node, ["TextMarkAHref", "href", "url", "dest"]);

    switch (markType) {
        case "code":
            return text ? `\`${text.replace(/`/g, "\\`")}\`` : "";
        case "kbd":
            return text ? `<kbd>${text}</kbd>` : "";
        case "strong":
            return text ? `**${text}**` : "";
        case "em":
            return text ? `*${text}*` : "";
        case "s":
        case "strike":
            return text ? `~~${text}~~` : "";
        case "u":
            return text ? `<u>${text}</u>` : "";
        case "mark":
            return text ? `<mark>${text}</mark>` : "";
        case "a":
            return href ? `[${text || href}](${href})` : text;
        case "tag": {
            const tag = text.replace(/^#|#$/g, "").trim();
            if (tag) ctx.tags.add(tag);
            return tag ? `#${tag}#` : "";
        }
        case "block-ref": {
            ctx.blockRefs++;
            const id = getString(node, ["TextMarkBlockRefID", "BlockRefID", "id", "ID"]);
            return text || (id ? `[块引用:${id}]` : "[块引用]");
        }
        case "inline-math":
            return text ? `$${text}$` : "";
        case "sup":
            return text ? `<sup>${text}</sup>` : "";
        case "sub":
            return text ? `<sub>${text}</sub>` : "";
        case "inline-memo":
            addUnsupported(ctx, "inline-memo", "Siyuan inline memo was imported as plain text.");
            ctx.warnings.push("Siyuan inline memo was imported as plain text.");
            return text;
        case "file-annotation-ref":
            return text || "[文件标注]";
        default:
            return text || renderChildrenInline(node, ctx);
    }
}

function renderInline(node: SiyuanNode, ctx: RenderContext): string {
    if (MARKER_NODE_TYPES.has(node.Type)) return "";
    switch (node.Type) {
        case "NodeText":
        case "NodeCodeBlockCode":
        case "NodeMathBlockContent":
        case "NodeLinkText":
        case "NodeLinkDest":
            return getString(node, ["Data"]);
        case "NodeTextMark":
            return renderTextMark(node, ctx);
        case "NodeBackslash":
            return escapeMarkdownLiteral(renderChildrenInline(node, ctx) || getString(node, ["Data"]));
        case "NodeBlockRef": {
            ctx.blockRefs++;
            const text = renderChildrenInline(node, ctx).trim() || getString(node, ["Data", "Text", "text"]);
            const id = getString(node, ["BlockRefID", "TextMarkBlockRefID", "id", "ID"]);
            return text || (id ? `[块引用:${id}]` : "[块引用]");
        }
        case "NodeBr":
            return "\n";
        case "NodeImage":
            return renderImage(node, ctx).trim();
        case "NodeInlineHTML":
            return getString(node, ["Data", "Tokens", "HTML", "html"]);
        default:
            return getString(node, ["Data"]) || renderChildrenInline(node, ctx);
    }
}

function getHeadingLevel(node: SiyuanNode): number {
    const raw =
        getString(node, ["HeadingLevel", "headingLevel", "level", "Level"]) ||
        getString((node.Children || []).find((child) => child.Type === "NodeHeadingC8hMarker"), ["Data"]);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? Math.min(6, Math.max(1, parsed)) : 1;
}

function renderList(node: SiyuanNode, ctx: RenderContext, depth = 0): string {
    const listHint = [
        node.Type,
        getString(node, ["ListData", "SubType", "subType", "listType", "type"]),
        getString(node, ["Data"]),
    ].join(" ").toLowerCase();
    const ordered = /\b(ordered|order|ol|number)\b/.test(listHint);
    let index = 1;
    return (node.Children || [])
        .filter((child) => child.Type === "NodeListItem")
        .map((child) => renderListItem(child, ctx, depth, ordered ? `${index++}.` : "-"))
        .filter(Boolean)
        .join("\n");
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

function renderListItem(node: SiyuanNode, ctx: RenderContext, depth: number, marker: string): string {
    const indent = "  ".repeat(depth);
    const taskMarker = (node.Children || []).some((child) => child.Type === "NodeTaskListItemMarker")
        ? isCheckedTask(node)
            ? "[x] "
            : "[ ] "
        : "";
    const inlineParts: string[] = [];
    const nestedParts: string[] = [];

    for (const child of node.Children || []) {
        if (MARKER_NODE_TYPES.has(child.Type)) continue;
        if (child.Type === "NodeList") {
            nestedParts.push(renderList(child, ctx, depth + 1));
        } else if (child.Type === "NodeParagraph") {
            inlineParts.push(renderChildrenInline(child, ctx).trim());
        } else {
            const rendered = renderBlock(child, ctx).trim();
            if (rendered) inlineParts.push(rendered.replace(/\n+/g, " "));
        }
    }

    const firstLine = `${indent}${marker} ${taskMarker}${inlineParts.filter(Boolean).join(" ").trim()}`.trimEnd();
    return [firstLine, ...nestedParts.filter(Boolean)].join("\n");
}

function renderBlockquote(node: SiyuanNode, ctx: RenderContext): string {
    const content = renderChildrenBlock(node, ctx);
    return content
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
}

function renderCodeBlock(node: SiyuanNode): string {
    const language =
        getString(node, ["CodeBlockInfo", "language", "lang"]) ||
        getString((node.Children || []).find((child) => child.Type === "NodeCodeBlockFenceInfoMarker"), ["Data"]);
    const code =
        getString(node, ["CodeBlockCode", "code", "Data"]) ||
        (node.Children || [])
            .filter((child) => child.Type === "NodeCodeBlockCode")
            .map((child) => getString(child, ["Data"]))
            .join("\n");
    return `\`\`\`${language.trim()}\n${code.replace(/\n$/, "")}\n\`\`\``;
}

function flattenRows(node: SiyuanNode): SiyuanNode[] {
    const rows: SiyuanNode[] = [];
    const visit = (current: SiyuanNode) => {
        if (current.Type === "NodeTableRow") rows.push(current);
        for (const child of current.Children || []) visit(child);
    };
    visit(node);
    return rows;
}

function renderTable(node: SiyuanNode, ctx: RenderContext): string {
    const raw = getString(node, ["Data"]);
    if (raw.trim()) return raw.trim();

    const rows = flattenRows(node)
        .map((row) =>
            (row.Children || [])
                .filter((cell) => cell.Type === "NodeTableCell")
                .map((cell) => escapePipe(textFromChildren(cell, ctx))),
        )
        .filter((row) => row.length > 0);
    if (rows.length === 0) return "";

    const width = Math.max(...rows.map((row) => row.length));
    const normalize = (row: string[]) => Array.from({ length: width }, (_v, i) => row[i] || "");
    const head = normalize(rows[0]);
    const body = rows.slice(1).map(normalize);
    return [
        `| ${head.join(" | ")} |`,
        `| ${head.map(() => "---").join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`),
    ].join("\n");
}

function renderImage(node: SiyuanNode, ctx: RenderContext): string {
    const childDest = getString((node.Children || []).find((child) => child.Type === "NodeLinkDest"), ["Data"]);
    const explicitSrc = getString(node, ["src", "href", "url"]);
    const data = getString(node, ["Data"]);
    const src = childDest || explicitSrc || (looksLikeAssetOrUrl(data) ? data : "");
    const alt =
        getString(node, ["alt", "title"]) ||
        getString((node.Children || []).find((child) => child.Type === "NodeLinkText"), ["Data"]) ||
        textFromChildren(
            (node.Children || []).find((child) => child.Type === "NodeLinkText") || { Type: "NodeLinkText", Children: [] },
            ctx,
        );
    const title = getString((node.Children || []).find((child) => child.Type === "NodeLinkTitle"), ["Data"]);
    if (!src) return alt || "";
    ctx.images.add(src);
    return title ? `![${alt || ""}](${src} "${title.replace(/"/g, "\\\"")}")` : `![${alt || ""}](${src})`;
}

function renderMathBlock(node: SiyuanNode): string {
    const latex =
        getString(node, ["Data", "content", "latex"]) ||
        (node.Children || [])
            .filter((child) => child.Type === "NodeMathBlockContent")
            .map((child) => getString(child, ["Data"]))
            .join("\n");
    return `$$\n${latex.trim()}\n$$`;
}

function extractSrc(text: string): string {
    return text.match(/\bsrc=["']([^"']+)["']/i)?.[1] || text.match(/\(([^)]+)\)/)?.[1] || text.trim();
}

function renderMedia(node: SiyuanNode, ctx: RenderContext): string {
    const raw = getString(node, ["src", "href", "url", "Data", "Tokens", "HTML", "html"]) || renderChildrenInline(node, ctx);
    const src = extractSrc(raw);
    addUnsupported(ctx, node.Type);
    if (src) ctx.attachments.add(src);
    if (node.Type === "NodeIFrame") {
        return src ? `[嵌入内容](${src})` : "";
    }
    if (node.Type === "NodeVideo") {
        return src ? `@[video](${src})` : "";
    }
    if (node.Type === "NodeAudio") {
        return src ? `[音频](${src})` : "";
    }
    if (node.Type === "NodeWidget") {
        return src ? `[挂件内容](${src})` : raw;
    }
    return src ? `[附件](${src})` : "";
}

function renderCallout(node: SiyuanNode, ctx: RenderContext): string {
    const rawType = getString(node, ["CalloutType", "calloutType", "type"]).toUpperCase();
    const allowed = new Set(["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]);
    const type = allowed.has(rawType) ? rawType : "NOTE";
    const title = getString(node, ["CalloutTitle", "title", "Title"]);
    const marker = title ? `[!${type}] ${title}` : `[!${type}]`;
    const body = renderChildrenBlock(node, ctx);
    return [marker, body]
        .filter(Boolean)
        .join("\n\n")
        .split("\n")
        .map((line) => `> ${line}`.trimEnd())
        .join("\n");
}

function renderYamlFrontMatter(node: SiyuanNode): string {
    const raw = getString(node, ["Data", "Tokens", "content", "yaml"]);
    if (!raw.trim()) return "";
    const body = raw.replace(/^---\s*/, "").replace(/\s*---\s*$/, "").trim();
    return body ? `---\n${body}\n---` : "";
}

function renderBlock(node: SiyuanNode, ctx: RenderContext): string {
    if (MARKER_NODE_TYPES.has(node.Type)) return "";
    switch (node.Type) {
        case "NodeDocument":
        case "NodeSuperBlock":
            return renderChildrenBlock(node, ctx);
        case "NodeHeading": {
            const text = renderChildrenInline(node, ctx).trim();
            return text ? `${"#".repeat(getHeadingLevel(node))} ${text}` : "";
        }
        case "NodeParagraph":
            return renderChildrenInline(node, ctx).trim();
        case "NodeText":
        case "NodeTextMark":
            return renderInline(node, ctx);
        case "NodeList":
            return renderList(node, ctx);
        case "NodeBlockquote":
            return renderBlockquote(node, ctx);
        case "NodeCallout":
            return renderCallout(node, ctx);
        case "NodeCodeBlock":
            return renderCodeBlock(node);
        case "NodeYamlFrontMatter":
            return renderYamlFrontMatter(node);
        case "NodeTable":
            return renderTable(node, ctx);
        case "NodeImage":
            return renderImage(node, ctx);
        case "NodeMathBlock":
            return renderMathBlock(node);
        case "NodeHTMLBlock":
        case "NodeInlineHTML":
            return getString(node, ["Data", "Tokens", "HTML", "html"]);
        case "NodeThematicBreak":
            return "---";
        case "NodeBr":
            return "\n";
        case "NodeBlockQueryEmbed":
            addUnsupported(ctx, node.Type, "Siyuan block query embed was imported as a note placeholder.");
            return [
                "> [!NOTE] 思源嵌入块已降级",
                `> ${getString(node, ["Data"]) || "{{embed}}"}`,
            ].join("\n");
        case "NodeAttributeView":
            addUnsupported(ctx, node.Type, "Siyuan attribute view was imported as a placeholder.");
            return "> [!NOTE] 思源数据库/属性视图暂不支持，已保留占位。";
        case "NodeIFrame":
        case "NodeVideo":
        case "NodeAudio":
        case "NodeWidget":
            return renderMedia(node, ctx);
        default: {
            const data = getString(node, ["Data"]);
            const children = renderChildrenBlock(node, ctx);
            if (children) {
                addUnsupported(ctx, "unknown");
                return children;
            }
            if (data) {
                addUnsupported(ctx, "unknown");
                return data;
            }
            addUnsupported(ctx, "unknown", `Unsupported Siyuan node was skipped: ${node.Type}`);
            return "";
        }
    }
}

function toPlainText(markdown: string): string {
    return markdown
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/!\[([^\]]*)]\([^)]+\)/g, "$1")
        .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/[#*_~`>|=\-$\[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

export function siyuanSyToMarkdown(doc: SiyuanNode): SiyuanSyMarkdownResult {
    const ctx: RenderContext = {
        warnings: [],
        unsupportedNodes: {},
        blockRefs: 0,
        wikiLinks: 0,
        tags: new Set(),
        images: new Set(),
        attachments: new Set(),
    };
    const markdown = renderBlock(doc, ctx).replace(/\n{3,}/g, "\n\n").trim();
    const updatedAt = siyuanTimestampToIso(getString(doc, ["updated", "Updated", "UpdateTime", "updatedAt"]));

    return {
        title: getTitle(doc),
        markdown,
        plainText: toPlainText(markdown),
        updatedAt,
        warnings: uniqueSorted(ctx.warnings),
        stats: {
            unsupportedNodes: ctx.unsupportedNodes,
            blockRefs: ctx.blockRefs,
            wikiLinks: ctx.wikiLinks,
            tags: uniqueSorted(ctx.tags),
            images: uniqueSorted(ctx.images),
            attachments: uniqueSorted(ctx.attachments),
        },
    };
}
