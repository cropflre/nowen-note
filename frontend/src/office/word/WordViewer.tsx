// office/word/WordViewer.tsx —— DocxIR → React 视图（W1.5 实验室版）
//
// 设计说明：
//   - 纯展示组件，不改变 IR、不挂任何全局事件
//   - 字号、字体、颜色、加粗/斜体/下划线 直接走 inline style
//     —— 之所以不用 className，是因为 IR 字段都是 docx 原始值（pt、hex），
//        塞 inline style 是最直接的映射；将来要换主题再抽 CSS 变量
//   - 页面尺寸按 IR.section.pageSize（pt）转 px（96 DPI ≈ 1 pt × 1.333）
//   - run.text 里的 \n / \t 是解析器约定的 break/tab —— 用 white-space: pre-wrap
//     让浏览器原生处理，不必拆 span
//
// 已知问题（W1 长尾，留待后续 polish 阶段处理）：
//   [BUG-W1-INDENT] 部分 docx（尤其代码块/YAML 等等宽字体段落）层级缩进丢失。
//     - 解析器对 <w:ind> / <w:tab> / <w:t>(连续空格) 都已正确处理
//     - 渲染器也设了 white-space: pre-wrap + paddingLeft(indent)
//     - 主链路 OK，剩下 10% 的丢缩进案例大概率来自：
//         a) numPr 关联到 numbering.xml 的复杂列表层级解算不准
//         b) 段落样式继承链（pStyle → styles.xml）未完全展开
//         c) Word 内部"伪代码块"用了 framePr/特殊样式
//     - 触发条件较窄，不阻塞 W1 验收；进入 W1.6+ 时统一用真实 docx 样本调优

import React from "react";
import type {
  DocxIR,
  ParagraphNode,
  RunNode,
  RunProps,
  Section,
  InlineNode,
  ImageNode,
  HyperlinkNode,
  BlockNode,
  TableNode,
  CellNode,
} from "../ir/document";

interface Props {
  ir: DocxIR;
  /** 缩放比例，默认 1。实验室里给个滑块用。 */
  zoom?: number;
}

const PT_TO_PX = 96 / 72; // 1pt = 1/72 inch，96 DPI

export default function WordViewer({ ir, zoom = 1 }: Props) {
  return (
    <div
      className="word-viewer"
      style={{
        // 视口背景，模拟 Word 的灰色编辑区
        background: "#e7e7ea",
        padding: "16px",
        // 关键：父级是 flex item，必须用 absolute / 100% 撑满，
        // 否则内部用 minHeight 会把父级顶大，反而触发不了滚动。
        position: "absolute",
        inset: 0,
        overflow: "auto",
      }}
    >
      {ir.sections.map((sec, i) => (
        <SectionView key={i} section={sec} zoom={zoom} />
      ))}
    </div>
  );
}

function SectionView({ section, zoom }: { section: Section; zoom: number }) {
  const w = (section.pageSize?.w ?? 595) * PT_TO_PX * zoom;
  const h = (section.pageSize?.h ?? 842) * PT_TO_PX * zoom;
  const m = section.margins ?? { top: 72, right: 72, bottom: 72, left: 72 };

  return (
    <div
      style={{
        width: w,
        minHeight: h,
        margin: "0 auto 16px",
        background: "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08)",
        paddingTop: m.top * PT_TO_PX * zoom,
        paddingRight: m.right * PT_TO_PX * zoom,
        paddingBottom: m.bottom * PT_TO_PX * zoom,
        paddingLeft: m.left * PT_TO_PX * zoom,
        // 默认中文宋体 + 英文 Times，贴近 Word 默认外观
        fontFamily: '"Times New Roman", "SimSun", serif',
        fontSize: 12 * PT_TO_PX * zoom, // 默认小四（12pt）
        color: "#000",
        lineHeight: 1.5,
        boxSizing: "border-box",
      }}
    >
      {section.headerText && (
        <div
          style={{
            marginBottom: 12 * zoom,
            paddingBottom: 6 * zoom,
            borderBottom: "1px solid #e5e7eb",
            textAlign: "center",
            fontSize: 9 * PT_TO_PX * zoom,
            color: "#6b7280",
          }}
        >
          {section.headerText}
        </div>
      )}
      {section.body.map((block, i) => (
        <BlockView key={i} block={block} zoom={zoom} />
      ))}
      {section.footerText && (
        <div
          style={{
            marginTop: 18 * zoom,
            paddingTop: 6 * zoom,
            borderTop: "1px solid #e5e7eb",
            textAlign: "center",
            fontSize: 9 * PT_TO_PX * zoom,
            color: "#6b7280",
          }}
        >
          {section.footerText}
        </div>
      )}
    </div>
  );
}

/** 块级分流：分页符 → 分隔线，表格 → TableView，段落 → ParagraphView。 */
function BlockView({ block, zoom }: { block: BlockNode; zoom: number }) {
  if (block.type === "pageBreak") {
    return (
      <div
        role="separator"
        aria-label="分页符"
        style={{
          margin: `${16 * zoom}px 0`,
          borderTop: "1px dashed #9ca3af",
          textAlign: "center",
          fontSize: 10 * zoom,
          color: "#6b7280",
          paddingTop: 4 * zoom,
        }}
      >
        分页符
      </div>
    );
  }
  if (block.type === "table") {
    return <TableView table={block} zoom={zoom} />;
  }
  return <ParagraphView para={block} zoom={zoom} />;
}

/**
 * 表格渲染。
 *
 * 关键决策：
 *   - 用原生 <table> + border-collapse: collapse —— Word 默认的表格视觉就是合并边框
 *   - colWidths 通过 <colgroup>/<col> 设宽，让浏览器自然分配；缺失则不设，自动等分
 *   - 单元格边框只有"指定的那一边"画线，未指定的边走 inherit/无 —— 这样跟 Word 的
 *     "只画了顶边和底边"那种半开放表格能对得上
 *   - 默认给表格一个轻微的最外边框（1px solid #ccc），避免完全无 border 设置时
 *     表格肉眼看起来散架
 */
function TableView({ table, zoom }: { table: TableNode; zoom: number }) {
  return (
    <table
      style={{
        borderCollapse: "collapse",
        marginTop: 6,
        marginBottom: 10,
        // tableLayout: fixed 让 colWidths 真生效；缺 colWidths 时用 auto 让内容自适应
        tableLayout: table.colWidths ? "fixed" : "auto",
        // 不强制 width:100%，避免无 colWidths 时被无限拉宽
        // 但 fixed 模式下必须给宽度，否则 col 宽度无效 —— 用列宽之和
        width: table.colWidths
          ? table.colWidths.reduce((a, b) => a + b, 0) * PT_TO_PX * zoom
          : undefined,
      }}
    >
      {table.colWidths && (
        <colgroup>
          {table.colWidths.map((w, i) => (
            <col key={i} style={{ width: w * PT_TO_PX * zoom }} />
          ))}
        </colgroup>
      )}
      <tbody>
        {table.rows.map((row, i) => (
          <tr key={i}>
            {row.cells.map((cell, j) => (
              <CellView key={j} cell={cell} zoom={zoom} />
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CellView({ cell, zoom }: { cell: CellNode; zoom: number }) {
  const b = cell.borders;
  // 给一个最低限度的兜底边框：四边都没指定时也画 1px #ccc（避免完全没线）
  const hasAny = b && (b.top || b.right || b.bottom || b.left);
  const fallback = "1px solid #ccc";
  const border = (color?: string) =>
    color ? `1px solid #${color}` : hasAny ? "none" : fallback;

  const style: React.CSSProperties = {
    borderTop: border(b?.top),
    borderRight: border(b?.right),
    borderBottom: border(b?.bottom),
    borderLeft: border(b?.left),
    padding: `${4 * zoom}px ${8 * zoom}px`,
    verticalAlign: "top",
    background: cell.shading ? `#${cell.shading}` : undefined,
    // 单元格默认行距比段落紧一点（Word 行为）
    lineHeight: 1.4,
  };

  return (
    <td
      colSpan={cell.gridSpan > 1 ? cell.gridSpan : undefined}
      rowSpan={cell.rowSpan > 1 ? cell.rowSpan : undefined}
      style={style}
    >
      {cell.body.length === 0 ? (
        <span>&#8203;</span>
      ) : (
        cell.body.map((p, i) => <ParagraphView key={i} para={p} zoom={zoom} />)
      )}
    </td>
  );
}

function ParagraphView({ para, zoom }: { para: ParagraphNode; zoom: number }) {
  const align = para.alignment ?? "left";
  const heading = para.headingLevel;
  const baseFontSize = heading
    ? HEADING_SIZE_PT[heading] * PT_TO_PX * zoom
    : undefined;
  const baseFontWeight = heading ? 700 : undefined;

  // 段落底纹：识别为代码块/高亮块。
  // 连续多个有底纹的段落可能是一个"代码块"——
  // 但现在不做合并，逐段起底色已经能达到"看起来是代码块"的效果。
  const shading = para.shading;
  const isCodeLike = !!shading;

  // 缩进与间距
  // OOXML 的 firstLine 与 hanging 互斥：hanging 用负的 textIndent + 同等 paddingLeft 模拟悬挂
  const ind = para.indent;
  const sp = para.spacing;
  const list = para.list;

  const indentStyle: React.CSSProperties = {};
  if (ind) {
    // 基础左缩进：left 直接转 px；如果是 hanging，需要把 hanging 加进 paddingLeft
    // 因为悬挂效果 = paddingLeft(left + hanging) + textIndent(-hanging)
    const leftPt = (ind.left ?? 0) + (ind.hanging ?? 0);
    if (leftPt) indentStyle.paddingLeft = leftPt * PT_TO_PX * zoom;
    if (ind.right) indentStyle.paddingRight = ind.right * PT_TO_PX * zoom;
    if (ind.hanging) {
      indentStyle.textIndent = -ind.hanging * PT_TO_PX * zoom;
    } else if (ind.firstLine) {
      indentStyle.textIndent = ind.firstLine * PT_TO_PX * zoom;
    }
  } else if (list) {
    // 段落自身没显式 indent，但是列表项 —— 用 numbering.xml 给 ilvl 算的标准缩进
    // OOXML 默认 ilvl=0 left=440twip(22pt) hanging=440twip。
    // 这里粗略按 ilvl 缩进 22pt/级，悬挂 22pt，足以让 marker 跟正文对齐。
    const baseIndent = (list.ilvl + 1) * 22; // pt
    const hangingPt = 22;
    indentStyle.paddingLeft = baseIndent * PT_TO_PX * zoom;
    indentStyle.textIndent = -hangingPt * PT_TO_PX * zoom;
  }

  // 行距：auto 是倍数，exact/atLeast 是 pt 值
  // 段落直接给的 spacing 优先于默认 1.5
  let lineHeight: React.CSSProperties["lineHeight"] | undefined;
  if (sp?.line) {
    if (sp.lineRule === "exact" || sp.lineRule === "atLeast") {
      lineHeight = `${sp.line * PT_TO_PX * zoom}px`;
    } else {
      lineHeight = sp.line; // 倍数无单位
    }
  }

  // 段前段后：spacing 显式给值就用，否则保留原默认（标题段落给点喘息）
  const marginTop =
    sp?.before !== undefined
      ? sp.before * PT_TO_PX * zoom
      : heading
        ? "0.83em"
        : 0;
  const marginBottom =
    sp?.after !== undefined
      ? sp.after * PT_TO_PX * zoom
      : "0.5em";

  return (
    <p
      style={{
        marginTop,
        marginBottom,
        marginLeft: 0,
        marginRight: 0,
        textAlign: align,
        whiteSpace: "pre-wrap",
        fontSize: baseFontSize,
        fontWeight: baseFontWeight,
        lineHeight,
        ...indentStyle,
        ...(shading
          ? {
              background: `#${shading}`,
              padding: "6px 10px",
              borderRadius: 4,
              fontFamily: isCodeLike
                ? '"Consolas", "Courier New", "SimSun", monospace'
                : undefined,
            }
          : null),
      }}
    >
      {para.runs.length === 0 ? (
        // 空段落保留一行高度，否则会塌成 0
        <span>&#8203;</span>
      ) : (
        <>
          {list && (
            // marker 用 inline-block + 固定宽度 22pt，刚好等于 paragraph 的悬挂量；
            // 这样多位数（"10."）超出宽度时也只是把后续文字推开一点，不会换行错位。
            // user-select:none 避免复制粘贴时把"1."拷出去（贴近 Word 行为）。
            <span
              style={{
                display: "inline-block",
                minWidth: 22 * PT_TO_PX * zoom,
                marginRight: 4,
                userSelect: "none",
              }}
              aria-hidden="true"
            >
              {list.marker}
            </span>
          )}
          {para.runs.map((node, i) => (
            <InlineView
              key={i}
              node={node}
              paraDefault={para.defaultRun}
              zoom={zoom}
            />
          ))}
        </>
      )}
    </p>
  );
}

/** 内联节点分流：text run → RunView，image → ImageView，hyperlink → HyperlinkView。 */
function InlineView({
  node,
  paraDefault,
  zoom,
}: {
  node: InlineNode;
  paraDefault?: RunProps;
  zoom: number;
}) {
  if (node.type === "image") {
    return <ImageView img={node} zoom={zoom} />;
  }
  if (node.type === "hyperlink") {
    return <HyperlinkView link={node} paraDefault={paraDefault} zoom={zoom} />;
  }
  return <RunView run={node} paraDefault={paraDefault} zoom={zoom} />;
}

function HyperlinkView({
  link,
  paraDefault,
  zoom,
}: {
  link: HyperlinkNode;
  paraDefault?: RunProps;
  zoom: number;
}) {
  // 没有任何 run 显式 color / underline 时，给默认蓝 + 下划线（贴近 Word/浏览器约定）
  const anyHasColor = link.runs.some((r) => r.props?.color && r.props.color !== "auto");
  const anyHasUnderline = link.runs.some((r) => r.props?.underline);

  // 文档内锚点（# 开头）：当前没实现书签定位，禁用跳转避免页面整体跳到顶部
  // 空 href（解析失败回退）：同样禁用
  const isAnchor = link.href.startsWith("#");
  const disabled = !link.href || isAnchor;

  const aStyle: React.CSSProperties = {
    color: anyHasColor ? undefined : "#0563c1", // Word 默认超链接色
    textDecoration: anyHasUnderline ? undefined : "underline",
    cursor: disabled ? "default" : "pointer",
  };

  const children = link.runs.map((run, i) => (
    <RunView key={i} run={run} paraDefault={paraDefault} zoom={zoom} />
  ));

  if (disabled) {
    // 用 span 而非 <a href="">，避免无效跳转和 a11y 噪声
    return <span style={aStyle}>{children}</span>;
  }
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      style={aStyle}
    >
      {children}
    </a>
  );
}

function ImageView({ img, zoom }: { img: ImageNode; zoom: number }) {
  // OOXML 给的是 pt，实际像素 = pt × 96/72 × zoom。
  // 没拿到尺寸的图（少见）让浏览器按原始大小渲染。
  const w = img.widthPt ? img.widthPt * PT_TO_PX * zoom : undefined;
  const h = img.heightPt ? img.heightPt * PT_TO_PX * zoom : undefined;
  return (
    <img
      src={img.src}
      alt={img.alt ?? ""}
      style={{
        width: w,
        height: h,
        // inline 图片在文字流里默认 baseline 对齐，会把行高顶得很高。
        // 多数 docx 里"图片+下一行文字"实际看起来是块状，verticalAlign:bottom 视觉更稳。
        verticalAlign: "bottom",
        maxWidth: "100%",
      }}
      loading="lazy"
      draggable={false}
    />
  );
}

function RunView({
  run,
  paraDefault,
  zoom,
}: {
  run: RunNode;
  paraDefault?: RunProps;
  zoom: number;
}) {
  // run 自身属性优先，回退到段落 defaultRun
  const p: RunProps = { ...(paraDefault ?? {}), ...(run.props ?? {}) };

  const style: React.CSSProperties = {};
  if (p.bold) style.fontWeight = 700;
  if (p.italic) style.fontStyle = "italic";

  // underline / strike 用 textDecoration 合并
  const deco: string[] = [];
  if (p.underline) deco.push("underline");
  if (p.strike) deco.push("line-through");
  if (deco.length) style.textDecoration = deco.join(" ");

  if (p.fontSize) style.fontSize = p.fontSize * PT_TO_PX * zoom;
  if (p.fontFamily) style.fontFamily = `"${p.fontFamily}", inherit`;
  if (p.color && p.color !== "auto") style.color = `#${p.color}`;
  if (p.highlight) style.background = HIGHLIGHT_COLORS[p.highlight] ?? p.highlight;

  return <span style={style}>{run.text}</span>;
}

// ---------------------------------------------------------------------------
// 标题字号映射 —— 跟 Word 默认主题贴近
// ---------------------------------------------------------------------------

const HEADING_SIZE_PT: Record<number, number> = {
  1: 22,
  2: 18,
  3: 16,
  4: 14,
  5: 12,
  6: 11,
};

// OOXML w:highlight 的 17 个具名色
const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  blue: "#0000ff",
  red: "#ff0000",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  darkGray: "#808080",
  lightGray: "#c0c0c0",
  black: "#000000",
  white: "#ffffff",
  none: "transparent",
};
