import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { diagnoseTiptapContent } from "../src/lib/tiptap-note-format";

test("recognizes valid and structurally invalid Tiptap documents", () => {
  assert.equal(diagnoseTiptapContent(JSON.stringify({ type: "doc", content: [] })), "valid");
  assert.equal(diagnoseTiptapContent(JSON.stringify({ type: "doc", content: [{ type: "paragraph" }] })), "valid");
  assert.equal(diagnoseTiptapContent("{}"), "invalid-doc");
  assert.equal(diagnoseTiptapContent("null"), "invalid-doc");
  assert.equal(diagnoseTiptapContent('{"type":"doc","content":"text"}'), "invalid-doc");
});

test("distinguishes historic HTML and malformed JSON without changing data", () => {
  const html = " <blockquote><p>historic note</p></blockquote>";
  assert.equal(diagnoseTiptapContent(html), "html-markup");
  assert.equal(diagnoseTiptapContent("<section><h1>hello</h1></section>"), "html-markup");
  assert.equal(diagnoseTiptapContent('{"type":'), "invalid-json");
  assert.equal(diagnoseTiptapContent("plaintext"), "invalid-json");
  assert.equal(html, " <blockquote><p>historic note</p></blockquote>");
});

test("read repair guards malformed Tiptap input before attempting block rebuild", () => {
  const source = readFileSync(new URL("../src/routes/notes.ts", import.meta.url), "utf8");
  const diagnosis = source.indexOf('const formatDiagnosis = note.contentFormat === "tiptap-json"');
  const guard = source.indexOf('if (selected.shouldRepair && formatDiagnosis !== "valid")');
  const rebuild = source.indexOf('rebuildBlockAuthorityStore(db, id, note.content, note.contentFormat, {');
  assert.ok(diagnosis >= 0 && guard > diagnosis && rebuild > guard);
});
