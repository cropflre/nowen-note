// parsers/docx-parser.ts —— OOXML（.docx） → IR
//
// 当前范围（W1.1 + W1.4 增量）：
//   ✅ word/document.xml 主体段落
//   ✅ run（w:r）+ 文本（w:t、w:tab、w:br）
//   ✅ 字符级属性：bold / italic / underline / strike / color / sz / fontFamily
//   ✅ 段落对齐（w:jc）+ 段落 styleId（w:pStyle）
//   ✅ 段落底纹（w:shd）—— 代码块/引用块识别
//   ✅ 段落缩进（w:ind）+ 段落间距（w:spacing） —— W1.4 增量
//   ✅ 标题级别推断（走 styles.xml）
//   ✅ 内联图片 <w:drawing>/<wp:inline>（blob URL，不做 base64 内嵌）
//   ✅ 超链接 <w:hyperlink>（外链 rId + 文档锚点 anchor） —— W1.4 增量
//   ✅ docProps/core.xml 元数据（标题/作者/时间）
//   ❌ 表格（w:tbl）、列表（w:numPr）、浮动图片绕排、页眉页脚 —— 后续里程碑
//
// 解析哲学：
//   - 用浏览器原生 DOMParser，按 localName 匹配元素（OOXML 命名空间多变体，
//     用 ns 前缀匹配反而易碎）
//   - 字段缺失静默降级（不 throw），保证"半坏的 docx"也能预览到大部分内容
//   - 单位换算在解析层完成（IR 永远拿 pt）

import type { DocxIR, ParagraphNode, RunProps, Section, ImageNode, InlineNode, BlockNode, TableNode, RowNode, CellNode } from "../ir/document";
import { OpcPackage, type OpcRelationship } from "../opc/reader";
import { parseStyles, resolveHeadingLevel, type StyleMap } from "./styles";
import { parseNumbering, renderMarker, type NumberingMap } from "./numbering";

/**
 * 解析期间的上下文 —— 在多层函数间传递 styles / 关系表 / 图片资源。
 * 把 blobUrls 收集起来，最终塞进 IR.resources，调用方负责释放。
 */
interface ParseCtx {
  pkg: OpcPackage;
  styleMap: StyleMap;
  /** numbering.xml 解析结果：numId → 各 level 定义。文档无 numbering 时为空 map。 */
  numberingMap: NumberingMap;
  /**
   * 列表计数器：counters.get(numId)?.[ilvl] = 当前已发出的最大编号。
   * 跨段累加；遇到更高 level（更小 ilvl）时把更深层级清零。
   */
  counters: Map<number, number[]>;
  /** word/document.xml 的关系表（rId → target 路径等）。 */
  rels: Map<string, OpcRelationship>;
  /** 已解析过的 image part → blob URL 缓存（同一图片被多处引用时复用）。 */
  imageCache: Map<string, string>;
  /** 收集到的所有 blob URL，用于 IR.resources。 */
  blobUrls: string[];
  /** 解析过程中发现的降级/不支持特性提示（去重）。 */
  warnings: Set<string>;
}

/** 主入口：把一份 docx 读成 IR。 */
export async function parseDocx(
  input: File | Blob | ArrayBuffer | Uint8Array,
): Promise<DocxIR> {
  const pkg = await OpcPackage.load(input);

  const meta = await parseCoreProps(pkg);
  // 先加载 styles.xml —— 段落标题/底纹识别都依赖它
  const styleMap = parseStyles((await pkg.getXml("word/styles.xml")) ?? null);
  // numbering.xml 可选：纯文本 docx 不会有这个 part
  const numberingMap = parseNumbering(await pkg.getXml("word/numbering.xml"));
  // 关系表：图片 / 超链接 / 主题等，rId → target
  const rels = await pkg.getRels("word/document.xml");

  const ctx: ParseCtx = {
    pkg,
    styleMap,
    numberingMap,
    counters: new Map(),
    rels,
    imageCache: new Map(),
    blobUrls: [],
    warnings: new Set(),
  };

  const { body, sectionMeta } = await parseBody(ctx);

  const section: Section = {
    pageSize: sectionMeta.pageSize ?? { w: 595, h: 842 }, // A4 默认
    orientation: sectionMeta.orientation,
    margins: sectionMeta.margins ?? { top: 72, right: 72, bottom: 72, left: 72 }, // 1 inch
    headerText: sectionMeta.headerText,
    footerText: sectionMeta.footerText,
    body,
  };

  return {
    meta,
    sections: [section],
    resources: ctx.blobUrls.length ? { blobUrls: ctx.blobUrls } : undefined,
    warnings: ctx.warnings.size ? Array.from(ctx.warnings) : undefined,
  };
}

// ---------------------------------------------------------------------------
// docProps/core.xml —— 元数据
// ---------------------------------------------------------------------------

async function parseCoreProps(pkg: OpcPackage) {
  const doc = await pkg.getXml("docProps/core.xml");
  if (!doc) return {};
  const get = (local: string) => firstByLocalName(doc.documentElement, local)?.textContent || undefined;
  return {
    title: get("title"),
    author: get("creator"),
    created: get("created"),
    modified: get("modified"),
  };
}

// ---------------------------------------------------------------------------
// word/document.xml —— 主体
// ---------------------------------------------------------------------------

interface ParsedSectionMeta {
  pageSize?: { w: number; h: number };
  orientation?: "portrait" | "landscape";
  margins?: { top: number; right: number; bottom: number; left: number };
  headerText?: string;
  footerText?: string;
}

async function parseSectionProps(sectPr: Element, ctx: ParseCtx): Promise<ParsedSectionMeta> {
  const out: ParsedSectionMeta = {};
  const pgSz = firstByLocalName(sectPr, "pgSz");
  if (pgSz) {
    const w = parseFloat(pgSz.getAttribute("w:w") || pgSz.getAttribute("w") || "");
    const h = parseFloat(pgSz.getAttribute("w:h") || pgSz.getAttribute("h") || "");
    if (Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0) {
      out.pageSize = { w: Math.round(w / 20), h: Math.round(h / 20) };
    }
    const orient = (pgSz.getAttribute("w:orient") || pgSz.getAttribute("orient") || "").toLowerCase();
    if (orient === "landscape" || (out.pageSize && out.pageSize.w > out.pageSize.h)) {
      out.orientation = "landscape";
    } else if (out.pageSize) {
      out.orientation = "portrait";
    }
  }
  const pgMar = firstByLocalName(sectPr, "pgMar");
  if (pgMar) {
    const readTwip = (name: string, fallback: number) => {
      const raw = parseFloat(pgMar.getAttribute(`w:${name}`) || pgMar.getAttribute(name) || "");
      return Number.isFinite(raw) && raw >= 0 ? Math.round(raw / 20) : fallback;
    };
    out.margins = {
      top: readTwip("top", 72),
      right: readTwip("right", 72),
      bottom: readTwip("bottom", 72),
      left: readTwip("left", 72),
    };
  }
  for (const child of childElements(sectPr)) {
    if (child.localName !== "headerReference" && child.localName !== "footerReference") continue;
    const type = (child.getAttribute("w:type") || child.getAttribute("type") || "default").toLowerCase();
    if (type !== "default" && out[child.localName === "headerReference" ? "headerText" : "footerText"]) continue;
    const rId =
      child.getAttribute("r:id") ||
      child.getAttribute("id") ||
      child.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    if (!rId) continue;
    const rel = ctx.rels.get(rId);
    if (!rel || rel.external) continue;
    const partPath = resolveRelTarget("word/document.xml", rel.target);
    const xml = await ctx.pkg.getXml(partPath);
    if (!xml) continue;
    const text = (xml.documentElement.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (child.localName === "headerReference") out.headerText = text;
    else out.footerText = text;
  }
  return out;
}

function paragraphHasPageBreak(p: Element): { before: boolean; inlineBreak: boolean } {
  const pPr = firstByLocalName(p, "pPr");
  const before = Boolean(pPr && firstByLocalName(pPr, "pageBreakBefore"));
  let inlineBreak = false;
  for (const child of childElements(p)) {
    if (child.localName !== "r") continue;
    for (const rChild of childElements(child)) {
      if (rChild.localName === "br") {
        const t = (rChild.getAttribute("w:type") || rChild.getAttribute("type") || "").toLowerCase();
        if (t === "page") inlineBreak = true;
      }
    }
  }
  return { before, inlineBreak };
}

function detectUnsupportedFeatures(bodyEl: Element, ctx: ParseCtx): void {
  const stack: Element[] = [bodyEl];
  while (stack.length) {
    const el = stack.pop()!;
    const name = el.localName;
    if (name === "ins" || name === "del") {
      ctx.warnings.add("文档包含修订记录，导入后仅保留正文内容");
    } else if (name === "commentRangeStart") {
      ctx.warnings.add("文档包含 Word 批注，批注内容不会自动迁移");
    } else if (name === "txbxContent") {
      ctx.warnings.add("文档包含浮动文本框，部分排版位置可能简化");
    } else if (name === "graphicData") {
      const uri = (el.getAttribute("uri") || "").toLowerCase();
      if (uri.includes("diagram") || uri.includes("chart")) {
        ctx.warnings.add("文档包含 SmartArt 或图表，无法完整保留为可编辑对象");
      }
    }
    const list = el.children;
    for (let i = 0; i < list.length; i++) stack.push(list[i]);
  }
}

async function parseBody(ctx: ParseCtx): Promise<{ body: BlockNode[]; sectionMeta: ParsedSectionMeta }> {
  const doc = await ctx.pkg.getXml("word/document.xml");
  if (!doc) return { body: [], sectionMeta: {} };
  const bodyEl = firstByLocalName(doc.documentElement, "body");
  if (!bodyEl) return { body: [], sectionMeta: {} };

  detectUnsupportedFeatures(bodyEl, ctx);

  const blocks: BlockNode[] = [];
  let sectionMeta: ParsedSectionMeta = {};
  for (const child of childElements(bodyEl)) {
    if (child.localName === "p") {
      const br = paragraphHasPageBreak(child);
      if (br.before) blocks.push({ type: "pageBreak" });
      const para = await parseParagraph(child, ctx);
      const hasContent = para.runs.some((r) => (r.type === "run" ? r.text.length > 0 : true));
      if (hasContent || !br.inlineBreak) {
        blocks.push(para);
      }
      if (br.inlineBreak) {
        blocks.push({ type: "pageBreak" });
      }
    } else if (child.localName === "tbl") {
      const tbl = await parseTable(child, ctx);
      if (tbl) blocks.push(tbl);
    } else if (child.localName === "sectPr") {
      sectionMeta = await parseSectionProps(child, ctx);
    }
  }
  return { body: blocks, sectionMeta };
}

// ---------------------------------------------------------------------------
// 表格 <w:tbl>（W1.4-A）
// ---------------------------------------------------------------------------
//
// 解析两阶段：
//   1) 先按 OOXML 原样把每行的 cell 全部读出来（含 vMerge=continue 占位），
//      因为 vMerge 的"顶部"在前面行，必须等所有行读完才能知道它跨几行。
//   2) 后处理：扫描"网格列位置"，把 vMerge=restart 的格子 rowSpan 算好，
//      把 vMerge=continue 的格子从 IR 里移除。
//
// 注意：一行里 cells 的"逻辑列起点"是前面 cell 的 gridSpan 累加，不是数组下标，
// 所以纵向合并扫描必须按"列位置"对齐，不能按数组下标。

async function parseTable(tbl: Element, ctx: ParseCtx): Promise<TableNode | null> {
  // 列宽：<w:tblGrid>/<w:gridCol w:w="..."/>
  const colWidths: number[] = [];
  const tblGrid = firstByLocalName(tbl, "tblGrid");
  if (tblGrid) {
    for (const gc of childElements(tblGrid)) {
      if (gc.localName !== "gridCol") continue;
      const w = parseFloat(gc.getAttribute("w:w") || gc.getAttribute("w") || "");
      if (Number.isFinite(w) && w > 0) colWidths.push(w / 20); // twip → pt
    }
  }

  // 阶段 1：读所有行，cell 按 OOXML 原样保留（含 vMerge 继续位）
  // 用一个临时数组 rawRows，每个元素是 { cells: RawCell[] }
  type RawCell = CellNode & { vMerge: "restart" | "continue" | null };
  const rawRows: { cells: RawCell[] }[] = [];

  for (const child of childElements(tbl)) {
    if (child.localName !== "tr") continue;
    const cells: RawCell[] = [];
    for (const tc of childElements(child)) {
      if (tc.localName !== "tc") continue;
      const cell = await parseCell(tc, ctx);
      cells.push(cell);
    }
    rawRows.push({ cells });
  }

  if (rawRows.length === 0) return null;

  // 阶段 2：vMerge 后处理 —— 按"网格列起点"做纵向合并。
  // rowStartCol[i][k] = 第 i 行第 k 个 cell 在网格上的起始列 index，方便对齐。
  const rowStartCol: number[][] = rawRows.map((row) => {
    const starts: number[] = [];
    let cursor = 0;
    for (const c of row.cells) {
      starts.push(cursor);
      cursor += c.gridSpan;
    }
    return starts;
  });

  // 对每个 vMerge=restart 的 cell，向下一直找 vMerge=continue 且列起点相同的格子，
  // 累加 rowSpan，并把那些 continue 格子标记为"删除"。
  const deletedMask: boolean[][] = rawRows.map((row) => row.cells.map(() => false));

  for (let r = 0; r < rawRows.length; r++) {
    const cells = rawRows[r].cells;
    const starts = rowStartCol[r];
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      if (cell.vMerge !== "restart") continue;
      const colStart = starts[c];
      let span = 1;
      for (let r2 = r + 1; r2 < rawRows.length; r2++) {
        // 在 r2 行找列起点 == colStart 的格子
        const starts2 = rowStartCol[r2];
        const idx = starts2.indexOf(colStart);
        if (idx < 0) break;
        const cell2 = rawRows[r2].cells[idx];
        if (cell2.vMerge !== "continue") break;
        deletedMask[r2][idx] = true;
        span += 1;
      }
      cell.rowSpan = span;
    }
    // 孤立的 vMerge=continue（找不到 restart 头）：保留为普通格，避免吞内容
    // —— 已经默认 rowSpan=1，不做处理即可。
  }

  // 输出：剥掉 vMerge 字段，剔除被合并掉的格子
  const rows: RowNode[] = rawRows.map((row, r) => ({
    type: "row" as const,
    cells: row.cells
      .filter((_, c) => !deletedMask[r][c])
      .map<CellNode>((c) => ({
        type: "cell",
        gridSpan: c.gridSpan,
        rowSpan: c.rowSpan,
        shading: c.shading,
        borders: c.borders,
        body: c.body,
      })),
  }));

  return {
    type: "table",
    colWidths: colWidths.length ? colWidths : undefined,
    rows,
  };
}

async function parseCell(
  tc: Element,
  ctx: ParseCtx,
): Promise<CellNode & { vMerge: "restart" | "continue" | null }> {
  let gridSpan = 1;
  let vMerge: "restart" | "continue" | null = null;
  let shading: string | undefined;
  let borders: CellNode["borders"];

  const tcPr = firstByLocalName(tc, "tcPr");
  if (tcPr) {
    const gs = firstByLocalName(tcPr, "gridSpan");
    if (gs) {
      const v = parseInt(gs.getAttribute("w:val") || gs.getAttribute("val") || "1", 10);
      if (Number.isFinite(v) && v > 1) gridSpan = v;
    }
    const vm = firstByLocalName(tcPr, "vMerge");
    if (vm) {
      const v = (vm.getAttribute("w:val") || vm.getAttribute("val") || "continue").toLowerCase();
      vMerge = v === "restart" ? "restart" : "continue";
    }
    const shd = firstByLocalName(tcPr, "shd");
    if (shd) {
      const fill = (shd.getAttribute("w:fill") || shd.getAttribute("fill") || "").toLowerCase();
      if (fill && fill !== "auto" && fill !== "ffffff") shading = fill;
    }
    const tcBorders = firstByLocalName(tcPr, "tcBorders");
    if (tcBorders) {
      borders = {};
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const b = firstByLocalName(tcBorders, side);
        if (!b) continue;
        const val = (b.getAttribute("w:val") || b.getAttribute("val") || "").toLowerCase();
        // val="nil" / "none" 表示无边框；其它值（single/double/dashed/...）一律画 1px 实线
        if (val === "nil" || val === "none") continue;
        const color = (b.getAttribute("w:color") || b.getAttribute("color") || "auto").toLowerCase();
        // "auto" 留给渲染层用主题色；这里给 "000000" 兜底
        borders[side] = color === "auto" ? "000000" : color;
      }
      if (Object.keys(borders).length === 0) borders = undefined;
    }
  }

  // 单元格内容：只收段落，遇到嵌套表格当前直接跳过（W1.4-A 不做嵌套表）
  const body: ParagraphNode[] = [];
  for (const child of childElements(tc)) {
    if (child.localName === "p") {
      body.push(await parseParagraph(child, ctx));
    }
    // child.localName === "tbl" 时跳过
  }

  return {
    type: "cell",
    gridSpan,
    rowSpan: 1, // 后处理阶段才会改写
    shading,
    borders,
    body,
    vMerge,
  };
}

async function parseParagraph(p: Element, ctx: ParseCtx): Promise<ParagraphNode> {
  const node: ParagraphNode = { type: "paragraph", runs: [] };
  const pPr = firstByLocalName(p, "pPr");
  if (pPr) {
    const styleEl = firstByLocalName(pPr, "pStyle");
    if (styleEl) {
      const id = styleEl.getAttribute("w:val") || styleEl.getAttribute("val");
      if (id) {
        node.styleId = id;
        const lvl = resolveHeadingLevel(id, ctx.styleMap);
        if (lvl) node.headingLevel = lvl;
      }
    }
    // 段落底纹 w:shd@w:fill —— Word 里代码块/引用块通常靠这个
    const shdEl = firstByLocalName(pPr, "shd");
    if (shdEl) {
      const fill = (shdEl.getAttribute("w:fill") || shdEl.getAttribute("fill") || "").toLowerCase();
      // "auto" 表示无底纹；纯白也当作没底纹（避免给所有段落套灰框）
      if (fill && fill !== "auto" && fill !== "ffffff") {
        node.shading = fill;
      }
    }
    const jcEl = firstByLocalName(pPr, "jc");
    if (jcEl) {
      const v = (jcEl.getAttribute("w:val") || jcEl.getAttribute("val") || "").toLowerCase();
      // OOXML "both" 对应"两端对齐"，IR 归一化为 justify
      const map: Record<string, ParagraphNode["alignment"]> = {
        left: "left",
        start: "left",
        center: "center",
        right: "right",
        end: "right",
        both: "justify",
        justify: "justify",
        distribute: "justify",
      };
      if (map[v]) node.alignment = map[v];
    }

    // 段落缩进 <w:ind>：left / right / firstLine / hanging，原始单位 twip
    const indEl = firstByLocalName(pPr, "ind");
    if (indEl) {
      const ind: NonNullable<ParagraphNode["indent"]> = {};
      // OOXML 同时支持 w:left 和 w:start（双向文本时的别名），取存在的那个
      const left = readTwipAttr(indEl, ["w:left", "left", "w:start", "start"]);
      const right = readTwipAttr(indEl, ["w:right", "right", "w:end", "end"]);
      const firstLine = readTwipAttr(indEl, ["w:firstLine", "firstLine"]);
      const hanging = readTwipAttr(indEl, ["w:hanging", "hanging"]);
      if (left !== undefined) ind.left = left;
      if (right !== undefined) ind.right = right;
      if (firstLine !== undefined) ind.firstLine = firstLine;
      if (hanging !== undefined) ind.hanging = hanging;
      if (Object.keys(ind).length) node.indent = ind;
    }

    // 列表项 <w:numPr>：取 ilvl + numId，结合 numbering.xml 的 lvlText 渲染 marker
    // 注意计数副作用：上一段如果是更深层级（ilvl=1），下一段回到 ilvl=0 时
    // ilvl=1 的计数必须重置，否则 "1./a)/b)/2./a)" 会变成 "1./a)/b)/2./c)"。
    const numPr = firstByLocalName(pPr, "numPr");
    if (numPr) {
      const list = applyNumPr(numPr, ctx);
      if (list) node.list = list;
    }

    // 段落间距 <w:spacing>：before / after（twip），line + lineRule
    const spEl = firstByLocalName(pPr, "spacing");
    if (spEl) {
      const sp: NonNullable<ParagraphNode["spacing"]> = {};
      const before = readTwipAttr(spEl, ["w:before", "before"]);
      const after = readTwipAttr(spEl, ["w:after", "after"]);
      if (before !== undefined) sp.before = before;
      if (after !== undefined) sp.after = after;
      const lineRaw = spEl.getAttribute("w:line") || spEl.getAttribute("line");
      const ruleRaw = (spEl.getAttribute("w:lineRule") || spEl.getAttribute("lineRule") || "auto").toLowerCase();
      if (lineRaw) {
        const lineNum = parseFloat(lineRaw);
        if (Number.isFinite(lineNum) && lineNum > 0) {
          if (ruleRaw === "exact" || ruleRaw === "atleast") {
            sp.line = lineNum / 20; // twip → pt
            sp.lineRule = ruleRaw === "exact" ? "exact" : "atLeast";
          } else {
            // auto：240 单位 = 1.0 倍行距
            sp.line = lineNum / 240;
            sp.lineRule = "auto";
          }
        }
      }
      if (Object.keys(sp).length) node.spacing = sp;
    }

    const rPr = firstByLocalName(pPr, "rPr");
    if (rPr) {
      const dp = parseRunProps(rPr);
      if (dp) node.defaultRun = dp;
    }
  }

  for (const child of childElements(p)) {
    if (child.localName === "r") {
      const inlines = await parseRun(child, ctx);
      node.runs.push(...inlines);
    } else if (child.localName === "hyperlink") {
      const linkNode = await parseHyperlink(child, ctx);
      if (linkNode) node.runs.push(linkNode);
    }
  }

  return node;
}

/**
 * 处理 <w:numPr>：累加计数 + 渲染 marker。
 *
 * 计数规则（W3C numFmt 标准）：
 *   - 命中 ilvl=L：counters[L] += 1；同时 counters[L+1..] 清零（重启更深层级）
 *   - 没有该 ilvl 的定义：跳过，返回 null（段落退回普通段落）
 *
 * 注意 counters 数组用 ilvl 直接索引（0~8），稀疏区域为 0。
 */
function applyNumPr(
  numPr: Element,
  ctx: ParseCtx,
): NonNullable<ParagraphNode["list"]> | null {
  const ilvlEl = firstByLocalName(numPr, "ilvl");
  const numIdEl = firstByLocalName(numPr, "numId");
  const ilvl = parseInt(
    ilvlEl?.getAttribute("w:val") || ilvlEl?.getAttribute("val") || "0",
    10,
  );
  const numId = parseInt(
    numIdEl?.getAttribute("w:val") || numIdEl?.getAttribute("val") || "",
    10,
  );
  if (!Number.isFinite(numId) || numId === 0) return null; // numId=0 在 OOXML 里表示"取消列表"

  const levels = ctx.numberingMap.get(numId);
  if (!levels || levels.length === 0) return null;
  // ilvl 超界（罕见，docx 损坏时会出现）退回到最大可用层级，避免整段丢内容
  const safeIlvl = Math.max(0, Math.min(ilvl, levels.length - 1));
  const def = levels[safeIlvl];
  if (!def) return null;

  // 取或建该 numId 的计数数组
  let counters = ctx.counters.get(numId);
  if (!counters) {
    counters = new Array(levels.length).fill(0);
    ctx.counters.set(numId, counters);
  }
  // 第一次进入某 level：从 def.start 起跳；之后 +1
  if (counters[safeIlvl] === 0) {
    counters[safeIlvl] = def.start;
  } else {
    counters[safeIlvl] += 1;
  }
  // 重置更深层级（把 a/b/c/... 重新从 a 开始）
  for (let i = safeIlvl + 1; i < counters.length; i++) counters[i] = 0;

  return {
    numId,
    ilvl: safeIlvl,
    marker: renderMarker(def, counters, levels),
    numFmt: def.numFmt,
  };
}

/**
 * <w:hyperlink> → HyperlinkNode
 *
 * 两种形式：
 *   1) r:id="rIdN"  → 外链，从关系表查 target
 *   2) w:anchor="bookmark" → 文档内书签跳转，href 用 "#bookmark"
 *
 * 解析期把 hyperlink 内的所有 <w:r> 摊平成一组 RunNode（不再保留嵌套图片，
 * 真实场景里超链接里几乎不放图片；如果遇到忽略不渲染，避免 IR 类型循环）。
 * 解析失败（找不到 rel）时退化成普通文字，避免吞内容。
 */
async function parseHyperlink(
  el: Element,
  ctx: ParseCtx,
): Promise<import("../ir/document").HyperlinkNode | null> {
  // 收集内部 run（忽略图片节点 —— 超链接内放图片极少且 IR 不允许 hyperlink 嵌图片）
  const runs: import("../ir/document").RunNode[] = [];
  for (const sub of childElements(el)) {
    if (sub.localName === "r") {
      const inlines = await parseRun(sub, ctx);
      for (const n of inlines) {
        if (n.type === "run") runs.push(n);
      }
    }
  }
  if (runs.length === 0) return null;

  // 解析 href
  const rId =
    el.getAttribute("r:id") ||
    el.getAttribute("id") ||
    el.getAttributeNS(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "id",
    );
  const anchor = el.getAttribute("w:anchor") || el.getAttribute("anchor");

  let href = "";
  if (rId) {
    const rel = ctx.rels.get(rId);
    if (rel) href = rel.target || "";
    // 同时带 r:id 和 w:anchor 时，OOXML 语义是"先打开 url，再跳到锚点"
    if (href && anchor) href += `#${anchor}`;
  } else if (anchor) {
    href = `#${anchor}`;
  }

  if (!href) {
    // 没拿到 url —— 退化：把内部文本仍然渲染出来（不丢内容）
    // 用一个"空 href"的链接节点而非 run，渲染层会按禁用样式处理
    href = "";
  }

  return { type: "hyperlink", href, runs };
}

/**
 * 读取一个 twip 单位的属性，按多个候选 key 尝试（应对 ns 前缀差异），换算为 pt。
 * OOXML 允许负值（悬挂缩进等场景），保留符号。
 */
function readTwipAttr(el: Element, keys: string[]): number | undefined {
  for (const k of keys) {
    const raw = el.getAttribute(k);
    if (raw == null || raw === "") continue;
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return n / 20;
  }
  return undefined;
}

/**
 * 一个 w:r 节点可能包含多段文字 + 多个 break/tab + drawing，所以返回 InlineNode 数组。
 * 我们把 break 和 tab 也表达成 run（用特殊文本：\n / \t），UI 层渲染时识别。
 */
async function parseRun(r: Element, ctx: ParseCtx): Promise<InlineNode[]> {
  const props = parseRunProps(firstByLocalName(r, "rPr"));
  const out: InlineNode[] = [];

  for (const child of childElements(r)) {
    switch (child.localName) {
      case "t": {
        // xml:space="preserve" 时空格必须保留——textContent 已经按 XML 文本拿
        // 完整原样字符，不需要额外处理
        const text = child.textContent || "";
        if (text) out.push({ type: "run", text, props });
        break;
      }
      case "tab":
        out.push({ type: "run", text: "\t", props });
        break;
      case "br": {
        const brType = (child.getAttribute("w:type") || child.getAttribute("type") || "").toLowerCase();
        // 分页符已由 parseBody 提升为独立 PageBreakNode，避免重复写入换行符
        if (brType !== "page") {
          out.push({ type: "run", text: "\n", props });
        }
        break;
      }
      case "drawing": {
        const img = await parseDrawing(child, ctx);
        if (img) out.push(img);
        break;
      }
      // W1.4: pict（旧 VML 图片）、softHyphen、noBreakHyphen、sym 暂忽略
    }
  }
  return out;
}

function parseRunProps(rPr: Element | null | undefined): RunProps | undefined {
  if (!rPr) return undefined;
  const p: RunProps = {};

  const has = (local: string) => firstByLocalName(rPr, local) !== null;
  // OOXML 里 <w:b/> 出现 = true，<w:b w:val="false"/> = false
  const flag = (local: string): boolean | undefined => {
    const el = firstByLocalName(rPr, local);
    if (!el) return undefined;
    const v = (el.getAttribute("w:val") || el.getAttribute("val") || "").toLowerCase();
    if (v === "" || v === "true" || v === "1" || v === "on") return true;
    if (v === "false" || v === "0" || v === "off") return false;
    return true;
  };

  const b = flag("b");
  if (b !== undefined) p.bold = b;
  const i = flag("i");
  if (i !== undefined) p.italic = i;
  // <w:u w:val="single"/>：只要 val 不是 "none" 就算下划线
  const uEl = firstByLocalName(rPr, "u");
  if (uEl) {
    const v = (uEl.getAttribute("w:val") || uEl.getAttribute("val") || "").toLowerCase();
    p.underline = v !== "none";
  }
  if (has("strike") || has("dstrike")) p.strike = true;

  // 字号 w:sz 是半点单位（half-points）
  const szEl = firstByLocalName(rPr, "sz");
  if (szEl) {
    const v = parseFloat(szEl.getAttribute("w:val") || szEl.getAttribute("val") || "");
    if (Number.isFinite(v) && v > 0) p.fontSize = v / 2;
  }

  // 颜色：w:val 可能是 "auto" 或 6 位 hex
  const colorEl = firstByLocalName(rPr, "color");
  if (colorEl) {
    const v = colorEl.getAttribute("w:val") || colorEl.getAttribute("val");
    if (v) p.color = v.toLowerCase();
  }

  // 高亮（具名色）
  const hlEl = firstByLocalName(rPr, "highlight");
  if (hlEl) {
    const v = hlEl.getAttribute("w:val") || hlEl.getAttribute("val");
    if (v) p.highlight = v.toLowerCase();
  }

  // 字体名：w:rFonts 上有 ascii / eastAsia / hAnsi / cs。中文文档 eastAsia 优先。
  const fontsEl = firstByLocalName(rPr, "rFonts");
  if (fontsEl) {
    const ea =
      fontsEl.getAttribute("w:eastAsia") || fontsEl.getAttribute("eastAsia");
    const ascii =
      fontsEl.getAttribute("w:ascii") || fontsEl.getAttribute("ascii");
    const hAnsi =
      fontsEl.getAttribute("w:hAnsi") || fontsEl.getAttribute("hAnsi");
    p.fontFamily = ea || ascii || hAnsi || undefined;
  }

  return Object.keys(p).length ? p : undefined;
}

// ---------------------------------------------------------------------------
// 图片：<w:drawing> → ImageNode
// ---------------------------------------------------------------------------
//
// docx 里图片有两种放置方式：
//   <wp:inline>  —— 行内图片，跟随文字流（最常见）
//   <wp:anchor>  —— 浮动图片，带绕排，复杂得多（W1.4+ 再做精细排版）
// 当前对两种都按"行内图片"处理，浮动定位先简化为 inline，至少能把图显出来。
//
// 关键路径：
//   <w:drawing>
//     <wp:inline 或 wp:anchor>
//       <wp:extent cx="..." cy="..."/>          ← 尺寸（EMU）
//       <wp:docPr descr="..."/>                  ← alt
//       <a:graphic>/<a:graphicData>/<pic:pic>
//         <pic:blipFill>/<a:blip r:embed="rIdN"/> ← 关系 ID
//
// EMU（English Metric Unit）：914400 EMU/inch，12700 EMU/pt。

const EMU_PER_PT = 12700;

async function parseDrawing(drawingEl: Element, ctx: ParseCtx): Promise<ImageNode | null> {
  // wp:inline 或 wp:anchor，取第一个出现的容器
  const container =
    firstByLocalName(drawingEl, "inline") ?? firstByLocalName(drawingEl, "anchor");
  if (!container) return null;

  // 尺寸
  let widthPt: number | undefined;
  let heightPt: number | undefined;
  const extent = firstByLocalName(container, "extent");
  if (extent) {
    const cx = parseInt(extent.getAttribute("cx") || "", 10);
    const cy = parseInt(extent.getAttribute("cy") || "", 10);
    if (Number.isFinite(cx) && cx > 0) widthPt = cx / EMU_PER_PT;
    if (Number.isFinite(cy) && cy > 0) heightPt = cy / EMU_PER_PT;
  }

  // alt：优先 wp:docPr@descr，其次 wp:docPr@title
  let alt: string | undefined;
  const docPr = firstByLocalName(container, "docPr");
  if (docPr) {
    alt =
      docPr.getAttribute("descr") ||
      docPr.getAttribute("title") ||
      undefined;
  }

  // 找 <a:blip r:embed="..."> —— 跨 DrawingML 命名空间，按 localName 深搜
  const blip = deepFirstByLocalName(container, "blip");
  if (!blip) return null;
  // r:embed 嵌入；r:link 是外链（暂不支持，没办法本地加载）
  const rEmbed =
    blip.getAttribute("r:embed") ||
    blip.getAttribute("embed") ||
    blip.getAttributeNS(
      "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "embed",
    );
  if (!rEmbed) return null;

  // 关系表反查 → 实际 part 路径（target 是相对 word/ 的，如 "media/image1.png"）
  const rel = ctx.rels.get(rEmbed);
  if (!rel || rel.external) return null;
  const partPath = resolveRelTarget("word/document.xml", rel.target);

  // 缓存命中？同一图片在文档里多处引用时不重复创建 blob URL
  let src = ctx.imageCache.get(partPath);
  if (!src) {
    const bytes = await ctx.pkg.getBinary(partPath);
    if (!bytes) return null;
    const mime = guessImageMime(partPath);
    // 复制到独立 ArrayBuffer 喂 Blob——直接传 Uint8Array 在严格 TS lib 下
    // 会因为 SharedArrayBuffer 联合类型而报错；slice 后类型就一定是 ArrayBuffer。
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const blob = new Blob([buf], { type: mime });
    src = URL.createObjectURL(blob);
    ctx.imageCache.set(partPath, src);
    ctx.blobUrls.push(src);
  }

  return { type: "image", src, widthPt, heightPt, alt };
}

/**
 * 关系表里的 target 是相对路径（如 "media/image1.png"），需要相对于 source part 解析。
 * source = "word/document.xml" + target = "media/image1.png" → "word/media/image1.png"
 * 不用 URL 解析（OPC 路径不带域名容易出问题），手写一个最小路径合并。
 */
function resolveRelTarget(sourcePart: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  // 取 source 所在目录
  const slash = sourcePart.lastIndexOf("/");
  const dir = slash >= 0 ? sourcePart.slice(0, slash) : "";
  const segs = (dir ? `${dir}/${target}` : target).split("/");
  const out: string[] = [];
  for (const s of segs) {
    if (s === "" || s === ".") continue;
    if (s === "..") out.pop();
    else out.push(s);
  }
  return out.join("/");
}

function guessImageMime(path: string): string {
  const i = path.lastIndexOf(".");
  const ext = i >= 0 ? path.slice(i + 1).toLowerCase() : "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    // emf / wmf 浏览器不支持，给个通用类型让 <img> 自然失败显示 alt
    default: return "application/octet-stream";
  }
}

/** 深度优先按 localName 找第一个匹配元素（跨命名空间）。 */
function deepFirstByLocalName(parent: Element, localName: string): Element | null {
  const stack: Element[] = [parent];
  while (stack.length) {
    const cur = stack.shift()!;
    const list = cur.children;
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (el.localName === localName) return el;
      stack.push(el);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DOM helpers —— 跨命名空间按 localName 匹配（OOXML 各工具 ns 风格不一）
// ---------------------------------------------------------------------------

function firstByLocalName(parent: Element, localName: string): Element | null {
  for (const child of childElements(parent)) {
    if (child.localName === localName) return child;
  }
  return null;
}

function childElements(parent: Element): Element[] {
  const out: Element[] = [];
  const list = parent.children;
  for (let i = 0; i < list.length; i++) out.push(list[i]);
  return out;
}
