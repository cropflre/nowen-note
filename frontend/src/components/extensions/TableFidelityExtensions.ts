import { Extension } from "@tiptap/core";

const TABLE_ALIGNS_ATTR = "data-nowen-table-aligns";
const TABLE_COLGROUP_ATTR = "data-nowen-table-colgroup";
const CELL_ALIGN_ATTR = "data-nowen-cell-align";
const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_ITEMS = 128;
const MAX_METADATA_STRING = 256;

type CellAlign = "left" | "center" | "right";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function normalizeCellAlign(value: unknown): CellAlign | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value === 1) return "left";
    if (value === 2) return "center";
    if (value === 3) return "right";
    return null;
  }

  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "0" || text === "default" || text === "none") return null;
  if (text === "1" || text === "left" || text === "start") return "left";
  if (text === "2" || text === "center" || text === "centre") return "center";
  if (text === "3" || text === "right" || text === "end") return "right";
  return null;
}

function parseJson(raw: string | null): unknown {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sanitizeMetadata(value: unknown, depth = 0): unknown | null {
  if (depth > MAX_METADATA_DEPTH || value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text.slice(0, MAX_METADATA_STRING) : null;
  }
  if (Array.isArray(value)) {
    const out = value
      .slice(0, MAX_METADATA_ITEMS)
      .map((item) => sanitizeMetadata(item, depth + 1))
      .filter((item): item is Exclude<unknown, null> => item !== null);
    return out.length > 0 ? out : null;
  }
  if (!isPlainObject(value)) return null;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_METADATA_ITEMS)) {
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") continue;
    const safe = sanitizeMetadata(item, depth + 1);
    if (safe !== null) out[key.slice(0, 64)] = safe;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeTableAligns(value: unknown): Array<CellAlign | null> | null {
  let source = value;
  if (typeof source === "string") {
    const parsed = parseJson(source);
    source = parsed ?? source.split(/[\s,|]+/).filter(Boolean);
  }
  if (!Array.isArray(source)) return null;
  const aligns = source.slice(0, MAX_METADATA_ITEMS).map(normalizeCellAlign);
  return aligns.some(Boolean) ? aligns : null;
}

function renderJsonAttr(value: unknown): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function parseCellAlign(element: HTMLElement): CellAlign | null {
  const stored = normalizeCellAlign(element.getAttribute(CELL_ALIGN_ATTR));
  if (stored) return stored;

  const direct = normalizeCellAlign(element.getAttribute("align"));
  if (direct) return direct;

  const style = element.getAttribute("style") || "";
  const hit = style.match(/(?:^|;)\s*text-align\s*:\s*([^;]+)/i);
  return normalizeCellAlign(hit?.[1]);
}

/**
 * Shared schema-only compatibility extension.
 *
 * It augments the existing table/tableCell/tableHeader node types instead of
 * replacing Tiptap's table extensions. This keeps the editor, import/export,
 * schema-repair and document-conversion paths on one schema without changing
 * their existing table commands or resize plugins.
 */
export const TableFidelityExtension = Extension.create({
  name: "tableFidelity",

  addGlobalAttributes() {
    return [
      {
        types: ["table"],
        attributes: {
          tableAligns: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              normalizeTableAligns(parseJson(element.getAttribute(TABLE_ALIGNS_ATTR))),
            renderHTML: (attributes: Record<string, unknown>) => {
              const encoded = renderJsonAttr(normalizeTableAligns(attributes.tableAligns));
              return encoded ? { [TABLE_ALIGNS_ATTR]: encoded } : {};
            },
          },
          colgroup: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              sanitizeMetadata(parseJson(element.getAttribute(TABLE_COLGROUP_ATTR))),
            renderHTML: (attributes: Record<string, unknown>) => {
              const encoded = renderJsonAttr(sanitizeMetadata(attributes.colgroup));
              return encoded ? { [TABLE_COLGROUP_ATTR]: encoded } : {};
            },
          },
        },
      },
      {
        types: ["tableCell", "tableHeader"],
        attributes: {
          align: {
            default: null,
            parseHTML: (element: HTMLElement) => parseCellAlign(element),
            renderHTML: (attributes: Record<string, unknown>) => {
              const align = normalizeCellAlign(attributes.align);
              if (!align) return {};
              return {
                [CELL_ALIGN_ATTR]: align,
                style: `text-align: ${align}`,
              };
            },
          },
        },
      },
    ];
  },
});
