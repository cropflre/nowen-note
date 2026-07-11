import {
    siyuanSyToTiptapJson as convertSiyuanCore,
    type SiyuanTiptapConvertOptions,
    type TiptapJsonNode,
} from "./siyuanTiptapConverterCore";
import type { SiyuanNode } from "./siyuanSyParser";

export type { SiyuanTiptapConvertOptions, TiptapJsonNode } from "./siyuanTiptapConverterCore";

type CellAlign = "left" | "center" | "right";

type TiptapMark = NonNullable<TiptapJsonNode["marks"]>[number];

const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_ITEMS = 128;
const MAX_METADATA_STRING = 256;
const MAX_LINK_LENGTH = 4096;
const MAX_CELL_SPAN = 1000;
const MAX_COLWIDTH = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeCellAlign(value: unknown): CellAlign | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        if (value === 1) return "left";
        if (value === 2) return "center";
        if (value === 3) return "right";
        return undefined;
    }

    const text = String(value ?? "").trim().toLowerCase();
    if (!text || text === "0" || text === "default" || text === "none") return undefined;
    if (text === "1" || text === "left" || text === "start") return "left";
    if (text === "2" || text === "center" || text === "centre") return "center";
    if (text === "3" || text === "right" || text === "end") return "right";
    return undefined;
}

function parseMaybeJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    const text = value.trim();
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function normalizeTableAligns(value: unknown): Array<CellAlign | null> | undefined {
    let source = parseMaybeJson(value);
    if (typeof source === "string") {
        source = source.split(/[\s,|]+/).filter(Boolean);
    }
    if (!Array.isArray(source)) return undefined;

    const aligns = source
        .slice(0, MAX_METADATA_ITEMS)
        .map((item) => normalizeCellAlign(item) ?? null);
    return aligns.some(Boolean) ? aligns : undefined;
}

function sanitizeMetadata(value: unknown, depth = 0): unknown | undefined {
    if (depth > MAX_METADATA_DEPTH || value == null) return undefined;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string") {
        const text = value.trim();
        return text ? text.slice(0, MAX_METADATA_STRING) : undefined;
    }
    if (Array.isArray(value)) {
        const out = value
            .slice(0, MAX_METADATA_ITEMS)
            .map((item) => sanitizeMetadata(item, depth + 1))
            .filter((item): item is Exclude<unknown, undefined> => item !== undefined);
        return out.length > 0 ? out : undefined;
    }
    if (!isPlainObject(value)) return undefined;

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_METADATA_ITEMS)) {
        if (!key || key === "__proto__" || key === "prototype" || key === "constructor") continue;
        const safe = sanitizeMetadata(item, depth + 1);
        if (safe !== undefined) out[key.slice(0, 64)] = safe;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeColor(value: unknown): string | undefined {
    const text = String(value ?? "").trim();
    if (!text || text.length > 64 || /[\u0000-\u001f\u007f;{}]/.test(text)) return undefined;
    if (/url\s*\(|expression\s*\(|var\s*\(/i.test(text)) return undefined;
    if (/^#[0-9a-f]{3,4}$/i.test(text) || /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(text)) return text;
    if (/^(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-]+\)$/i.test(text)) return text;
    if (/^(?:transparent|currentcolor|black|white|red|green|blue|gray|grey|yellow|orange|purple|pink)$/i.test(text)) {
        return text;
    }
    return undefined;
}

function sanitizeFontSize(value: unknown): string | undefined {
    const text = String(value ?? "").trim().toLowerCase();
    if (!/^[\d.]+(?:px|em|rem|%)$/.test(text) || text.length > 12) return undefined;
    const match = text.match(/^([\d.]+)(px|em|rem|%)$/);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) return undefined;

    switch (match[2]) {
        case "px":
            return amount >= 8 && amount <= 96 ? text : undefined;
        case "em":
        case "rem":
            return amount >= 0.5 && amount <= 6 ? text : undefined;
        case "%":
            return amount >= 50 && amount <= 600 ? text : undefined;
        default:
            return undefined;
    }
}

function sanitizePositiveInt(value: unknown, max: number): number | undefined {
    const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
    if (!Number.isFinite(parsed)) return undefined;
    const rounded = Math.trunc(parsed);
    return rounded > 0 && rounded <= max ? rounded : undefined;
}

function sanitizeColwidth(value: unknown): number[] | undefined {
    const source = Array.isArray(value) ? value : [value];
    const out = source
        .slice(0, 32)
        .map((item) => sanitizePositiveInt(item, MAX_COLWIDTH))
        .filter((item): item is number => item !== undefined);
    return out.length > 0 ? out : undefined;
}

function sanitizeTextStyleMark(mark: TiptapMark): TiptapMark | null {
    const color = sanitizeColor(mark.attrs?.color);
    const fontSize = sanitizeFontSize(mark.attrs?.fontSize);
    if (!color && !fontSize) return null;
    return {
        type: "textStyle",
        attrs: {
            ...(color ? { color } : {}),
            ...(fontSize ? { fontSize } : {}),
        },
    };
}

function sanitizeHighlightMark(mark: TiptapMark): TiptapMark | null {
    const rawColor = mark.attrs?.color;
    if (rawColor == null || String(rawColor).trim() === "") return { type: "highlight" };
    const color = sanitizeColor(rawColor);
    return color ? { type: "highlight", attrs: { color } } : null;
}

function sanitizeLinkMark(mark: TiptapMark): TiptapMark | null {
    const href = String(mark.attrs?.href ?? "").trim();
    if (!href || href.length > MAX_LINK_LENGTH || /[\u0000-\u001f\u007f]/.test(href)) return null;
    return { type: "link", attrs: { href } };
}

function sanitizeMarks(marks: TiptapJsonNode["marks"]): TiptapJsonNode["marks"] {
    if (!Array.isArray(marks) || marks.length === 0) return undefined;

    // Tiptap's code mark excludes every other mark. Keeping mixed code/link/bold
    // JSON looks fine immediately after import but is silently rewritten on the
    // first schema-aware round-trip. Code therefore wins deterministically.
    if (marks.some((mark) => mark?.type === "code")) {
        return [{ type: "code" }];
    }

    const out: TiptapMark[] = [];
    const seen = new Set<string>();
    for (const mark of marks) {
        if (!mark || typeof mark.type !== "string" || seen.has(mark.type)) continue;

        let safe: TiptapMark | null = null;
        switch (mark.type) {
            case "textStyle":
                safe = sanitizeTextStyleMark(mark);
                break;
            case "highlight":
                safe = sanitizeHighlightMark(mark);
                break;
            case "link":
                safe = sanitizeLinkMark(mark);
                break;
            case "bold":
            case "italic":
            case "strike":
            case "underline":
                safe = { type: mark.type };
                break;
            default:
                break;
        }

        if (safe) {
            seen.add(safe.type);
            out.push(safe);
        }
    }
    return out.length > 0 ? out : undefined;
}

function normalizeGenericNode(node: TiptapJsonNode): TiptapJsonNode {
    const normalized: TiptapJsonNode = {
        type: node.type,
        ...(node.text !== undefined ? { text: String(node.text) } : {}),
        ...(node.attrs && isPlainObject(node.attrs) ? { attrs: { ...node.attrs } } : {}),
    };

    const marks = sanitizeMarks(node.marks);
    if (marks) normalized.marks = marks;
    if (Array.isArray(node.content)) {
        normalized.content = node.content.map(normalizeNode);
    }
    return normalized;
}

function normalizeTableCell(node: TiptapJsonNode, fallbackAlign?: CellAlign): TiptapJsonNode {
    const attrs = isPlainObject(node.attrs) ? { ...node.attrs } : {};
    const colspan = sanitizePositiveInt(attrs.colspan, MAX_CELL_SPAN) ?? 1;
    const rowspan = sanitizePositiveInt(attrs.rowspan, MAX_CELL_SPAN) ?? 1;
    const colwidth = sanitizeColwidth(attrs.colwidth);
    const align = normalizeCellAlign(attrs.align) ?? fallbackAlign;

    return {
        type: node.type === "tableHeader" ? "tableHeader" : "tableCell",
        attrs: {
            colspan,
            rowspan,
            colwidth: colwidth ?? null,
            ...(align ? { align } : {}),
        },
        content: Array.isArray(node.content) && node.content.length > 0
            ? node.content.map(normalizeNode)
            : [{ type: "paragraph" }],
    };
}

function normalizeTableRow(node: TiptapJsonNode, tableAligns?: Array<CellAlign | null>): TiptapJsonNode {
    let columnIndex = 0;
    const cells = Array.isArray(node.content) ? node.content : [];
    const content = cells
        .filter((cell) => cell?.type === "tableCell" || cell?.type === "tableHeader")
        .map((cell) => {
            const span = sanitizePositiveInt(cell.attrs?.colspan, MAX_CELL_SPAN) ?? 1;
            const fallbackAlign = tableAligns?.[columnIndex] ?? undefined;
            const normalized = normalizeTableCell(cell, fallbackAlign ?? undefined);
            columnIndex += span;
            return normalized;
        });

    return {
        type: "tableRow",
        ...(node.attrs && isPlainObject(node.attrs) ? { attrs: { ...node.attrs } } : {}),
        content,
    };
}

function normalizeTable(node: TiptapJsonNode): TiptapJsonNode {
    const attrs = isPlainObject(node.attrs) ? node.attrs : {};
    const tableAligns = normalizeTableAligns(attrs.tableAligns);
    const colgroup = sanitizeMetadata(attrs.colgroup);
    const rows = Array.isArray(node.content)
        ? node.content.filter((row) => row?.type === "tableRow").map((row) => normalizeTableRow(row, tableAligns))
        : [];

    return {
        type: "table",
        attrs: {
            ...(tableAligns ? { tableAligns } : {}),
            ...(colgroup !== undefined ? { colgroup } : {}),
        },
        content: rows,
    };
}

function normalizeNode(node: TiptapJsonNode): TiptapJsonNode {
    if (!node || typeof node.type !== "string") return { type: "paragraph" };
    if (node.type === "table") return normalizeTable(node);
    return normalizeGenericNode(node);
}

/**
 * Convert a SiYuan AST to Tiptap JSON and enforce Nowen's schema/security
 * invariants before the document reaches storage or the editor.
 */
export function siyuanSyToTiptapJson(
    doc: SiyuanNode,
    options: SiyuanTiptapConvertOptions = {},
): string {
    const raw = convertSiyuanCore(doc, options);
    const parsed = JSON.parse(raw) as TiptapJsonNode;
    const normalized = normalizeNode(parsed);
    return JSON.stringify(normalized);
}
