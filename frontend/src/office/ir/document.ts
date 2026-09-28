
// ir/document.ts —— Word 文档的内部数据模型（IR / Document Model）
//
// 这是自研 Office 的核心壁垒：所有 OOXML 解析、UI 渲染、回写导出都
// 围绕这套类型转。现在只放最小集（W1.1），后续按需扩展。
//
// 设计纪律：
//   1. 这套类型不依赖 React、不依赖 DOM、不依赖任何运行时库——纯 TS。
//   2. 字段命名贴近 OOXML 语义（如 runs / paragraphs），但不直接搬 w:p、w:r
//      等 XML 名字，避免和实现耦合。
//   3. 单位统一用「点（pt）」存放——OOXML 里有 EMU、半点、twip、像素混用，
//      解析层负责换算到 pt，渲染层只面对 pt。
//      参考：1 pt = 1/72 inch = 12700 EMU = 20 twip = 2 half-points
//   4. 颜色统一用 6 位 hex 串（不带 #），"auto" 表示跟随主题。

/** Word 文档（一个 .docx 对应一个 DocxIR） */
export interface DocxIR {
  meta: DocMeta;
  /** 顺序章节。最简单的 docx 只有一个 section。 */
  sections: Section[];
  /** OPC 里所有原始 part（图片、字体、关系等），透传备用。 */
  parts?: Map<string, OpcPartLite>;
  /**
   * 解析期间创建的运行时资源，调用方负责在不再使用 IR 时释放。
   * 目前只包含图片 blob URL —— 渲染层 <img src> 直接吃。
   * 释放方式：useEffect cleanup 里 forEach URL.revokeObjectURL。
   */
  resources?: {
    blobUrls?: string[];
  };
}

export interface DocMeta {
  title?: string;
  author?: string;
  created?: string;
  modified?: string;
}

export interface Section {
  /** 页面物理尺寸（pt）。A4 默认 595 × 842。 */
  pageSize?: { w: number; h: number };
  margins?: { top: number; right: number; bottom: number; left: number };
  body: BlockNode[];
}

/** 块级节点：段落或表格（W1.4-A 起）。后续可扩展浮动图片块、目录块等。 */
export type BlockNode = ParagraphNode | TableNode;

// ---------------------------------------------------------------------------
// 表格（W1.4-A）
// ---------------------------------------------------------------------------
//
// OOXML 表格结构：<w:tbl> → <w:tr>+ → <w:tc>+ → <w:p>+
// 单元格可同时跨行（vMerge）和跨列（gridSpan），合并语义比 HTML 复杂：
//   - gridSpan="N"：本格在网格上占 N 列（HTML colSpan）
//   - vMerge="restart"：本格是纵向合并的"顶部"
//   - vMerge="continue"（无 val 或 val="continue"）：本格被上方"吃掉"，HTML 里不应渲染
//
// 解析层负责把 vMerge=continue 的格子在 IR 里"删掉"，在 vMerge=restart 的格子上
// 把 rowSpan 算好，渲染层只用直接吐 colSpan/rowSpan。这样 IR 干净、视图层无脑。

/** 表格节点。 */
export interface TableNode {
  type: "table";
  /**
   * 列宽（pt）。来自 <w:tblGrid>/<w:gridCol w:w="..."/>，twip → pt。
   * 长度等于网格列数；与每行 cell 数量未必一致（gridSpan 的存在）。
   * 缺失时渲染层退化为等分列宽。
   */
  colWidths?: number[];
  /** Whole-table alignment from the rich-text table layout controls. */
  alignment?: "left" | "center" | "right";
  /** Width mode requested by the rich-text editor. */
  widthMode?: "auto" | "full";
  rows: RowNode[];
}

export interface RowNode {
  type: "row";
  cells: CellNode[];
}

export interface CellNode {
  type: "cell";
  /** 本格在网格上占的列数（默认 1）。 */
  gridSpan: number;
  /** 本格纵向合并的行数（默认 1）。仅出现在合并的"顶部"格子上。 */
  rowSpan: number;
  /**
   * 单元格底纹（6 位 hex，无 #）。语义同段落 shading：
   * "auto" / "FFFFFF" 在解析层已过滤，到 IR 这里就是有效色或 undefined。
   */
  shading?: string;
  /**
   * 单元格四边边框颜色（6 位 hex，无 #）。
   * 简化模型：有边框就 1px solid，颜色取 w:color；val="nil"/"none" 时为 undefined。
   * 线型/粗细变体（dashed/double/三线）当前不区分，后续真有需求再加。
   */
  borders?: {
    top?: string;
    right?: string;
    bottom?: string;
    left?: string;
  };
  /**
   * 单元格内的块级内容。OOXML 里单元格可嵌段落、嵌套表格 —— W1.4-A 暂不解析嵌套表格，
   * 遇到 <w:tbl> 直接跳过，单元格里只保留段落。
   */
  body: ParagraphNode[];
}

export interface ParagraphNode {
  type: "paragraph";
  /** 引用 styles.xml 里的样式 ID，如 "Heading1"、"2"、"a3"。 */
  styleId?: string;
  /**
   * 解析 styles.xml 后算好的标题级别（1~6）。非标题段落为 undefined。
   * 之所以不让渲染层自己从 styleId 推断，是因为中文模板里 styleId 常是
   * 内部 ID（如 "2"、"af5"），必须走 styles.xml 的 name 反查 + basedOn 链。
   */
  headingLevel?: number;
  alignment?: "left" | "center" | "right" | "justify";
  /**
   * 段落底纹（w:pPr/w:shd@w:fill）的 6 位 hex（不含 #）。
   * "auto" / "FFFFFF" 当作无底纹处理（解析层负责过滤）。
   * Word 里的代码块、引用块通常靠这个色块识别。
   */
  shading?: string;
  /**
   * 段落缩进（pt）。来自 <w:pPr>/<w:ind>。OOXML 原始单位是 twip（1pt = 20 twip），
   * 解析层已换算。任何字段缺失表示该方向无缩进。
   *   - left / right：段落整体左右缩进
   *   - firstLine：首行额外缩进（与 hanging 互斥，OOXML 也只允许其一生效）
   *   - hanging：悬挂缩进（首行向左凸出，配合 left 使用）
   */
  indent?: {
    left?: number;
    right?: number;
    firstLine?: number;
    /** OOXML character-based first-line indent (2 => two characters). */
    firstLineChars?: number;
    hanging?: number;
  };
  /**
   * 段落间距（pt）。来自 <w:pPr>/<w:spacing>。
   *   - before / after：段前段后空白（pt）
   *   - line：行距值
   *   - lineRule：行距类型，决定 line 的语义：
   *       "auto"     → line 是「倍数」（1.0 = 单倍，1.5 = 1.5 倍）
   *                    OOXML 原始 240 = 单倍，已换算为倍数
   *       "exact"    → line 是「精确行高（pt）」
   *       "atLeast"  → line 是「最小行高（pt）」
   */
  spacing?: {
    before?: number;
    after?: number;
    line?: number;
    lineRule?: "auto" | "exact" | "atLeast";
  };
  /**
   * 列表项标记。来自 <w:numPr>（numId + ilvl）+ numbering.xml 解析。
   * 解析层已根据 lvlText 模板和当前各级计数渲染好 marker 字符串，渲染层
   * 直接显示在段落前即可，不必再做任何模板逻辑。
   *
   * 之所以不引入独立的 ListNode 块级节点：
   *   OOXML 里列表项就是带 numPr 的普通段落，相邻段落之间允许穿插任何东西
   *   （空行、表格、图片），强行包成 <ol>/<ul> 反而要做大量段落分组，
   *   ROI 太低。直接段落自带 list 标签是最简表达。
   */
  list?: {
    numId: number;
    ilvl: number;
    /** 已渲染好的标记字符串，如 "1." / "a)" / "•" */
    marker: string;
    /** 标记格式 —— "bullet" 表示无序，其它都是有序（用于 a11y 标签）。 */
    numFmt: string;
  };
  /** 段落直接的字符级默认（行内 run 不显式覆盖时回退到这里）。 */
  defaultRun?: RunProps;
  /**
   * 段落内联子节点。包括文本 run（RunNode）、内联图片（ImageNode）、超链接（HyperlinkNode）。
   * 之所以图片放在段落 inline 里：Word 的 <w:drawing> 本来就嵌在 <w:r> 内，
   * 视觉上就是行内元素，硬拆成块级会破坏图文混排（虽然 99% 情况下是独立成段）。
   */
  runs: InlineNode[];
}

/** 段落内联子节点联合类型。 */
export type InlineNode = RunNode | ImageNode | HyperlinkNode;

/**
 * 超链接节点。来自 <w:hyperlink r:id="rIdN">（外链）或 w:anchor（文档内书签跳转）。
 * 内部包含若干 RunNode（OOXML 允许超链接内有多个带不同样式的 run）。
 *
 * 渲染建议：
 *   - 没有任何 run 显式 color/underline 时，渲染层应给默认蓝色 + 下划线
 *   - href 以 "#" 开头表示文档内锚点跳转（暂不支持，先原样渲染避免外跳）
 */
export interface HyperlinkNode {
  type: "hyperlink";
  /** 解析后的最终 URL；锚点跳转时形如 "#bookmark_name"。 */
  href: string;
  runs: RunNode[];
}

export interface RunNode {
  type: "run";
  text: string;
  props?: RunProps;
}

/**
 * 内联图片节点。OOXML 里来自 <w:drawing>/<wp:inline>/<a:blip>。
 *
 * 字段说明：
 *   - src：blob URL（推荐）或 data URL。组件 <img src> 直接用。
 *     blob URL 由解析器在 parseDocx 时通过 URL.createObjectURL 创建，
 *     调用方必须在不再使用 IR 时遍历 ir.resources.blobUrls 释放。
 *   - widthPt / heightPt：来自 <wp:extent cx cy>，EMU 已换算为 pt（1pt = 12700 EMU）。
 *   - alt：来自 <wp:docPr descr> 或 <pic:cNvPr descr>，可选无障碍说明。
 */
export interface ImageNode {
  type: "image";
  src: string;
  widthPt?: number;
  heightPt?: number;
  alt?: string;
}

/** 字符级属性。所有字段可选，缺省走样式继承链：run → paragraph → style → docDefaults。 */
export interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 字号（pt）。OOXML w:sz 是半点单位，解析时已 ÷ 2。 */
  fontSize?: number;
  /** 字体名（中文 docx 常见 ASCII / EastAsia 双字体，先收一个，后续再细分）。 */
  fontFamily?: string;
  /** 6 位 hex，不含 #；"auto" 跟随主题。 */
  color?: string;
  /** 高亮色（OOXML 仅支持具名色：yellow / green / cyan ... ） */
  highlight?: string;
}

/** OPC part 透传，避免每次都重新读 zip。 */
export interface OpcPartLite {
  /** part 在 zip 里的全路径，如 "word/document.xml"。 */
  path: string;
  contentType?: string;
  /** 文本类 part 直接给字符串；二进制类（图片）给 Uint8Array。 */
  data: string | Uint8Array;
}
