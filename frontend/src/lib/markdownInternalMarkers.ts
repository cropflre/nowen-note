import { RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  findInternalMarkdownMarkerRanges,
  projectMarkdownForUser,
  sanitizeMarkdownClipboardText,
} from "@/lib/markdownUserContent";

function buildMarkerDecorations(markdown: string): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const range of findInternalMarkdownMarkerRanges(markdown)) {
    if (range.kind === "line") {
      builder.add(
        range.from,
        range.from,
        Decoration.line({ attributes: { class: "cm-nowen-internal-block-marker-line" } }),
      );
    } else {
      builder.add(range.from, range.to, Decoration.replace({}));
    }
  }
  return builder.finish();
}

const markerField = StateField.define<DecorationSet>({
  create(state) {
    return buildMarkerDecorations(state.doc.toString());
  },
  update(value, transaction) {
    return transaction.docChanged
      ? buildMarkerDecorations(transaction.state.doc.toString())
      : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const markerTheme = EditorView.baseTheme({
  ".cm-nowen-internal-block-marker-line": {
    display: "none",
  },
});

const cleanClipboard = EditorView.domEventHandlers({
  copy(event, view) {
    if (!event.clipboardData || view.state.selection.ranges.every((range) => range.empty)) {
      return false;
    }
    const selected = view.state.selection.ranges
      .map((range) => view.state.doc.sliceString(range.from, range.to))
      .join("\n");
    event.clipboardData.setData("text/plain", sanitizeMarkdownClipboardText(projectMarkdownForUser(selected)));
    event.preventDefault();
    return true;
  },
  paste(event, view) {
    if (!event.clipboardData) return false;
    const pasted = event.clipboardData.getData("text/plain");
    const sanitized = sanitizeMarkdownClipboardText(pasted);
    if (sanitized === pasted) return false;
    event.preventDefault();
    view.dispatch(view.state.replaceSelection(sanitized));
    return true;
  },
});

export const internalMarkdownMarkerExtensions: Extension[] = [
  markerField,
  markerTheme,
  cleanClipboard,
];
