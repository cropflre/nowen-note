import { Extension } from "@tiptap/core";

export type FirstLineIndent = 0 | 2;
export type TableLayoutAlign = "left" | "center" | "right";
export type TableWidthMode = "auto" | "full";

const FIRST_LINE_INDENT_ATTR = "data-first-line-indent";
const TABLE_ALIGN_ATTR = "data-nowen-table-align";
const TABLE_WIDTH_ATTR = "data-nowen-table-width";

export function normalizeFirstLineIndent(value: unknown): FirstLineIndent {
  if (value === 2 || value === "2" || value === "2em") return 2;
  return 0;
}

export function normalizeTableLayoutAlign(value: unknown): TableLayoutAlign {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "center") return "center";
  if (normalized === "right" || normalized === "end") return "right";
  return "left";
}

export function normalizeTableWidthMode(value: unknown): TableWidthMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "full" || normalized === "100%" ? "full" : "auto";
}

function parseStyleValue(style: string, property: string): string {
  const target = property.trim().toLowerCase();
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const key = declaration.slice(0, separator).trim().toLowerCase();
    if (key !== target) continue;
    return declaration.slice(separator + 1).trim();
  }
  return "";
}

function parseFirstLineIndent(element: HTMLElement): FirstLineIndent {
  const stored = normalizeFirstLineIndent(element.getAttribute(FIRST_LINE_INDENT_ATTR));
  if (stored === 2) return 2;

  const styleIndent = parseStyleValue(element.getAttribute("style") || "", "text-indent")
    .replace(/\s+/g, "")
    .toLowerCase();
  return styleIndent === "2em" ? 2 : 0;
}

function parseTableAlign(element: HTMLElement): TableLayoutAlign {
  const stored = element.getAttribute(TABLE_ALIGN_ATTR);
  if (stored) return normalizeTableLayoutAlign(stored);

  const style = element.getAttribute("style") || "";
  const marginLeft = parseStyleValue(style, "margin-left").toLowerCase();
  const marginRight = parseStyleValue(style, "margin-right").toLowerCase();
  if (marginLeft === "auto" && marginRight === "auto") return "center";
  if (marginLeft === "auto" && marginRight === "0") return "right";
  return "left";
}

function parseTableWidth(element: HTMLElement): TableWidthMode {
  const stored = element.getAttribute(TABLE_WIDTH_ATTR);
  if (stored) return normalizeTableWidthMode(stored);

  const width = parseStyleValue(element.getAttribute("style") || "", "width")
    .replace(/\s+/g, "")
    .toLowerCase();
  return width === "100%" ? "full" : "auto";
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    firstLineIndent: {
      setFirstLineIndent: (value: FirstLineIndent) => ReturnType;
      toggleFirstLineIndent: () => ReturnType;
    };
    tableLayout: {
      setTableLayoutAlign: (value: TableLayoutAlign) => ReturnType;
      setTableWidthMode: (value: TableWidthMode) => ReturnType;
    };
  }
}

/**
 * Chinese typography first-line indent.
 *
 * This is intentionally paragraph-only. It never shares the existing block
 * indent attribute, so headings, lists, code blocks and tables keep their
 * current structural/visual indentation semantics.
 */
export const FirstLineIndentExtension = Extension.create({
  name: "firstLineIndent",

  addGlobalAttributes() {
    return [{
      types: ["paragraph"],
      attributes: {
        firstLineIndent: {
          default: 0,
          parseHTML: (element: HTMLElement) => parseFirstLineIndent(element),
          renderHTML: (attributes: Record<string, unknown>) => {
            if (normalizeFirstLineIndent(attributes.firstLineIndent) !== 2) return {};
            return {
              [FIRST_LINE_INDENT_ATTR]: "2",
              style: "text-indent: 2em",
            };
          },
        },
      },
    }];
  },

  addCommands() {
    return {
      setFirstLineIndent:
        (value: FirstLineIndent) =>
        ({ commands }) =>
          commands.updateAttributes("paragraph", {
            firstLineIndent: normalizeFirstLineIndent(value),
          }),
      toggleFirstLineIndent:
        () =>
        ({ editor, commands }) => {
          const current = normalizeFirstLineIndent(
            editor.getAttributes("paragraph").firstLineIndent,
          );
          return commands.updateAttributes("paragraph", {
            firstLineIndent: current === 2 ? 0 : 2,
          });
        },
    };
  },
});

/**
 * Whole-table layout. This is separate from TableFidelityExtension.tableAligns,
 * which represents imported per-column/cell alignment metadata.
 */
export const TableLayoutExtension = Extension.create({
  name: "tableLayout",

  addGlobalAttributes() {
    return [{
      types: ["table"],
      attributes: {
        tableLayoutAlign: {
          default: "left",
          parseHTML: (element: HTMLElement) => parseTableAlign(element),
          renderHTML: (attributes: Record<string, unknown>) => {
            const align = normalizeTableLayoutAlign(attributes.tableLayoutAlign);
            if (align === "center") {
              return {
                [TABLE_ALIGN_ATTR]: "center",
                style: "margin-left: auto; margin-right: auto",
              };
            }
            if (align === "right") {
              return {
                [TABLE_ALIGN_ATTR]: "right",
                style: "margin-left: auto; margin-right: 0",
              };
            }
            return { [TABLE_ALIGN_ATTR]: "left" };
          },
        },
        tableWidthMode: {
          default: "auto",
          parseHTML: (element: HTMLElement) => parseTableWidth(element),
          renderHTML: (attributes: Record<string, unknown>) => {
            const mode = normalizeTableWidthMode(attributes.tableWidthMode);
            return mode === "full"
              ? { [TABLE_WIDTH_ATTR]: "full", style: "width: 100%" }
              : { [TABLE_WIDTH_ATTR]: "auto" };
          },
        },
      },
    }];
  },

  addCommands() {
    return {
      setTableLayoutAlign:
        (value: TableLayoutAlign) =>
        ({ commands }) =>
          commands.updateAttributes("table", {
            tableLayoutAlign: normalizeTableLayoutAlign(value),
          }),
      setTableWidthMode:
        (value: TableWidthMode) =>
        ({ commands }) =>
          commands.updateAttributes("table", {
            tableWidthMode: normalizeTableWidthMode(value),
          }),
    };
  },
});

export const RichTextLayoutExtensions = [
  FirstLineIndentExtension,
  TableLayoutExtension,
];
