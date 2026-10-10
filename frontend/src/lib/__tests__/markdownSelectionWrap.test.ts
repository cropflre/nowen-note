import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import {
  MARKDOWN_SELECTION_WRAP_DELIMITERS,
  createMarkdownSelectionWrapSpec,
} from "@/lib/markdownSelectionWrap";

function applyWrap(
  doc: string,
  anchor: number,
  head: number,
  delimiter: string,
) {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
  });
  const spec = createMarkdownSelectionWrapSpec(state, delimiter);
  if (!spec) return null;
  return state.update(spec).state;
}

describe("markdownSelectionWrap", () => {
  it.each(MARKDOWN_SELECTION_WRAP_DELIMITERS)(
    "wraps selected text with %s and keeps the inner text selected",
    (delimiter) => {
      const next = applyWrap("hello", 0, 5, delimiter);

      expect(next?.doc.toString()).toBe(`${delimiter}hello${delimiter}`);
      expect(next?.selection.main.from).toBe(1);
      expect(next?.selection.main.to).toBe(6);
    },
  );

  it("preserves a reverse selection after wrapping", () => {
    const next = applyWrap("hello", 5, 0, "*");

    expect(next?.doc.toString()).toBe("*hello*");
    expect(next?.selection.main.anchor).toBe(6);
    expect(next?.selection.main.head).toBe(1);
  });

  it("does not intercept normal typing when there is no selected text", () => {
    const state = EditorState.create({
      doc: "hello",
      selection: EditorSelection.cursor(5),
    });

    expect(createMarkdownSelectionWrapSpec(state, "*")).toBeNull();
  });

  it("ignores characters outside the Markdown wrapping contract", () => {
    const state = EditorState.create({
      doc: "hello",
      selection: EditorSelection.single(0, 5),
    });

    expect(createMarkdownSelectionWrapSpec(state, "(")).toBeNull();
    expect(createMarkdownSelectionWrapSpec(state, "'")).toBeNull();
  });

  it("wraps every selected range in a multi-selection transaction", () => {
    const state = EditorState.create({
      doc: "hello world",
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(6, 11),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const spec = createMarkdownSelectionWrapSpec(state, "*");
    expect(spec).not.toBeNull();
    const next = state.update(spec!).state;

    expect(next.doc.toString()).toBe("*hello* *world*");
    expect(next.selection.ranges).toHaveLength(2);
    expect(next.selection.ranges[0].from).toBe(1);
    expect(next.selection.ranges[0].to).toBe(6);
    expect(next.selection.ranges[1].from).toBe(9);
    expect(next.selection.ranges[1].to).toBe(14);
  });

  it("keeps typed delimiters literal at empty secondary cursors", () => {
    const state = EditorState.create({
      doc: "hello world",
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.cursor(6),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    const spec = createMarkdownSelectionWrapSpec(state, "$");
    expect(spec).not.toBeNull();
    const next = state.update(spec!).state;

    expect(next.doc.toString()).toBe("$hello$ $world");
    expect(next.selection.ranges).toHaveLength(2);
    expect(next.selection.ranges[0].from).toBe(1);
    expect(next.selection.ranges[0].to).toBe(6);
    expect(next.selection.ranges[1].empty).toBe(true);
    expect(next.selection.ranges[1].head).toBe(9);
  });

  it("wraps existing Markdown instead of toggling it off", () => {
    const next = applyWrap("*hello*", 0, 7, "*");

    expect(next?.doc.toString()).toBe("**hello**");
    expect(next?.selection.main.from).toBe(1);
    expect(next?.selection.main.to).toBe(8);
  });
});
