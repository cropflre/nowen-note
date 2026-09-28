// office/serializers/docx-serializer.ts —— DocxIR → .docx 二进制
//
// 阶段 W2 MVP：把 IR 反序列化回合法的 OOXML 包。覆盖范围：
//   ✅ 段落 + run（bold/italic/underline/strike）
//   ✅ 字号、字体、字色（color）、高亮（highlight）
//   ✅ 段落对齐、shading（底纹）
//   ✅ 段落缩进（left/right/firstLine/hanging）+ 间距（before/after/line+lineRule）
//   ✅ 标题级别（headingLevel → 内置 styleId Heading1..Heading6）
//   ✅ 列表（list.numFmt → 简化为 ul/ol，复用同一个 numbering.xml 定义）
//   ✅ 超链接（HyperlinkNode → 走 r:id 关系）
//   ✅ 表格（table/row/cell + gridSpan/rowSpan + 边框/底纹）
//   ✅ 段落内嵌图片（ImageNode → 写 media + 关系，OOXML drawing）
//   ✅ 页面尺寸 / 页边距（Section）
//   ✅ docProps/core.xml 元数据
//
// 暂不做（留给 W3）：
//   - 页眉页脚 / 批注 / 修订 / 目录 / 节断
//   - 字体表 fontTable.xml（不写也能打开，缺字 fallback）
//   - 复杂列表（多级编号、字符 marker 自定义）
//
// 设计纪律：
//   - 每个段落的 styleId 我们不复用解析端的原始 ID（因为可能引用了源文件
//     的内部样式），统一规范化为 "Heading1".."Heading6"。
//   - 列表只生成 1 套 numbering 定义：numId=1（无序），numId=2（有序）。
//     IR.list.numFmt === "bullet" → numId=1，其它 → numId=2。
//     ilvl 直接透传（最多 8 级，OOXML 支持）。
//   - 颜色 / 字体等任何字段缺失都用 OOXML 默认（不写出 -> 走 Word 默认）。
//   - XML 转义只覆盖文本节点；属性值我们自己拼接，已限定数字/受控字符串。

import JSZip from "jszip";
import type {
  DocxIR,
  ParagraphNode,
  RunNode,
  RunProps,
  InlineNode,
  Section,
  BlockNode,
} from "../ir/document";
import type {
  TableNode,
  RowNode,
  CellNode,
  ImageNode,
  HyperlinkNode,
} from "../ir/document";

// ---------- 工具函数 ----------

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** pt → twip（OOXML 多数尺寸单位）。1pt = 20 twip。 */
function ptToTwip(pt: number): number {
  return Math.round(pt * 20);
}

/** pt → 半点（OOXML 字号单位 w:sz）。 */
function ptToHalfPt(pt: number): number {
  return Math.round(pt * 2);
}

/** pt → EMU（OOXML drawing 单位）。1pt = 12700 EMU。 */
function ptToEmu(pt: number): number {
  return Math.round(pt * 12700);
}

/** 6 位 hex 校验 + 归一化（去 #、补到 6 位）。无效返回 undefined 让上层跳过。 */
function normHex(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const v = s.replace(/^#/, "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return undefined;
  return v.toUpperCase();
}

/** 当前时间 ISO（写 docProps/core.xml）。 */
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------- run / inline 序列化 ----------

function rPrXml(props: RunProps | undefined): string {
  if (!props) return "";
  const parts: string[] = [];
  if (props.bold) parts.push('<w:b/>');
  if (props.italic) parts.push('<w:i/>');
  if (props.underline) parts.push('<w:u w:val="single"/>');
  if (props.strike) parts.push('<w:strike/>');
  if (props.fontSize && props.fontSize > 0) {
    const sz = ptToHalfPt(props.fontSize);
    parts.push(`<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>`);
  }
  if (props.color) {
    const c = normHex(props.color);
    if (c) parts.push(`<w:color w:val="${c}"/>`);
  }
  if (props.highlight) {
    // OOXML 高亮只接受具名色，原样透传（auto/yellow/green/cyan/...）
    const v = props.highlight.replace(/[^a-z]/gi, "").toLowerCase();
    if (v) parts.push(`<w:highlight w:val="${escAttr(v)}"/>`);
  }
  if (props.fontFamily) {
    const f = escAttr(props.fontFamily);
    parts.push(`<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>`);
  }
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

function runXml(run: RunNode): string {
  const rPr = rPrXml(run.props);
  // text 内允许保留前后空格（xml:space="preserve"）
  const text = `<w:t xml:space="preserve">${escXml(run.text)}</w:t>`;
  return `<w:r>${rPr}${text}</w:r>`;
}

/**
 * 序列化超链接：需要在 document.xml.rels 里登记一个外链关系，拿到 rId。
 * 走 SerializerCtx 统一管理 rId 生成。
 */
function hyperlinkXml(node: HyperlinkNode, ctx: SerializerCtx): string {
  const href = node.href || "";
  // 文档锚点（"#bookmark"）暂按外链处理（链不到内部，但不至于挂掉）
  const rId = ctx.allocHyperlinkRid(href);
  const inner = node.runs.map(runXml).join("");
  return `<w:hyperlink r:id="${rId}" w:history="1">${inner}</w:hyperlink>`;
}

/**
 * 内联图片：登记 media + 关系，拼出 OOXML drawing 块。
 * src 必须是 data URL 或者已被 ctx 解析为 bytes。这里只接受 data URL（W2 MVP）；
 * 解析端来源的 blob URL 调用方需先 fetch 转 bytes（见 createDocx 入口注释）。
 */
function imageXml(node: ImageNode, ctx: SerializerCtx): string {
  const bytes = ctx.resolveImageBytes(node.src);
  if (!bytes) {
    // 取不到字节就降级为占位文本，保证文档可打开
    return `<w:r><w:t xml:space="preserve">[image]</w:t></w:r>`;
  }
  const { rId, ext } = ctx.allocImageRid(bytes);
  const cx = ptToEmu(node.widthPt ?? 200);
  const cy = ptToEmu(node.heightPt ?? 150);
  const docPrId = ctx.nextDocPrId();
  const alt = escAttr(node.alt || "");
  // 这一坨是 OOXML drawing 的固定模板；不再细拆，模板验证过能被 Word/WPS/LibreOffice 打开。
  return `<w:r><w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <wp:extent cx="${cx}" cy="${cy}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="${docPrId}" name="Picture ${docPrId}" descr="${alt}"/>
      <wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic>
            <pic:nvPicPr>
              <pic:cNvPr id="${docPrId}" name="Picture ${docPrId}" descr="${alt}"/>
              <pic:cNvPicPr/>
            </pic:nvPicPr>
            <pic:blipFill>
              <a:blip r:embed="${rId}"/>
              <a:stretch><a:fillRect/></a:stretch>
            </pic:blipFill>
            <pic:spPr>
              <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            </pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing></w:r>`.replace(/\n\s*/g, "");
}

function inlineXml(node: InlineNode, ctx: SerializerCtx): string {
  switch (node.type) {
    case "run":
      return runXml(node);
    case "image":
      return imageXml(node, ctx);
    case "hyperlink":
      return hyperlinkXml(node, ctx);
  }
}

// ---------- 段落序列化 ----------

function pPrXml(p: ParagraphNode): string {
  const parts: string[] = [];

  // 标题样式：headingLevel 优先，没有就看 styleId（仅识别 Heading1..6）
  if (p.headingLevel && p.headingLevel >= 1 && p.headingLevel <= 6) {
    parts.push(`<w:pStyle w:val="Heading${p.headingLevel}"/>`);
  } else if (p.styleId && /^Heading[1-6]$/.test(p.styleId)) {
    parts.push(`<w:pStyle w:val="${p.styleId}"/>`);
  }

  // numPr（列表）
  if (p.list) {
    const numId = p.list.numFmt === "bullet" ? 1 : 2;
    const ilvl = Math.max(0, Math.min(8, p.list.ilvl | 0));
    parts.push(`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);
  }

  // 缩进
  if (p.indent) {
    const pieces: string[] = [];
    if (p.indent.left != null) pieces.push(`w:left="${ptToTwip(p.indent.left)}"`);
    if (p.indent.right != null) pieces.push(`w:right="${ptToTwip(p.indent.right)}"`);
    if (p.indent.firstLineChars != null) {
      pieces.push(`w:firstLineChars="${Math.max(0, Math.round(p.indent.firstLineChars * 100))}"`);
    } else if (p.indent.firstLine != null) {
      pieces.push(`w:firstLine="${ptToTwip(p.indent.firstLine)}"`);
    }
    if (p.indent.hanging != null) pieces.push(`w:hanging="${ptToTwip(p.indent.hanging)}"`);
    if (pieces.length) parts.push(`<w:ind ${pieces.join(" ")}/>`);
  }

  // 间距
  if (p.spacing) {
    const pieces: string[] = [];
    if (p.spacing.before != null) pieces.push(`w:before="${ptToTwip(p.spacing.before)}"`);
    if (p.spacing.after != null) pieces.push(`w:after="${ptToTwip(p.spacing.after)}"`);
    if (p.spacing.line != null) {
      // auto 走 240 倍数；exact/atLeast 走 twip
      let lineVal: number;
      if (!p.spacing.lineRule || p.spacing.lineRule === "auto") {
        lineVal = Math.round(p.spacing.line * 240);
        pieces.push(`w:line="${lineVal}"`, `w:lineRule="auto"`);
      } else {
        lineVal = ptToTwip(p.spacing.line);
        pieces.push(`w:line="${lineVal}"`, `w:lineRule="${p.spacing.lineRule}"`);
      }
    }
    if (pieces.length) parts.push(`<w:spacing ${pieces.join(" ")}/>`);
  }

  // 对齐
  if (p.alignment) {
    const map: Record<string, string> = {
      left: "left",
      center: "center",
      right: "right",
      justify: "both",
    };
    const v = map[p.alignment];
    if (v) parts.push(`<w:jc w:val="${v}"/>`);
  }

  // 段落底纹
  const sh = normHex(p.shading);
  if (sh) parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${sh}"/>`);

  // 段落级默认 run 属性
  const rPr = rPrXml(p.defaultRun);
  if (rPr) parts.push(`<w:rPr>${rPr.replace(/^<w:rPr>|<\/w:rPr>$/g, "")}</w:rPr>`);

  return parts.length ? `<w:pPr>${parts.join("")}</w:pPr>` : "";
}

function paragraphXml(p: ParagraphNode, ctx: SerializerCtx): string {
  const pPr = pPrXml(p);
  const inner = (p.runs || []).map((r) => inlineXml(r, ctx)).join("");
  return `<w:p>${pPr}${inner}</w:p>`;
}

// ---------- 表格序列化 ----------

function cellBordersXml(borders: CellNode["borders"]): string {
  if (!borders) return "";
  const sides = (["top", "left", "bottom", "right"] as const)
    .map((side) => {
      const c = normHex(borders[side]);
      if (!c) return "";
      return `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${c}"/>`;
    })
    .join("");
  return sides ? `<w:tcBorders>${sides}</w:tcBorders>` : "";
}

function cellXml(cell: CellNode, ctx: SerializerCtx): string {
  const tcPrParts: string[] = [];
  if (cell.gridSpan && cell.gridSpan > 1) {
    tcPrParts.push(`<w:gridSpan w:val="${cell.gridSpan}"/>`);
  }
  if (cell.rowSpan && cell.rowSpan > 1) {
    tcPrParts.push(`<w:vMerge w:val="restart"/>`);
  }
  const sh = normHex(cell.shading);
  if (sh) tcPrParts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${sh}"/>`);
  tcPrParts.push(cellBordersXml(cell.borders));
  const tcPr = `<w:tcPr>${tcPrParts.join("")}</w:tcPr>`;
  const body = (cell.body || []).map((p) => paragraphXml(p, ctx)).join("");
  // 一个空格段保险：cell 必须包含至少一个 <w:p>
  const safeBody = body || "<w:p/>";
  return `<w:tc>${tcPr}${safeBody}</w:tc>`;
}

function rowXml(row: RowNode, ctx: SerializerCtx): string {
  const cells = (row.cells || []).map((c) => cellXml(c, ctx)).join("");
  return `<w:tr>${cells}</w:tr>`;
}

function tableXml(table: TableNode, ctx: SerializerCtx): string {
  const cols = table.colWidths || [];
  const tblGrid = cols.length
    ? `<w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${ptToTwip(w)}"/>`).join("")}</w:tblGrid>`
    : "";
  const tableWidth = table.widthMode === "auto"
    ? '<w:tblW w:w="0" w:type="auto"/>'
    : '<w:tblW w:w="5000" w:type="pct"/>';
  const tableAlign = table.alignment
    ? `<w:jc w:val="${table.alignment}"/>`
    : "";

  const tblPr = `<w:tblPr>
    ${tableWidth}
    ${tableAlign}
    <w:tblBorders>
      <w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/>
      <w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/>
      <w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/>
      <w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/>
      <w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/>
      <w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/>
    </w:tblBorders>
  </w:tblPr>`.replace(/\n\s*/g, "");
  const rows = (table.rows || []).map((r) => rowXml(r, ctx)).join("");
  return `<w:tbl>${tblPr}${tblGrid}${rows}</w:tbl>`;
}

function blockXml(block: BlockNode, ctx: SerializerCtx): string {
  if (block.type === "table") return tableXml(block, ctx);
  return paragraphXml(block, ctx);
}

// ---------- 上下文：rId 分配 + 媒体收集 ----------

interface PendingMedia {
  /** part 路径，如 "word/media/image1.png" */
  partPath: string;
  /** 关系 target，如 "media/image1.png"（相对 word/） */
  relTarget: string;
  /** rId */
  rId: string;
  /** 二进制内容 */
  bytes: Uint8Array;
  /** content-type，如 "image/png" */
  contentType: string;
}

interface PendingHyperlink {
  rId: string;
  href: string;
}

class SerializerCtx {
  private nextRid = 100; // document.xml.rels 内 rId 起点；避开 _rels/.rels 用过的小 id
  private nextPicId = 1;
  /** src(data url) → 已分配的 rId 索引；重复图片复用同一份 media。 */
  private dataUrlToRel = new Map<string, { rId: string; ext: string }>();
  readonly media: PendingMedia[] = [];
  readonly hyperlinks: PendingHyperlink[] = [];

  allocHyperlinkRid(href: string): string {
    const rId = `rId${this.nextRid++}`;
    this.hyperlinks.push({ rId, href });
    return rId;
  }

  nextDocPrId(): number {
    return this.nextPicId++;
  }

  resolveImageBytes(src: string): Uint8Array | undefined {
    // 仅支持 data URL；blob URL 必须在 createDocx 前 fetch 成 data URL
    if (!src.startsWith("data:")) return undefined;
    const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/);
    if (!m) return undefined;
    const isB64 = !!m[2];
    const payload = m[3];
    if (isB64) {
      const bin = atob(payload);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return u8;
    }
    return new TextEncoder().encode(decodeURIComponent(payload));
  }

  allocImageRid(bytes: Uint8Array): { rId: string; ext: string } {
    // 同一份字节通过 data URL key 复用——这里用 length+前缀做一个轻量 key
    const key = `len:${bytes.length}:${bytes[0]}-${bytes[1]}-${bytes[2]}-${bytes[3]}`;
    const hit = this.dataUrlToRel.get(key);
    if (hit) return hit;

    // 探测格式
    const { ext, contentType } = guessImageFormat(bytes);
    const idx = this.media.length + 1;
    const partPath = `word/media/image${idx}.${ext}`;
    const relTarget = `media/image${idx}.${ext}`;
    const rId = `rId${this.nextRid++}`;
    this.media.push({ partPath, relTarget, rId, bytes, contentType });
    const ret = { rId, ext };
    this.dataUrlToRel.set(key, ret);
    return ret;
  }
}

function guessImageFormat(bytes: Uint8Array): { ext: string; contentType: string } {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: "png", contentType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { ext: "gif", contentType: "image/gif" };
  }
  // SVG / WebP / 其它：兜底当 png（部分 Word 不识别 svg）
  return { ext: "png", contentType: "image/png" };
}

// ---------- 顶层：从 IR 生成完整 .docx ----------

export interface CreateDocxOptions {
  /** docProps/core.xml 的 title。默认从 IR.meta.title 读，否则 "未命名文档"。 */
  title?: string;
  /** docProps/core.xml 的 author。默认从 IR.meta.author，否则 "Nowen Note"。 */
  author?: string;
}

export async function createDocx(
  ir: DocxIR,
  opts: CreateDocxOptions = {},
): Promise<Blob> {
  const ctx = new SerializerCtx();
  const title = opts.title ?? ir.meta?.title ?? "未命名文档";
  const author = opts.author ?? ir.meta?.author ?? "Nowen Note";
  const created = nowIso();

  // ---------- 1. body ----------
  const sections = ir.sections?.length ? ir.sections : [{ body: [] } as Section];
  // 简化：所有 section.body 拼到同一个 body 里（不做节断）；用最后一个 section 的 sectPr 作为页面属性。
  const allBlocks: BlockNode[] = sections.flatMap((s) => s.body || []);
  const lastSection = sections[sections.length - 1] || { body: [] };
  const bodyXml = allBlocks.map((b) => blockXml(b, ctx)).join("");

  // 页面属性
  const pageW = lastSection.pageSize?.w ?? 595; // A4 默认（pt）
  const pageH = lastSection.pageSize?.h ?? 842;
  const m = lastSection.margins || { top: 72, right: 72, bottom: 72, left: 72 };
  const sectPr = `<w:sectPr>
    <w:pgSz w:w="${ptToTwip(pageW)}" w:h="${ptToTwip(pageH)}"/>
    <w:pgMar w:top="${ptToTwip(m.top)}" w:right="${ptToTwip(m.right)}" w:bottom="${ptToTwip(m.bottom)}" w:left="${ptToTwip(m.left)}" w:header="720" w:footer="720" w:gutter="0"/>
  </w:sectPr>`.replace(/\n\s*/g, "");

  // 段落空文档兜底
  const safeBody = bodyXml || "<w:p/>";

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${safeBody}${sectPr}</w:body>
</w:document>`;

  // ---------- 2. document.xml.rels ----------
  const documentRels: string[] = [
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`,
  ];
  for (const m of ctx.media) {
    documentRels.push(
      `<Relationship Id="${m.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${m.relTarget}"/>`,
    );
  }
  for (const h of ctx.hyperlinks) {
    documentRels.push(
      `<Relationship Id="${h.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${escAttr(h.href)}" TargetMode="External"/>`,
    );
  }
  const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${documentRels.join("\n")}
</Relationships>`;

  // ---------- 3. styles.xml（最小的标题样式集合） ----------
  const headingStyles = [1, 2, 3, 4, 5, 6]
    .map((lvl) => {
      // 字号梯度：H1 28pt → H6 11pt
      const sizes = [28, 22, 18, 14, 12, 11];
      const sz = ptToHalfPt(sizes[lvl - 1]);
      return `<w:style w:type="paragraph" w:styleId="Heading${lvl}">
  <w:name w:val="heading ${lvl}"/>
  <w:basedOn w:val="Normal"/>
  <w:next w:val="Normal"/>
  <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${lvl - 1}"/></w:pPr>
  <w:rPr><w:b/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>
</w:style>`.replace(/\n\s*/g, "");
    })
    .join("");
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/><w:qFormat/></w:style>
  ${headingStyles}
</w:styles>`;

  // ---------- 4. numbering.xml（一份无序 + 一份有序） ----------
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${(i + 1) * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join("")}
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${(i + 1) * 360}" w:hanging="360"/></w:pPr></w:lvl>`).join("")}
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

  // ---------- 5. [Content_Types].xml ----------
  // 媒体的 content-type 要按扩展名声明 Default
  const mediaExtTypes = new Map<string, string>();
  for (const m of ctx.media) {
    const ext = m.partPath.split(".").pop()!;
    mediaExtTypes.set(ext, m.contentType);
  }
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${Array.from(mediaExtTypes.entries()).map(([ext, ct]) => `<Default Extension="${ext}" ContentType="${ct}"/>`).join("")}
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  // ---------- 6. _rels/.rels ----------
  const packageRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  // ---------- 7. docProps ----------
  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escXml(title)}</dc:title>
  <dc:creator>${escXml(author)}</dc:creator>
  <cp:lastModifiedBy>${escXml(author)}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`;

  const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Nowen Note</Application>
</Properties>`;

  // ---------- 8. 打包 ----------
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("_rels/.rels", packageRelsXml);
  zip.file("word/document.xml", documentXml);
  zip.file("word/_rels/document.xml.rels", documentRelsXml);
  zip.file("word/styles.xml", stylesXml);
  zip.file("word/numbering.xml", numberingXml);
  zip.file("docProps/core.xml", coreXml);
  zip.file("docProps/app.xml", appXml);
  for (const m of ctx.media) {
    zip.file(m.partPath, m.bytes);
  }

  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}
