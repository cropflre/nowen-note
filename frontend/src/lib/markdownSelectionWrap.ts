import {
  EditorSelection,
  type EditorState,
  Prec,
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

function hasShortcutModifier(event: KeyboardEvent): boolean {
  const altGraph = event.getModifierState?.("AltGraph") === true;
  if (event.metaKey) return true;
  if (altGraph) return false;
  return event.ctrlKey || event.altKey;
}

/**
 * Highest-precedence key handler so Markdown delimiters get a chance to wrap selected
 * text before CodeMirror's close-brackets/default keymaps replace the selection.
 */
export const markdownSelectionWrapExtension: Extension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (event.isComposing || hasShortcutModifier(event)) return false;
      if (!isMarkdownSelectionWrapDelimiter(event.key)) return false;
      if (!view.state.facet(EditorView.editable)) return false;

      const transaction = createMarkdownSelectionWrapSpec(view.state, event.key);
      if (!transaction) return false;

      event.preventDefault();
      view.dispatch(transaction);
      return true;
    },
  }),
);
