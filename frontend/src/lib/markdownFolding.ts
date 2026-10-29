import { EditorState, type Extension } from "@codemirror/state";
import { foldGutter, foldKeymap, foldedRanges, unfoldEffect } from "@codemirror/language";
import { EditorView, keymap } from "@codemirror/view";

const foldingTheme = EditorView.baseTheme({
  ".cm-foldGutter .cm-gutterElement": { padding: "0" },
  ".cm-foldGutter span": {
    display: "inline-block",
    width: "24px",
    padding: "0",
    textAlign: "center",
    borderRadius: "4px",
  },
  ".cm-foldGutter span:hover": {
    backgroundColor: "var(--color-hover, rgba(128, 128, 128, 0.12))",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "transparent",
    borderColor: "currentColor",
    color: "inherit",
  },
});

/** Folding is editor view state only; Markdown and collaborative content stay unchanged. */
export function markdownFolding(language?: string): Extension {
  return [
    foldGutter(),
    keymap.of(foldKeymap),
    foldingTheme,
    // Native folding only reveals selections whose head is strictly inside a fold.
    // A search match ending exactly at the fold boundary must also become visible.
    EditorState.transactionExtender.of((transaction) => {
      if (!transaction.isUserEvent("select.search")) return null;
      const effects: ReturnType<typeof unfoldEffect.of>[] = [];
      for (const selection of transaction.state.selection.ranges) {
        foldedRanges(transaction.state).between(selection.from, selection.to, (from, to) => {
          if (from < selection.to && to > selection.from) effects.push(unfoldEffect.of({ from, to }));
        });
      }
      return effects.length ? { effects } : null;
    }),
    EditorState.phrases.of((language || "").toLowerCase().startsWith("zh") ? {
      "Fold line": "折叠章节或内容块",
      "Unfold line": "展开章节或内容块",
      "Folded lines": "已折叠行",
      "Unfolded lines": "已展开行",
      to: "至",
      unfold: "展开",
      "folded code": "已折叠内容",
    } : {}),
  ];
}
