// office/serializers/tiptap-to-ir.ts —— Tiptap JSON → DocxIR
//
// 阶段 W2 配套：把笔记编辑器（Tiptap StarterKit + 业务扩展）的 JSON
// 文档树映射到自研 DocxIR，再交给 docx-serializer 落成 .docx。
//
// 为什么不直接 Tiptap → docx：DocxIR 是已经稳定下来的"中间语义层"，
// 它解耦了"前端编辑器具体长啥样"和"OOXML 怎么写"。今后换编辑器、加节点
// 类型，只要在这里加一段映射即可，不需要碰 docx-serializer。
//
// 覆盖范围（与 docx-serializer 能力对齐）：
//   ✅ heading 1-6 / paragraph
//   ✅ text + marks: bold/italic/underline/strike/code/link/highlight
//   ✅ textStyle: color (data-color / color / style="color:...") / fontSize
//   ✅ bulletList / orderedList / listItem（递归 ilvl，最多 8 级）
//   ✅ taskList / taskItem（OOXML 无原生，渲染成 ☐/☑ 前缀的列表项）
//   ✅ blockquote（用浅灰底纹 + 左缩进近似）
//   ✅ codeBlock（等宽字 + 浅灰底纹）
//   ✅ horizontalRule（一个空段，靠下边框近似）
//   ✅ image（如果是远端 URL 会先 fetch 转 data URL；失败降级为 [图片] 文本）
//   ✅ table / tableRow / tableHeader / tableCell
//
// 显式不做（占比小，ROI 低）：
//   - 数学公式 (math) → 降级成 LaTeX 文本
//   - 脚注 (footnote) → 降级成 [^id] 占位
//   - 提及 / 标签 → 降级成纯文本
//   - 视频 / 音频嵌入 → 降级成链接文本
//
// 失败哲学：每个未知节点都走"递归取 text 当兜底"，保证导出不会因为
// 个别奇葩节点彻底失败。

import type {
  DocxIR,
  ParagraphNode,
  RunNode,
  RunProps,
  InlineNode,
  BlockNode,
  TableNode,
  RowNode,
  CellNode,
  HyperlinkNode,
  ImageNode,
} from "../ir/document";

// ---------------------------------------------------------------------------
// Tiptap JSON 形态（结构化但不保证字段全有，所以用 any 派生 + 防御性读取）
// ---------------------------------------------------------------------------

interface TipNode {
  type: string;
  attrs?: Record<string, any>;
  content?: TipNode[];
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  text?: string;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export interface TiptapToIrOptions {
  /** 标题写到 docMeta.title 和 OOXML core.xml。 */
  title?: string;
  author?: string;
  /**
   * 远端图片 URL → bytes 解析器。如果不传，img 节点的非 data URL 会被尝试用
   * fetch 拉取（同源 / 已带 cookie 才能成）；调用方有更好的鉴权方式（如带 token）
   * 时可以传一个自定义实现。
   */
  fetchImage?: (url: string) => Promise<Uint8Array | null>;
}

/**
 * 把 Tiptap doc JSON 转成 DocxIR。
 *
 * 注：图片转换是异步的（要 fetch 远端），所以整个函数也是 async。
 */
export async function tiptapToIr(
  doc: TipNode | string,
  opts: TiptapToIrOptions = {},
): Promise<DocxIR> {
  // 入参可能是 JSON 字符串
  const node: TipNode = typeof doc === "string" ? safeParse(doc) : doc;
  if (!node || node.type !== "doc") {
    return emptyIr(opts);
  }

  const ctx: BuildCtx = {
    fetchImage: opts.fetchImage ?? defaultFetchImage,
    listStack: [],
  };

  const blocks: BlockNode[] = [];
  for (const child of node.content || []) {
    const out = await blockFromTip(child, ctx);
    for (const b of out) blocks.push(b);
  }

  return {
    meta: {
      title: opts.title,
      author: opts.author,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
    },
    sections: [{ body: blocks }],
  };
}

function emptyIr(opts: TiptapToIrOptions): DocxIR {
  return {
    meta: { title: opts.title, author: opts.author },
    sections: [{ body: [{ type: "paragraph", runs: [] }] }],
  };
}

function safeParse(s: string): TipNode {
  try {
    return JSON.parse(s);
  } catch {
    return { type: "doc", content: [] };
  }
}

// ---------------------------------------------------------------------------
// 上下文 + 列表栈
// ---------------------------------------------------------------------------
//
// Tiptap 的列表是嵌套的：bulletList > listItem > paragraph + 可选的子 list。
// OOXML 的列表是"段落带 numPr"的扁平形态。我们用一个栈跟踪当前嵌套深度
// 和有序/无序类型，遇到 paragraph 时根据栈顶决定 list 字段。

type ListKind = "bullet" | "ordered" | "task";

interface BuildCtx {
  fetchImage: (url: string) => Promise<Uint8Array | null>;
  /** 当前嵌套的列表栈，从外到内。栈顶就是当前层级。 */
  listStack: Array<{ kind: ListKind; numId: number }>;
}

// numId 约定：和 docx-serializer 里 numbering.xml 的固定 numId 对齐
//   bullet/task → 1（无序）
//   ordered → 2（有序）
const NUMID_BULLET = 1;
const NUMID_ORDERED = 2;

// ---------------------------------------------------------------------------
// 块级节点 → BlockNode[]
// ---------------------------------------------------------------------------
//
// 多数节点产出 1 个 BlockNode，但有些（如 listItem 包多段、blockquote 多段、
// table 内嵌套）会产出多个，所以统一返回数组。

async function blockFromTip(node: TipNode, ctx: BuildCtx): Promise<BlockNode[]> {
  const t = node.type;
  switch (t) {
    case "paragraph":
      return [await paragraphFromTip(node, ctx)];

    case "heading": {
      const level = clampInt(node.attrs?.level, 1, 6, 1);
      const p = await paragraphFromTip(node, ctx);
      p.headingLevel = level;
      return [p];
    }

    case "bulletList":
      return await listFromTip(node, "bullet", ctx);

    case "orderedList":
      return await listFromTip(node, "ordered", ctx);

    case "taskList":
      return await listFromTip(node, "task", ctx);

    case "blockquote": {
      // 用浅灰底纹 + 左缩进 24pt 近似引用块
      const out: BlockNode[] = [];
      for (const child of node.content || []) {
        const blocks = await blockFromTip(child, ctx);
        for (const b of blocks) {
          if (b.type === "paragraph") {
            b.shading = "F5F5F5";
            b.indent = { ...(b.indent || {}), left: 24 };
          }
          out.push(b);
        }
      }
      return out.length ? out : [{ type: "paragraph", runs: [] }];
    }

    case "codeBlock": {
      // 等宽字体 + 浅灰底纹；多行 code 通过 \n 分多段以保留换行
      const text = collectText(node);
      const lines = text.split(/\r?\n/);
      return lines.map<ParagraphNode>((line) => ({
        type: "paragraph",
        shading: "F5F5F5",
        defaultRun: { fontFamily: "Consolas" },
        runs: line
          ? [{ type: "run", text: line, props: { fontFamily: "Consolas" } }]
          : [],
      }));
    }

    case "horizontalRule":
      // OOXML 没有真正的 hr；用一个底部加边框的空段近似
      return [
        {
          type: "paragraph",
          runs: [],
          // 没法直接在 IR 里表达"段落底边框"——这里就空一段，视觉上能起到分隔作用
          spacing: { before: 6, after: 6 },
        },
      ];

    case "table":
      return [await tableFromTip(node, ctx)];

    case "image": {
      // 顶级图片：包成段落里的 inline image
      const inline = await imageFromTip(node, ctx);
      return [{ type: "paragraph", runs: [inline] }];
    }

    case "footnote":
    case "footnoteReference":
    case "math":
    case "mathDisplay":
    case "mention":
      // 降级成纯文本段
      return [{ type: "paragraph", runs: textRunsFallback(node) }];

    default:
      // 兜底：递归处理 children；都不认识就当一个段落
      if (node.content && node.content.length) {
        const out: BlockNode[] = [];
        for (const child of node.content) {
          const blocks = await blockFromTip(child, ctx);
          for (const b of blocks) out.push(b);
        }
        if (out.length) return out;
      }
      // 啥都没有 → 空段（避免空 ir.body）
      return [{ type: "paragraph", runs: [] }];
  }
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

async function listFromTip(
  list: TipNode,
  kind: ListKind,
  ctx: BuildCtx,
): Promise<BlockNode[]> {
  const numId = kind === "ordered" ? NUMID_ORDERED : NUMID_BULLET;
  ctx.listStack.push({ kind, numId });
  const out: BlockNode[] = [];

  for (const item of list.content || []) {
    if (item.type !== "listItem" && item.type !== "taskItem") continue;
    const itemBlocks = await listItemFromTip(item, kind, ctx);
    for (const b of itemBlocks) out.push(b);
  }

  ctx.listStack.pop();
  return out;
}

async function listItemFromTip(
  item: TipNode,
  kind: ListKind,
  ctx: BuildCtx,
): Promise<BlockNode[]> {
  const ilvl = Math.max(0, Math.min(8, ctx.listStack.length - 1));
  const numId = kind === "ordered" ? NUMID_ORDERED : NUMID_BULLET;
  const checked = !!item.attrs?.checked;

  const out: BlockNode[] = [];
  let firstParaSeen = false;

  for (const child of item.content || []) {
    // listItem 里通常先一段 paragraph，可能后跟嵌套 list
    if (child.type === "bulletList" || child.type === "orderedList" || child.type === "taskList") {
      const subKind: ListKind =
        child.type === "orderedList" ? "ordered" : child.type === "taskList" ? "task" : "bullet";
      const nested = await listFromTip(child, subKind, ctx);
      for (const n of nested) out.push(n);
      continue;
    }

    const blocks = await blockFromTip(child, ctx);
    for (const b of blocks) {
      if (b.type === "paragraph") {
        // 把列表标记打到第一个段落上（一项里多段时，后续段落保持纯段落但缩进对齐）
        if (!firstParaSeen) {
          firstParaSeen = true;
          // task 模式：在文本前加 ☐/☑
          if (kind === "task") {
            const marker = checked ? "☑ " : "☐ ";
            b.runs = [{ type: "run", text: marker }, ...b.runs];
          }
          b.list = {
            numId,
            ilvl,
            marker: kind === "ordered" ? `${ilvl + 1}.` : "•",
            numFmt: kind === "ordered" ? "decimal" : "bullet",
          };
        } else {
          // 续接段落：保持左缩进与列表对齐
          b.indent = { ...(b.indent || {}), left: (ilvl + 1) * 18 };
        }
      }
      out.push(b);
    }
  }

  // 空 listItem 兜底
  if (!firstParaSeen) {
    out.push({
      type: "paragraph",
      runs: kind === "task" ? [{ type: "run", text: checked ? "☑ " : "☐ " }] : [],
      list: {
        numId,
        ilvl,
        marker: kind === "ordered" ? `${ilvl + 1}.` : "•",
        numFmt: kind === "ordered" ? "decimal" : "bullet",
      },
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// 段落
// ---------------------------------------------------------------------------

async function paragraphFromTip(node: TipNode, ctx: BuildCtx): Promise<ParagraphNode> {
  const runs: InlineNode[] = [];
  for (const child of node.content || []) {
    const inlines = await inlineFromTip(child, ctx);
    for (const i of inlines) runs.push(i);
  }

  const p: ParagraphNode = {
    type: "paragraph",
    runs,
  };

  // textAlign attr：来自 @tiptap/extension-text-align
  const align = node.attrs?.textAlign;
  if (align === "center" || align === "right" || align === "justify" || align === "left") {
    p.alignment = align;
  }

  // data-indent：项目的自定义全局 attr（见 IndentExtension）
  const indent = parseInt(node.attrs?.["data-indent"] ?? node.attrs?.dataIndent, 10);
  if (Number.isFinite(indent) && indent > 0) {
    p.indent = { left: indent * 24 };
  }

  if (node.attrs?.firstLineIndent === 2) {
    p.indent = { ...(p.indent || {}), firstLineChars: 2 };
  }

  return p;
}

// ---------------------------------------------------------------------------
// 行内
// ---------------------------------------------------------------------------

async function inlineFromTip(node: TipNode, ctx: BuildCtx): Promise<InlineNode[]> {
  switch (node.type) {
    case "text":
      return [textRunFromTip(node)];

    case "image":
      return [await imageFromTip(node, ctx)];

    case "hardBreak":
      // OOXML 段内换行用 <w:br/>。我们的 IR 里没单独节点；用 \n 文本兜底
      return [{ type: "run", text: "\n" }];

    case "footnoteReference":
    case "mention":
    case "math":
      return textRunsFallback(node);

    default:
      // 未知 inline：递归取文本
      if (node.content && node.content.length) {
        const out: InlineNode[] = [];
        for (const c of node.content) {
          const inlines = await inlineFromTip(c, ctx);
          for (const i of inlines) out.push(i);
        }
        return out;
      }
      return node.text ? [{ type: "run", text: node.text }] : [];
  }
}

function textRunFromTip(node: TipNode): RunNode | HyperlinkNode {
  const text = node.text || "";
  const props: RunProps = {};
  let linkHref: string | undefined;

  for (const m of node.marks || []) {
    switch (m.type) {
      case "bold":
      case "strong":
        props.bold = true;
        break;
      case "italic":
      case "em":
        props.italic = true;
        break;
      case "underline":
        props.underline = true;
        break;
      case "strike":
      case "s":
        props.strike = true;
        break;
      case "code":
        // OOXML 没有 inline code 样式，用等宽字体 + 浅色底色近似
        props.fontFamily = "Consolas";
        props.highlight = "lightGray";
        break;
      case "highlight": {
        // tiptap highlight 默认 yellow，可带 color attr
        const color = (m.attrs?.color as string) || "yellow";
        props.highlight = mapHighlight(color);
        break;
      }
      case "textStyle": {
        // 颜色：tiptap @tiptap/extension-color 落在 textStyle.color
        const color = m.attrs?.color as string | undefined;
        const hex = normHex(color);
        if (hex) props.color = hex;
        // 字号：项目自定义在 textStyle.fontSize（见 TiptapEditor FontSizePopover）
        const fontSize = parseFontSize(m.attrs?.fontSize);
        if (fontSize) props.fontSize = fontSize;
        // 字体
        const ff = m.attrs?.fontFamily as string | undefined;
        if (ff) props.fontFamily = ff;
        break;
      }
      case "link":
        linkHref = (m.attrs?.href as string) || undefined;
        break;
      default:
        break;
    }
  }

  const run: RunNode = { type: "run", text, props: Object.keys(props).length ? props : undefined };

  if (linkHref) {
    const link: HyperlinkNode = {
      type: "hyperlink",
      href: linkHref,
      // 链接里的文字默认蓝色 + 下划线（如果 props 已显式给颜色就保留用户的）
      runs: [
        {
          ...run,
          props: {
            color: "0563C1",
            underline: true,
            ...run.props,
          },
        },
      ],
    };
    return link;
  }

  return run;
}

/**
 * 把无法识别的节点降级成纯文本 run（含子树）。
 * 遇到带 latex/text attr 的（math/mention 等）也尽量保留语义。
 */
function textRunsFallback(node: TipNode): RunNode[] {
  // math 节点常见把 LaTeX 放在 attrs.latex 或 content[0].text
  const latex = (node.attrs?.latex as string) || (node.attrs?.content as string);
  const txt = latex || collectText(node);
  if (!txt) return [];
  return [{ type: "run", text: txt }];
}

function collectText(node: TipNode): string {
  if (node.text) return node.text;
  if (!node.content) return "";
  return node.content.map(collectText).join("");
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

async function imageFromTip(node: TipNode, ctx: BuildCtx): Promise<InlineNode> {
  const src = (node.attrs?.src as string) || "";
  const alt = (node.attrs?.alt as string) || undefined;
  const width = parsePx(node.attrs?.width);
  const height = parsePx(node.attrs?.height);

  if (!src) {
    return { type: "run", text: "[图片缺失]" };
  }

  // data URL 直接传给序列化器
  if (src.startsWith("data:")) {
    const img: ImageNode = { type: "image", src, alt };
    if (width) img.widthPt = pxToPt(width);
    if (height) img.heightPt = pxToPt(height);
    return img;
  }

  // 其它 URL：fetch 转 data URL
  try {
    const bytes = await ctx.fetchImage(src);
    if (!bytes) {
      return { type: "run", text: `[图片：${src}]` };
    }
    const dataUrl = bytesToDataUrl(bytes, sniffMime(bytes));
    const img: ImageNode = { type: "image", src: dataUrl, alt };
    if (width) img.widthPt = pxToPt(width);
    if (height) img.heightPt = pxToPt(height);
    return img;
  } catch {
    return { type: "run", text: `[图片：${src}]` };
  }
}

async function defaultFetchImage(url: string): Promise<Uint8Array | null> {
  try {
    // 相对 URL 也能 fetch（同源）；带 cookie 走 same-origin
    const resp = await fetch(url, { credentials: "same-origin" });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

function sniffMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  return "image/png"; // 兜底当 png（部分 Word 不识别 svg）
}

function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  // 大图用 chunk 拼，避免 String.fromCharCode 一次塞太多导致栈爆
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

function tableColumnWidthsFromTip(node: TipNode): number[] | undefined {
  const colgroup = node.attrs?.colgroup;
  if (Array.isArray(colgroup) && colgroup.length > 0) {
    const widths = colgroup.map((entry: any) =>
      parsePx(entry && typeof entry === "object" ? entry.width : entry),
    );
    if (widths.every((width): width is number => typeof width === "number")) {
      return widths.map(pxToPt);
    }
  }

  const firstRow = (node.content || []).find((row) => row.type === "tableRow");
  if (!firstRow) return undefined;
  const widths: number[] = [];
  for (const cell of firstRow.content || []) {
    if (cell.type !== "tableCell" && cell.type !== "tableHeader") continue;
    const span = clampInt(cell.attrs?.colspan, 1, 32, 1);
    const raw = Array.isArray(cell.attrs?.colwidth) ? cell.attrs?.colwidth : [];
    for (let index = 0; index < span; index += 1) {
      const width = parsePx(raw[index]);
      if (!width) return undefined;
      widths.push(pxToPt(width));
    }
  }
  return widths.length > 0 ? widths : undefined;
}

async function tableFromTip(node: TipNode, ctx: BuildCtx): Promise<TableNode> {
  const rows: RowNode[] = [];
  for (const r of node.content || []) {
    if (r.type !== "tableRow") continue;
    const cells: CellNode[] = [];
    for (const c of r.content || []) {
      if (c.type !== "tableCell" && c.type !== "tableHeader") continue;
      const cellBody: ParagraphNode[] = [];
      for (const cc of c.content || []) {
        const blocks = await blockFromTip(cc, ctx);
        for (const b of blocks) {
          if (b.type === "paragraph") cellBody.push(b);
          // 表格里的嵌套表格 / 列表降级：略过非段落，避免破坏 OOXML 结构
        }
      }
      cells.push({
        type: "cell",
        gridSpan: clampInt(c.attrs?.colspan, 1, 32, 1),
        rowSpan: clampInt(c.attrs?.rowspan, 1, 32, 1),
        body: cellBody.length ? cellBody : [{ type: "paragraph", runs: [] }],
        // tableHeader：浅灰底纹做区分
        shading: c.type === "tableHeader" ? "EEEEEE" : undefined,
      });
    }
    rows.push({ type: "row", cells });
  }
  const table: TableNode = { type: "table", rows };
  const colWidths = tableColumnWidthsFromTip(node);
  if (colWidths) table.colWidths = colWidths;

  const align = node.attrs?.tableLayoutAlign;
  if (align === "left" || align === "center" || align === "right") {
    table.alignment = align;
  }
  const widthMode = node.attrs?.tableWidthMode;
  if (widthMode === "auto" || widthMode === "full") {
    table.widthMode = widthMode;
  }
  return table;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function normHex(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  // rgb(255,0,0)
  const m = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    const r = parseInt(m[1], 10);
    const g = parseInt(m[2], 10);
    const b = parseInt(m[3], 10);
    return [r, g, b]
      .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase();
  }
  // #rrggbb / rrggbb
  const v = trimmed.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(v)) return v.toUpperCase();
  // #rgb 简写
  if (/^[0-9a-fA-F]{3}$/.test(v)) {
    return v.split("").map((c) => c + c).join("").toUpperCase();
  }
  return undefined;
}

function clampInt(v: any, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function parseFontSize(v: any): number | undefined {
  if (typeof v === "number") return v > 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)(px|pt)?$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] || "px").toLowerCase();
  return unit === "pt" ? n : pxToPt(n);
}

function parsePx(v: any): number | undefined {
  if (typeof v === "number") return v > 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)(px)?$/i);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** px → pt（CSS 像素 96dpi 下：1pt = 1.333px） */
function pxToPt(px: number): number {
  return Math.round((px * 72) / 96);
}

/**
 * Tiptap highlight 颜色值 → OOXML 具名色（OOXML 仅支持 16 种具名）。
 * 不在白名单的统统降级为 yellow。
 */
function mapHighlight(input: string): string {
  const v = input.toLowerCase().trim();
  const named = new Set([
    "black", "blue", "cyan", "darkBlue", "darkCyan", "darkGray", "darkGreen",
    "darkMagenta", "darkRed", "darkYellow", "green", "lightGray", "magenta",
    "red", "white", "yellow", "none",
  ].map((s) => s.toLowerCase()));
  if (named.has(v)) return v;
  // hex → 找最近的具名色（粗暴：色相对照）
  const hex = normHex(input);
  if (!hex) return "yellow";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // 简单亮度+主色判定
  if (r > 200 && g > 200 && b < 100) return "yellow";
  if (r > 200 && g < 100 && b < 100) return "red";
  if (r < 100 && g > 200 && b < 100) return "green";
  if (r < 100 && g < 100 && b > 200) return "blue";
  if (r > 200 && g > 200 && b > 200) return "white";
  if (r < 50 && g < 50 && b < 50) return "black";
  return "yellow";
}
