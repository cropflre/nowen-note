import {
  EditorSelection,
  type EditorState,
  Prec,
  Transaction,
  type Extension,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Markdown delimiters that should wrap an existing text selection when typed.
 *
 * Empty selections deliberately fall through to CodeMirror's normal input handling,
 * so typing `*`, `_`, `~`, `$` or a backtick without selecting text still inserts
 * exactly the character the user typed.
 */
export const MARKDOWN_SELECTION_WRAP_DELIMITERS = ["`", "*", "_", "~", "$"] as const;

type MarkdownSelectionWrapDelimiter = (typeof MARKDOWN_SELECTION_WRAP_DELIMITERS)[number];

const MARKDOWN_SELECTION_WRAP_DELIMITER_SET = new Set<string>(MARKDOWN_SELECTION_WRAP_DELIMITERS);

export function isMarkdownSelectionWrapDelimiter(value: string): value is MarkdownSelectionWrapDelimiter {
  return MARKDOWN_SELECTION_WRAP_DELIMITER_SET.has(value);
}

/**
 * Build the CodeMirror transaction for wrapping selected Markdown text.
 *
 * The selected text remains selected after the delimiters are inserted, matching the
 * existing bracket-pair experience. Multiple selections are supported; an empty
 * secondary cursor receives the literal delimiter just like normal multi-cursor input.
 */
export function createMarkdownSelectionWrapSpec(
  state: EditorState,
  delimiter: string,
): TransactionSpec | null {
  if (!isMarkdownSelectionWrapDelimiter(delimiter)) return null;
  if (state.selection.ranges.every((range) => range.empty)) return null;

  return state.changeByRange((range) => {
    if (range.empty) {
      return {
        changes: { from: range.from, insert: delimiter },
        range: EditorSelection.cursor(range.from + delimiter.length),
      };
    }

    const selected = state.doc.sliceString(range.from, range.to);
    const innerFrom = range.from + delimiter.length;
    const innerTo = innerFrom + selected.length;
    const reversed = range.anchor > range.head;

    return {
      changes: {
        from: range.from,
        to: range.to,
        insert: `${delimiter}${selected}${delimiter}`,
      },
      range: reversed
        ? EditorSelection.range(innerTo, innerFrom)
        : EditorSelection.range(innerFrom, innerTo),
    };
  });
}

/**
 * Highest-precedence CodeMirror input handler for Markdown selection wrapping.
 *
 * Using the editor's native text-input pipeline rather than a raw keydown listener keeps
 * the behavior aligned with CodeMirror across keyboard layouts and IME/browser input.
 * Clipboard paste/drop continue through CodeMirror's dedicated clipboard path and are
 * therefore not treated as a typed delimiter.
 */
export const markdownSelectionWrapExtension: Extension = Prec.highest(
  EditorView.inputHandler.of((view, _from, _to, text) => {
    if (!isMarkdownSelectionWrapDelimiter(text)) return false;
    if (!view.state.facet(EditorView.editable)) return false;

    const transaction = createMarkdownSelectionWrapSpec(view.state, text);
    if (!transaction) return false;

    view.dispatch(transaction, {
      annotations: Transaction.userEvent.of("input.type"),
      scrollIntoView: true,
    });
    return true;
  }),
);
