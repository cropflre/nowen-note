import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editorPaneSource = readFileSync(
  path.resolve(__dirname, "../EditorPane.tsx"),
  "utf8",
);
const useYDocSource = readFileSync(
  path.resolve(__dirname, "../../hooks/useYDoc.ts"),
  "utf8",
);

describe("EditorPane native Markdown collaboration", () => {
  it("keeps normal saves active until the CRDT document has synced", () => {
    expect(useYDocSource).toContain(
      "doc: initialSynced ? doc : null",
    );
    expect(useYDocSource).toContain('{ ...prev, doc, status: "synced", synced: true }');

    const start = editorPaneSource.indexOf('activeNote.contentFormat === "markdown"');
    const end = editorPaneSource.indexOf(") : htmlPreviewMode", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(editorPaneSource.slice(start, end)).toContain(
      "key={collabYDoc ? `md-native-y-${activeNote.id}` : `md-native-${activeNote.id}`}",
    );
    expect(editorPaneSource.slice(start, end)).toContain("yDoc={collabYDoc}");
  });
});
