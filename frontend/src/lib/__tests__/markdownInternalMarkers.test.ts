// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { internalMarkdownMarkerExtensions } from "@/lib/markdownInternalMarkers";

const HEADING_ID = "blk_11111111-1111-4111-8111-111111111111";

describe("internal Markdown marker input", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.innerHTML = "";
  });

  it("keeps typing before a hidden heading marker after server normalization", () => {
    const source = `# Test ^${HEADING_ID}`;
    const state = EditorState.create({
      doc: source,
      selection: EditorSelection.cursor(source.length),
      extensions: internalMarkdownMarkerExtensions,
    });
    view = new EditorView({ state, parent: document.body });

    const handled = view.state.facet(EditorView.inputHandler).some((handler) => handler(
      view!,
      source.length,
      source.length,
      "T",
      () => view!.state.update({
        changes: { from: source.length, insert: "T" },
        selection: { anchor: source.length + 1 },
      }),
    ));

    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe(`# TestT ^${HEADING_ID}`);
    expect(view.state.selection.main.head).toBe("# TestT".length);
  });
});
