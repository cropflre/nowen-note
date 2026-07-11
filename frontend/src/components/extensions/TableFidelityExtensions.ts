import { Table, TableCell, TableHeader } from "@tiptap/extension-table";

const TABLE_ALIGNS_ATTR = "data-table-aligns";
const TABLE_COLGROUP_ATTR = "data-table-colgroup";

function parseJsonAttr(raw: string | null): unknown | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return trimmed;
    }
}

function renderJsonAttr(value: unknown): string | null {
    if (value == null) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}

function parseCellAlign(element: HTMLElement): string | null {
    const direct = (element.getAttribute("align") || "").trim();
    if (direct) return direct;
    const style = element.getAttribute("style") || "";
    const hit = style.match(/(?:^|;)\s*text-align\s*:\s*([^;]+)/i);
    return hit?.[1]?.trim() || null;
}

function renderCellAlign(value: unknown): Record<string, string> {
    if (!value) return {};
    const text = String(value).trim();
    if (!text) return {};
    return { align: text };
}

// Preserve SiYuan-specific table metadata across Tiptap schema round-trips.
export const TableWithSiyuanAttrs = Table.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            tableAligns: {
                default: null as unknown,
                parseHTML: (element) => parseJsonAttr(element.getAttribute(TABLE_ALIGNS_ATTR)),
                renderHTML: (attrs) => {
                    const encoded = renderJsonAttr(attrs.tableAligns);
                    return encoded ? { [TABLE_ALIGNS_ATTR]: encoded } : {};
                },
            },
            colgroup: {
                default: null as unknown,
                parseHTML: (element) => parseJsonAttr(element.getAttribute(TABLE_COLGROUP_ATTR)),
                renderHTML: (attrs) => {
                    const encoded = renderJsonAttr(attrs.colgroup);
                    return encoded ? { [TABLE_COLGROUP_ATTR]: encoded } : {};
                },
            },
        };
    },
});

export const TableCellWithAlign = TableCell.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            align: {
                default: null as string | null,
                parseHTML: (element) => parseCellAlign(element as HTMLElement),
                renderHTML: (attrs) => renderCellAlign(attrs.align),
            },
        };
    },
});

export const TableHeaderWithAlign = TableHeader.extend({
    addAttributes() {
        return {
            ...this.parent?.(),
            align: {
                default: null as string | null,
                parseHTML: (element) => parseCellAlign(element as HTMLElement),
                renderHTML: (attrs) => renderCellAlign(attrs.align),
            },
        };
    },
});
