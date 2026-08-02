import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editorPaneSource = readFileSync(
  path.resolve(__dirname, "../EditorPane.tsx"),
  "utf8",
);

describe("EditorPane native Markdown collaboration", () => {
  it("remounts the editor when the CRDT document becomes available", () => {
    const start = editorPaneSource.indexOf('activeNote.contentFormat === "markdown"');
    const end = editorPaneSource.indexOf(") : htmlPreviewMode", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(editorPaneSource.slice(start, end)).toContain(
      "key={collabYDoc ? `md-native-y-${activeNote.id}` : `md-native-${activeNote.id}`}",
    );
  });
});
