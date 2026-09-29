import { createRoot, type Root } from "react-dom/client";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { isolateHistory } from "@codemirror/commands";
import { EditorState, StateField, Transaction } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";
import { CodeBlockFormatButton } from "@/components/CodeBlockFormatButton";
import { CodeBlockFormatError, formatCodeBlock } from "@/lib/codeBlockFormatting";
import { isMatchingFenceClosing, parseMarkdownFenceOpening } from "@/lib/markdownFenceAuthoring";

function fencedRanges(markdown: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  markdownLanguage.parser.parse(markdown).iterate({ enter(node) {
    if (node.name === "FencedCode") ranges.push({ from: node.from, to: node.to });
  } });
  return ranges;
}

/** Preview preprocessing changes offsets; match by fence order, never by repeated code text. */
export function resolveMarkdownCodeBlockSource(source: string, rendered: string, offset: number): number {
  const original = fencedRanges(source);
  const preview = fencedRanges(rendered);
  const index = preview.findIndex((range) => offset >= range.from && offset < range.to);
  if (index < 0 || original.length !== preview.length) throw new CodeBlockFormatError("changed");
  return original[index].from;
}

export function isMarkdownFormattingEditable(view: EditorView): boolean {
  return view.dom.isConnected && view.state.facet(EditorView.editable) && !view.state.facet(EditorState.readOnly);
}

export async function formatMarkdownCodeBlock(view: EditorView, source: string, offset: number, sourceOffset = 0): Promise<void> {
  if (!isMarkdownFormattingEditable(view)) throw new CodeBlockFormatError("readOnly");
  if (view.state.doc.sliceString(sourceOffset, sourceOffset + source.length) !== source) {
    throw new CodeBlockFormatError("changed");
  }
  const range = fencedRanges(source).find((block) => offset >= block.from && offset < block.to);
  if (!range) throw new CodeBlockFormatError("changed");
  const lineStart = source.lastIndexOf("\n", range.from - 1) + 1;
  const bodyStart = source.indexOf("\n", range.from) + 1;
  const closingStart = source.lastIndexOf("\n", range.to - 1) + 1;
  const opening = parseMarkdownFenceOpening(source.slice(lineStart, bodyStart - 1))
    || parseMarkdownFenceOpening(source.slice(range.from, bodyStart - 1));
  // A list's opening line includes its bullet; subsequent lines use the closing line's indent.
  const closing = parseMarkdownFenceOpening(source.slice(closingStart, range.to));
  if (opening && closing) opening.prefix = closing.prefix;
  if (!opening || bodyStart <= 0 || closingStart < bodyStart
    || !isMatchingFenceClosing(source.slice(closingStart, range.to), opening)) {
    throw new CodeBlockFormatError("changed");
  }
  if (closingStart === bodyStart) return;
  const body = source.slice(bodyStart, closingStart - 1);
  const lines = body.split("\n");
  if (lines.some((line) => !line.startsWith(opening.prefix))) throw new CodeBlockFormatError("changed");
  const code = lines.map((line) => line.slice(opening.prefix.length)).join("\n");
  const originalDoc = view.state.doc;
  const formatted = await formatCodeBlock(code, opening.language);
  if (!isMarkdownFormattingEditable(view)) throw new CodeBlockFormatError("readOnly");
  if (view.state.doc !== originalDoc) throw new CodeBlockFormatError("changed");
  if (formatted === code) return;
  const insert = formatted.split("\n").map((line) => opening.prefix + line).join("\n");
  if (insert.split("\n").some((line) => isMatchingFenceClosing(line, opening))) {
    throw new CodeBlockFormatError("invalid");
  }
  view.dispatch({
    changes: { from: sourceOffset + bodyStart, to: sourceOffset + closingStart - 1, insert },
    annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.format")],
  });
}

const roots = new WeakMap<HTMLElement, Root>();
class FormatFenceWidget extends WidgetType {
  constructor(readonly from: number, readonly language: string) { super(); }
  eq(other: FormatFenceWidget) { return this.from === other.from && this.language === other.language; }
  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("span");
    host.className = "cm-nowen-fence-format";
    host.contentEditable = "false";
    const root = createRoot(host);
    roots.set(host, root);
    root.render(<CodeBlockFormatButton language={this.language}
      onFormat={() => formatMarkdownCodeBlock(view, view.state.doc.toString(), this.from)} />);
    return host;
  }
  destroy(dom: HTMLElement) {
    const root = roots.get(dom);
    roots.delete(dom);
    queueMicrotask(() => root?.unmount());
  }
  ignoreEvent() { return true; }
}

function activeFormatButtons(state: EditorState): DecorationSet {
  if (state.doc.length > 350_000 || !state.facet(EditorView.editable) || state.facet(EditorState.readOnly)) return Decoration.none;
  const ranges: ReturnType<Decoration["range"]>[] = [];
  syntaxTree(state).iterate({ enter(node) {
    if (node.name !== "FencedCode" || !state.selection.ranges.some((selection) => selection.head >= node.from && selection.head <= node.to)) return;
    const line = state.doc.lineAt(node.from);
    const opening = parseMarkdownFenceOpening(line.text) || parseMarkdownFenceOpening(line.text.slice(node.from - line.from));
    if (!opening) return;
    ranges.push(Decoration.line({ class: "cm-nowen-fence-format-line" }).range(line.from));
    ranges.push(Decoration.widget({ widget: new FormatFenceWidget(node.from, opening.language), side: 1 }).range(line.to));
  } });
  return Decoration.set(ranges, true);
}

const formatButtons = StateField.define<DecorationSet>({
  create: activeFormatButtons,
  update(value, tr) {
    return tr.docChanged || tr.reconfigured || !tr.startState.selection.eq(tr.state.selection) ? activeFormatButtons(tr.state) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const markdownCodeBlockFormattingExtension = [formatButtons, EditorView.theme({
  ".cm-nowen-fence-format-line": { position: "relative", paddingRight: "90px" },
  ".cm-nowen-fence-format": { position: "absolute", right: "6px", top: "0", fontFamily: "ui-sans-serif, system-ui, sans-serif" },
  ".cm-nowen-fence-format-line.cm-nowen-fence-opening::after": { right: "90px" },
})];
