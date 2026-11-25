import type { EditorState, Transaction } from "@tiptap/pm/state";

/**
 * 富文本正文的 Tab 缩进（Issue #915：Tab 键 = 4 个空格）。
 *
 * 插入的是不间断空格（U+00A0）而不是普通空格：笔记每次打开都会经过
 * JSON → HTML → JSON 的 schema 修复，HTML 导出和 Markdown 转换也会折叠普通空格，
 * 普通空格的缩进在重新打开后就消失了；不间断空格在这些路径中原样保留，
 * Markdown 也不会把它识别成缩进代码块。
 */
export const TAB_SPACE_COUNT = 4;
export const TAB_SPACES = "\u00a0".repeat(TAB_SPACE_COUNT);

type Dispatch = ((tr: Transaction) => void) | undefined;

/** 每个行内叶子节点（图片、公式等）占 1 个位置，用 1 个占位字符保证偏移与文档位置一致。 */
const LEAF_PLACEHOLDER = "\ufffc";

function editableTextblock(state: EditorState) {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  const parent = $from.parent;
  // 代码块有自己的缩进规则（插入普通空格），不在这里处理。
  if (!parent.isTextblock || parent.type.spec.code) return null;
  return $from;
}

/** 没有选区且光标在正文文本块内时，在光标处插入 4 个空格。 */
export function insertTabSpaces(state: EditorState, dispatch?: Dispatch): boolean {
  if (!editableTextblock(state)) return false;
  dispatch?.(state.tr.insertText(TAB_SPACES).scrollIntoView());
  return true;
}

/**
 * Shift+Tab：优先删除光标前连续的不间断空格（最多 4 个，即撤回一次 Tab）；
 * 否则删除段首最多 4 个空格。都没有时返回 false，由调用方决定后续行为。
 */
export function removeTabSpaces(state: EditorState, dispatch?: Dispatch): boolean {
  const $from = editableTextblock(state);
  if (!$from) return false;
  const parent = $from.parent;
  const offset = $from.parentOffset;

  const before = parent.textBetween(Math.max(0, offset - TAB_SPACE_COUNT), offset, undefined, LEAF_PLACEHOLDER);
  const trailing = /\u00a0+$/.exec(before)?.[0].length ?? 0;
  if (trailing > 0) {
    dispatch?.(state.tr.delete($from.pos - trailing, $from.pos).scrollIntoView());
    return true;
  }

  const head = parent.textBetween(0, Math.min(TAB_SPACE_COUNT, parent.content.size), undefined, LEAF_PLACEHOLDER);
  const leading = /^[\u00a0 ]+/.exec(head)?.[0].length ?? 0;
  if (leading > 0) {
    const start = $from.start();
    dispatch?.(state.tr.delete(start, start + leading).scrollIntoView());
    return true;
  }
  return false;
}
