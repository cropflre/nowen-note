import { RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import {
  findInternalMarkdownMarkerRanges,
  projectMarkdownForUser,
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
    event.clipboardData.setData("text/plain", projectMarkdownForUser(selected));
    event.preventDefault();
    return true;
  },
});

export const internalMarkdownMarkerExtensions: Extension[] = [
  markerField,
  markerTheme,
  cleanClipboard,
];
