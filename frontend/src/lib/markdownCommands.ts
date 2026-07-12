/**
 * markdownCommands —— CodeMirror 6 版 Markdown 编辑原子命令
 * ----------------------------------------------------------------------------
 * 目标：
 *   - 把所有"修改文档内容"的行为集中在这里，方便工具栏、斜杠命令、快捷键共用
 *   - 每个命令都接收 `EditorView`，直接 dispatch 事务，调用方不需要关心选区细节
 *   - 命令风格仿照 CM6 官方 commands：成功返回 `true`，无事发生返回 `false`
 *
 * 本文件不包含 UI，纯编辑逻辑。
 */
import { EditorView } from "@codemirror/view";
import { EditorSelection, Line } from "@codemirror/state";

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function focus(view: EditorView) {
  // 事务 dispatch 之后再 focus，避免命令里 focus 抢焦点导致输入法中断
  queueMicrotask(() => view.focus());
}

/** 把当前选区的起止"行范围"（跨行时从首行起点到末行终点）求出来 */
function lineRangeOfSelection(view: EditorView, range: { from: number; to: number }) {
  const doc = view.state.doc;
  const first = doc.lineAt(range.from);
  const last = doc.lineAt(range.to);
  return { first, last };
}

/** 遍历选区覆盖的每一行（含首尾），收集成数组 */
function linesInRange(view: EditorView, range: { from: number; to: number }): Line[] {
  const { first, last } = lineRangeOfSelection(view, range);
  const doc = view.state.doc;
  const lines: Line[] = [];
  for (let n = first.number; n <= last.number; n++) {
    lines.push(doc.line(n));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 行内包裹（粗体 / 斜体 / 删除线 / 行内代码）
// ---------------------------------------------------------------------------

/**
 * 把选区用成对标记包裹；若选区两端已经被该标记包裹则解除。
 * 空选区时：插入一对标记并把光标放中间。
 *
 * 例：** 加粗 **  → toggleWrap("**")  选区外扩 2 字符检测已有包裹
 */
export function toggleWrap(view: EditorView, marker: string, markerEnd = marker): boolean {
  if (!view.state.selection.ranges.length) return false;
  const doc = view.state.doc;

  const changes: { from: number; to: number; insert: string }[] = [];
  const newSelections = view.state.selection.ranges.map((range) => {
    const { from, to } = range;
    const selectedText = doc.sliceString(from, to);

    // 检测选区外部是否已被包裹（如光标在 **x|** 的 x 上，选区是空但两侧有 **）
    const before = doc.sliceString(Math.max(0, from - marker.length), from);
    const after = doc.sliceString(to, Math.min(doc.length, to + markerEnd.length));

    if (before === marker && after === markerEnd) {
      // 解除包裹：删除前后标记
      changes.push({ from: from - marker.length, to: from, insert: "" });
      changes.push({ from: to, to: to + markerEnd.length, insert: "" });
      return EditorSelection.range(from - marker.length, to - marker.length);
    }

    // 检测选区内部两端是否已是标记（如选区正好是 **x**）
    if (
      selectedText.startsWith(marker) &&
      selectedText.endsWith(markerEnd) &&
      selectedText.length >= marker.length + markerEnd.length
    ) {
      const inner = selectedText.slice(marker.length, selectedText.length - markerEnd.length);
      changes.push({ from, to, insert: inner });
      return EditorSelection.range(from, from + inner.length);
    }

    // 默认：包裹选区
    const wrapped = `${marker}${selectedText}${markerEnd}`;
    changes.push({ from, to, insert: wrapped });
    if (from === to) {
      // 空选区：光标放中间
      const cursor = from + marker.length;
      return EditorSelection.cursor(cursor);
    }
    return EditorSelection.range(from + marker.length, to + marker.length);
  });

  view.dispatch({
    changes,
    selection: EditorSelection.create(newSelections),
  });
  focus(view);
  return true;
}

// ---------------------------------------------------------------------------
// 行首前缀（标题 / 引用 / 列表 / 任务）
// ---------------------------------------------------------------------------

/**
 * 对选区覆盖的每一行切换某个行首前缀。
 *
 * @param matchers 所有可能"已存在前缀"的正则（如切 H2 时，要能识别 # 和 ### 之类）
 * @param prefix  想要设置的最终前缀（含尾部空格，如 "## "）
 *
 * 规则：
 *   - 若行首已是目标前缀 → 去除（toggle）
 *   - 若行首是其他 matcher 之一 → 替换为目标前缀
 *   - 否则 → 加上目标前缀
 */
export function toggleLinePrefix(
  view: EditorView,
  prefix: string,
  matchers: RegExp[],
): boolean {
  const doc = view.state.doc;
  const changes: { from: number; to: number; insert: string }[] = [];

  for (const range of view.state.selection.ranges) {
    const lines = linesInRange(view, range);
    for (const line of lines) {
      const text = line.text;
      let handled = false;
      for (const m of matchers) {
        const match = text.match(m);
        if (match) {
          const matchedPrefix = match[0];
          if (matchedPrefix === prefix) {
            // 去除
            changes.push({ from: line.from, to: line.from + matchedPrefix.length, insert: "" });
          } else {
            // 替换为目标前缀
            changes.push({ from: line.from, to: line.from + matchedPrefix.length, insert: prefix });
          }
          handled = true;
          break;
        }
      }
      if (!handled) {
        // 新增目标前缀
        changes.push({ from: line.from, to: line.from, insert: prefix });
      }
    }
  }

  if (changes.length === 0) return false;
  view.dispatch({ changes });
  focus(view);
  return true;
}

/** 标题 */
export function toggleHeading(view: EditorView, level: 1 | 2 | 3 | 4 | 5 | 6): boolean {
  const prefix = "#".repeat(level) + " ";
  return toggleLinePrefix(view, prefix, [/^#{1,6}\s+/]);
}

/** 无序列表 */
export function toggleBulletList(view: EditorView): boolean {
  return toggleLinePrefix(view, "- ", [/^[-*+]\s+/, /^\d+\.\s+/, /^- \[[ xX]\]\s+/]);
}

/** 有序列表（简化：统一用 1.） */
export function toggleOrderedList(view: EditorView): boolean {
  return toggleLinePrefix(view, "1. ", [/^\d+\.\s+/, /^[-*+]\s+/, /^- \[[ xX]\]\s+/]);
}

/** 任务列表 */
export function toggleTaskList(view: EditorView): boolean {
  return toggleLinePrefix(view, "- [ ] ", [/^- \[[ xX]\]\s+/, /^[-*+]\s+/, /^\d+\.\s+/]);
}

/** 引用 */
export function toggleBlockquote(view: EditorView): boolean {
  return toggleLinePrefix(view, "> ", [/^>\s+/]);
}

// ---------------------------------------------------------------------------
// 块级插入（代码块 / 分割线 / 表格）
// ---------------------------------------------------------------------------

/** 在光标所在位置插入一个独立代码块（前后保留空行） */
export function toggleCodeBlock(view: EditorView): boolean {
  const doc = view.state.doc;
  const range = view.state.selection.main;
  const { first, last } = lineRangeOfSelection(view, range);

  // 如果首末行都是围栏代码块的起/止 → 取消围栏
  if (first.text.startsWith("```") && last.text.startsWith("```") && first.number !== last.number) {
    const fromLine = first;
    const toLine = last;
    view.dispatch({
      changes: [
        { from: toLine.from, to: toLine.to + 1 > doc.length ? toLine.to : toLine.to + 1, insert: "" },
        { from: fromLine.from, to: fromLine.to + 1, insert: "" },
      ],
    });
    focus(view);
    return true;
  }

  const selectedText = doc.sliceString(range.from, range.to);
  const needsBlank = first.from > 0 && doc.lineAt(first.from - 1).text !== "";
  const prefix = needsBlank ? "\n" : "";
  const insert = `${prefix}\`\`\`\n${selectedText}\n\`\`\`\n`;

  view.dispatch({
    changes: { from: first.from, to: last.to, insert },
    selection: EditorSelection.cursor(
      first.from + prefix.length + 4, // "```\n" = 4 字符，光标放代码内起点
    ),
  });
  focus(view);
  return true;
}

/** 行内代码 */
export function toggleInlineCode(view: EditorView): boolean {
  return toggleWrap(view, "`");
}

/** 分割线 */
export function insertHorizontalRule(view: EditorView): boolean {
  const doc = view.state.doc;
  const range = view.state.selection.main;
  const line = doc.lineAt(range.from);
  const atLineStart = range.from === line.from;
  const prefix = atLineStart ? "" : "\n";
  const text = `${prefix}\n---\n\n`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + text.length),
  });
  focus(view);
  return true;
}

/** 在光标处插入 3x3 GFM 表格 */
export function insertTable(view: EditorView, rows = 3, cols = 3): boolean {
  const header = "| " + Array.from({ length: cols }, (_, i) => `列${i + 1}`).join(" | ") + " |";
  const divider = "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |";
  const body = Array.from({ length: rows - 1 }, () =>
    "| " + Array.from({ length: cols }, () => "   ").join(" | ") + " |",
  ).join("\n");
  const table = `\n${header}\n${divider}\n${body}\n\n`;

  const doc = view.state.doc;
  const range = view.state.selection.main;
  const line = doc.lineAt(range.from);
  const atLineStart = range.from === line.from;
  const insert = atLineStart ? table.slice(1) : table;

  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    // 光标放到首个单元格
    selection: EditorSelection.cursor(range.from + insert.indexOf("列1") + 0),
  });
  focus(view);
  return true;
}

// ---------------------------------------------------------------------------
// 链接 / 图片
// ---------------------------------------------------------------------------

/**
 * 插入链接：
 *   - 有选区 → 把选区文本作为 label
 *   - 无选区 → label 留空，生成 `[](url)`
 *
 * 历史问题：之前无选区时硬塞了一个写死的 "链接" 两字作为 label，
 * 用户每次插完都得自己删掉再敲名称。改成空 label 后：
 *   - 鼠标点链接按钮 → 直接得到 `[](https://)`，光标默认落在 url 上方便粘贴；
 *     用户粘完 url 自然会回到 [] 内补 label，或者干脆就保持空（多数 md
 *     渲染器会用 url 当显示文字）。
 *   - 显式传 text="xxx" 的调用方（如附件上传）行为不变。
 */
export function insertLink(view: EditorView, url = "https://", text?: string): boolean {
  const doc = view.state.doc;
  const range = view.state.selection.main;
  const selectedText = doc.sliceString(range.from, range.to);
  // 关键：未提供 text 且无选区时，label 留空，避免硬塞"链接"两字
  const label = text ?? selectedText;
  const insert = `[${label}](${url})`;
  // 选中 url 部分，方便用户直接粘贴/替换
  const urlStart = range.from + label.length + 2; // 跨过 "[label]("
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + url.length),
  });
  focus(view);
  return true;
}

/** 在光标处插入图片语法（src 为 data URL 或网络 URL） */
export function insertImage(view: EditorView, src: string, alt = ""): boolean {
  const doc = view.state.doc;
  const range = view.state.selection.main;
  const line = doc.lineAt(range.from);
  const atLineStart = range.from === line.from;
  const needsTrailingNewline = range.to === doc.length || doc.lineAt(range.to).text !== "";
  const prefix = atLineStart ? "" : "\n";
  const suffix = needsTrailingNewline ? "\n" : "";
  const insert = `${prefix}![${alt}](${src})${suffix}`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + insert.length),
  });
  focus(view);
  return true;
}

// ---------------------------------------------------------------------------
// AI 辅助：光标处插入 / 选区替换
// ---------------------------------------------------------------------------

/** 在当前选区位置插入/替换文本（AI 助手用） */
export function replaceSelection(view: EditorView, text: string): boolean {
  const range = view.state.selection.main;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert: text },
    selection: EditorSelection.cursor(range.from + text.length),
  });
  focus(view);
  return true;
}
