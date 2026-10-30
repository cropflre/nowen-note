import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { detectFormat } from "@/lib/contentFormat";

const editorPaneSource = readFileSync(
  path.resolve(__dirname, "../EditorPane.tsx"),
  "utf8",
);
const useYDocSource = readFileSync(
  path.resolve(__dirname, "../../hooks/useYDoc.ts"),
  "utf8",
);

// Execute the actual render gates without mounting the editor's unrelated services.
// AST extraction tolerates formatting and additional safety conditions.
function previewGate(name: string, context: Record<string, unknown>): unknown {
  const source = ts.createSourceFile("EditorPane.tsx", editorPaneSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      const names = ts.isArrayBindingPattern(node.name)
        ? node.name.elements.filter(ts.isBindingElement).map((element) => element.name.getText(source))
        : [node.name.getText(source)];
      if (names.includes(name)) expression = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!expression) throw new Error(`Missing preview gate: ${name}`);
  const code = name === "htmlPreviewMode" && ts.isCallExpression(expression)
    ? `(${expression.arguments[0].getText(source)})()`
    : expression.getText(source);
  return runInNewContext(code, { detectFormat, ...context });
}

describe("EditorPane native Markdown collaboration", () => {
  it("keeps normal saves active until the CRDT document has synced", () => {
    expect(useYDocSource).toContain(
      "doc: initialSynced ? doc : null",
    );
    expect(useYDocSource).toContain('{ ...prev, doc, status: "synced", synced: true }');

    const start = editorPaneSource.indexOf('activeNote.contentFormat === "markdown"');
    const end = editorPaneSource.indexOf(") : shouldRenderHtmlPreview", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(editorPaneSource.slice(start, end)).toContain(
      "key={collabYDoc ? `md-native-y-${activeNote.id}` : `md-native-${activeNote.id}`}",
    );
    expect(editorPaneSource.slice(start, end)).toContain("yDoc={collabYDoc}");
  });
  it("renders clipped HTML in preview on the first frame and while switching notes", () => {
    const activeNote = { id: "html-note", contentFormat: "markdown", content: "<html><body>Clipped page</body></html>" };
    expect(previewGate("htmlPreviewMode", { activeNote })).toBe(true);
    const pending = previewGate("isPendingHtmlNoteSwitch", { activeNote, previewInitializedNoteIdRef: { current: "previous-note" } });
    expect(pending).toBe(true);
    expect(previewGate("shouldRenderHtmlPreview", { activeNote, htmlPreviewMode: false, isPendingHtmlNoteSwitch: pending })).toBe(true);
    expect(previewGate("isPendingHtmlNoteSwitch", { activeNote, previewInitializedNoteIdRef: { current: activeNote.id } })).toBe(false);
    const previewCondition = editorPaneSource.indexOf(") : shouldRenderHtmlPreview ? (");
    const previewComponent = editorPaneSource.indexOf("<HtmlPreviewPane", previewCondition);
    const fallbackTiptap = editorPaneSource.indexOf("<TiptapEditor", previewCondition);
    expect(previewCondition).toBeGreaterThan(-1);
    expect(previewComponent).toBeGreaterThan(previewCondition);
    expect(fallbackTiptap).toBeGreaterThan(previewComponent);
  });

  it("keeps plaintext containing HTML in its own editor even when the previous note was a preview", () => {
    const activeNote = { id: "plain-note", contentFormat: "plaintext", content: "<html><body>Literal source text</body></html>" };
    expect(previewGate("htmlPreviewMode", { activeNote })).toBe(false);
    expect(previewGate("htmlPreviewMode", { activeNote: null })).toBe(false);
    expect(previewGate("isPendingHtmlNoteSwitch", { activeNote, previewInitializedNoteIdRef: { current: "previous-note" } })).toBe(false);
    expect(previewGate("shouldRenderHtmlPreview", { activeNote, htmlPreviewMode: true, isPendingHtmlNoteSwitch: false })).toBe(false);
  });

});
