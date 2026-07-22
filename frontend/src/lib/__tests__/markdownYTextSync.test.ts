import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyCodeMirrorChangesToYText,
  collectCodeMirrorTextChanges,
  yTextDeltaToCodeMirrorChanges,
} from "@/lib/markdownYTextSync";

function applyChanges(documentText: string, changes: Array<{ from: number; to: number; insert: string }>) {
  const state = EditorState.create({ doc: documentText });
  return state.update({ changes }).newDoc.toString();
}

describe("incremental Markdown Y.Text synchronization", () => {
  it("applies multiple local CodeMirror ranges without replacing the full Y.Text", () => {
    const source = "alpha beta gamma";
    const state = EditorState.create({ doc: source });
    const transaction = state.update({
      changes: [
        { from: 0, to: 5, insert: "ALPHA" },
        { from: 11, to: 16, insert: "GAMMA" },
      ],
    });

    const yDoc = new Y.Doc();
    const yText = yDoc.getText("content");
    yText.insert(0, source);
    const origin = {};
    let observedOrigin: unknown;
    yText.observe((event) => {
      observedOrigin = event.transaction.origin;
    });

    expect(collectCodeMirrorTextChanges(transaction.changes)).toEqual([
      { from: 0, to: 5, insert: "ALPHA" },
      { from: 11, to: 16, insert: "GAMMA" },
    ]);
    expect(applyCodeMirrorChangesToYText({
      changes: transaction.changes,
      yDoc,
      yText,
      origin,
    })).toBe(2);
    expect(yText.toString()).toBe(transaction.newDoc.toString());
    expect(observedOrigin).toBe(origin);
  });

  it("coalesces remote delete and insert deltas into CodeMirror replacements", () => {
    const source = "alpha beta gamma";
    const changes = yTextDeltaToCodeMirrorChanges([
      { retain: 6 },
      { delete: 4 },
      { insert: "brave" },
      { retain: 1 },
      { delete: 5 },
      { insert: "GAMMA" },
    ]);

    expect(changes).toEqual([
      { from: 6, to: 10, insert: "brave" },
      { from: 11, to: 16, insert: "GAMMA" },
    ]);
    expect(applyChanges(source, changes || [])).toBe("alpha brave GAMMA");
  });

  it("supports insertion-only and deletion-only remote deltas", () => {
    expect(yTextDeltaToCodeMirrorChanges([
      { retain: 2 },
      { insert: "🙂" },
      { retain: 2 },
    ])).toEqual([{ from: 2, to: 2, insert: "🙂" }]);

    expect(yTextDeltaToCodeMirrorChanges([
      { retain: 1 },
      { delete: 2 },
    ])).toEqual([{ from: 1, to: 3, insert: "" }]);
  });

  it("rejects embedded Y.Text values so callers can use the full-string fallback", () => {
    expect(yTextDeltaToCodeMirrorChanges([
      { retain: 1 },
      { insert: { attachmentId: "file-1" } },
    ])).toBeNull();
  });
});
