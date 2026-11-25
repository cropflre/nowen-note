import { Extension, Node, mergeAttributes } from "@tiptap/core";

export type WordPaperSize = "A4" | "A5" | "Letter";
export type WordOrientation = "portrait" | "landscape";

export interface WordPageSetupAttrs {
  paperSize: WordPaperSize;
  orientation: WordOrientation;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  headerText: string;
  footerText: string;
}

export const DEFAULT_WORD_PAGE_SETUP: WordPageSetupAttrs = {
  paperSize: "A4",
  orientation: "portrait",
  marginTop: 72,
  marginRight: 72,
  marginBottom: 72,
  marginLeft: 72,
  headerText: "",
  footerText: "",
};

const PAPER_DIMENSIONS_PT: Record<WordPaperSize, { w: number; h: number }> = {
  A4: { w: 595, h: 842 },
  A5: { w: 420, h: 595 },
  Letter: { w: 612, h: 792 },
};

export function resolvePaperDimensionsPt(
  paperSize: WordPaperSize,
  orientation: WordOrientation,
): { w: number; h: number } {
  const base = PAPER_DIMENSIONS_PT[paperSize] ?? PAPER_DIMENSIONS_PT.A4;
  return orientation === "landscape" ? { w: base.h, h: base.w } : { ...base };
}

function clampMarginPt(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(18, Math.min(180, Math.round(num)));
}

export function normalizeWordPageSetup(raw: Partial<Record<string, unknown>> | null | undefined): WordPageSetupAttrs {
  const paperRaw = String(raw?.paperSize ?? "").trim();
  const paperSize: WordPaperSize =
    paperRaw === "A5" || paperRaw === "Letter" ? paperRaw : "A4";
  const orientRaw = String(raw?.orientation ?? "").trim().toLowerCase();
  const orientation: WordOrientation = orientRaw === "landscape" ? "landscape" : "portrait";
  return {
    paperSize,
    orientation,
    marginTop: clampMarginPt(raw?.marginTop, DEFAULT_WORD_PAGE_SETUP.marginTop),
    marginRight: clampMarginPt(raw?.marginRight, DEFAULT_WORD_PAGE_SETUP.marginRight),
    marginBottom: clampMarginPt(raw?.marginBottom, DEFAULT_WORD_PAGE_SETUP.marginBottom),
    marginLeft: clampMarginPt(raw?.marginLeft, DEFAULT_WORD_PAGE_SETUP.marginLeft),
    headerText: typeof raw?.headerText === "string" ? raw.headerText.slice(0, 200) : "",
    footerText: typeof raw?.footerText === "string" ? raw.footerText.slice(0, 200) : "",
  };
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: {
      insertPageBreak: () => ReturnType;
    };
    wordLineHeight: {
      setParagraphLineHeight: (lineHeight: string | null) => ReturnType;
    };
  }
}

/**
 * 隐藏的文档级页面配置节点：
 * - 以标准 HTML data-* 属性序列化，可无损通过 repairTiptapJson 的 JSON ↔ HTML round-trip；
 * - 无文本内容，不污染全文检索与普通笔记渲染。
 */
export const WordPageSetupNode = Node.create({
  name: "wordPageSetup",
  group: "block",
  atom: true,
  selectable: false,
  draggable: false,
  defining: true,

  addAttributes() {
    return {
      paperSize: {
        default: DEFAULT_WORD_PAGE_SETUP.paperSize,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-paper-size") || DEFAULT_WORD_PAGE_SETUP.paperSize,
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-paper-size": attrs.paperSize || "A4" }),
      },
      orientation: {
        default: DEFAULT_WORD_PAGE_SETUP.orientation,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-orientation") || DEFAULT_WORD_PAGE_SETUP.orientation,
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-orientation": attrs.orientation || "portrait" }),
      },
      marginTop: {
        default: DEFAULT_WORD_PAGE_SETUP.marginTop,
        parseHTML: (el: HTMLElement) => clampMarginPt(el.getAttribute("data-margin-top"), DEFAULT_WORD_PAGE_SETUP.marginTop),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-margin-top": String(attrs.marginTop ?? 72) }),
      },
      marginRight: {
        default: DEFAULT_WORD_PAGE_SETUP.marginRight,
        parseHTML: (el: HTMLElement) => clampMarginPt(el.getAttribute("data-margin-right"), DEFAULT_WORD_PAGE_SETUP.marginRight),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-margin-right": String(attrs.marginRight ?? 72) }),
      },
      marginBottom: {
        default: DEFAULT_WORD_PAGE_SETUP.marginBottom,
        parseHTML: (el: HTMLElement) => clampMarginPt(el.getAttribute("data-margin-bottom"), DEFAULT_WORD_PAGE_SETUP.marginBottom),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-margin-bottom": String(attrs.marginBottom ?? 72) }),
      },
      marginLeft: {
        default: DEFAULT_WORD_PAGE_SETUP.marginLeft,
        parseHTML: (el: HTMLElement) => clampMarginPt(el.getAttribute("data-margin-left"), DEFAULT_WORD_PAGE_SETUP.marginLeft),
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-margin-left": String(attrs.marginLeft ?? 72) }),
      },
      headerText: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-header-text") || "",
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.headerText ? { "data-header-text": String(attrs.headerText) } : {},
      },
      footerText: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-footer-text") || "",
        renderHTML: (attrs: Record<string, unknown>) =>
          attrs.footerText ? { "data-footer-text": String(attrs.footerText) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-nowen-word-page-setup="true"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-nowen-word-page-setup": "true",
        "aria-hidden": "true",
        hidden: "true",
        style: "display:none",
      }),
    ];
  },
});

/**
 * 显式分页符节点（对应 Word Ctrl+Enter / OOXML <w:br w:type="page"/>）。
 * 打印时强制换页，编辑态显示清晰的分页分隔线。
 */
export const PageBreakExtension = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [
      { tag: 'div[data-type="page-break"]' },
      { tag: 'hr[data-type="page-break"]' },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "page-break",
        class: "nowen-word-page-break",
        role: "separator",
        "aria-label": "分页符",
        contenteditable: "false",
      }),
      ["span", { class: "nowen-word-page-break-label", "aria-hidden": "true" }, "分页符"],
    ];
  },

  addCommands() {
    return {
      insertPageBreak:
        () =>
        ({ chain }) =>
          chain()
            .insertContent([{ type: this.name }, { type: "paragraph" }])
            .focus()
            .run(),
    };
  },

  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => this.editor.commands.insertPageBreak(),
    };
  },
});

const ALLOWED_LINE_HEIGHTS = new Set(["1", "1.15", "1.5", "1.75", "2", "2.5", "3"]);

export function normalizeLineHeightValue(raw: unknown): string | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (ALLOWED_LINE_HEIGHTS.has(text)) return text;
  const num = Number.parseFloat(text);
  if (Number.isFinite(num) && num >= 1 && num <= 3) {
    return String(Math.round(num * 100) / 100);
  }
  return null;
}

/**
 * 段落/标题行距属性扩展（与 DocxIR spacing.line 对应）。
 */
export const WordLineHeightExtension = Extension.create({
  name: "wordLineHeight",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph", "heading"],
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (element: HTMLElement) =>
              normalizeLineHeightValue(
                element.getAttribute("data-line-height") || element.style?.lineHeight,
              ),
            renderHTML: (attributes: Record<string, unknown>) => {
              const normalized = normalizeLineHeightValue(attributes.lineHeight);
              if (!normalized) return {};
              return {
                "data-line-height": normalized,
                style: `line-height: ${normalized}`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setParagraphLineHeight:
        (lineHeight: string | null) =>
        ({ chain }) => {
          const normalized = normalizeLineHeightValue(lineHeight);
          return chain()
            .updateAttributes("paragraph", { lineHeight: normalized })
            .updateAttributes("heading", { lineHeight: normalized })
            .run();
        },
    };
  },
});

export const WordDocumentExtensions = [
  WordPageSetupNode,
  PageBreakExtension,
  WordLineHeightExtension,
];
