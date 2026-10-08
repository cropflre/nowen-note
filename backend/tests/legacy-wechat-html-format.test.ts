import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isLegacyWeChatHtmlImport } from "../src/lib/legacyWeChatHtmlFormat";

const html = '<blockquote><p>作者：示例 · 来源：<a href="https://mp.weixin.qq.com/s/abc">https://mp.weixin.qq.com/s/abc</a></p></blockquote><section><img src="/api/attachments/5bc403c1-2c1f-4541-ba2a-c8e9ab1b5fbd"></section>';

test("recognizes only old URL-import HTML stored under Tiptap's default format", () => {
  assert.equal(isLegacyWeChatHtmlImport(html, "tiptap-json"), true);
  assert.equal(isLegacyWeChatHtmlImport(html, "html"), false);
  assert.equal(isLegacyWeChatHtmlImport(JSON.stringify({ type: "doc", content: [] }), "tiptap-json"), false);
  assert.equal(isLegacyWeChatHtmlImport('<p>来源：<a href="https://mp.weixin.qq.com/s/abc">link</a></p>', "tiptap-json"), false);
  assert.equal(isLegacyWeChatHtmlImport('<blockquote><p>来源：<a href="https://untrusted.example/s/abc">link</a></p></blockquote>', "tiptap-json"), false);
});

test("the URL-import route writes correct HTML metadata and note GET repairs the legacy marker", () => {
  const importSource = readFileSync(new URL("../src/routes/url-import.ts", import.meta.url), "utf8");
  const getSource = readFileSync(new URL("../src/routes/notes.ts", import.meta.url), "utf8");
  assert.match(importSource, /INSERT INTO notes \(id, userId, notebookId, title, content, contentText, contentFormat, createdAt/);
  assert.match(importSource, /VALUES \(\?, \?, \?, \?, \?, \?, 'html', \?, \?, \?\)/);
  const legacyCheck = getSource.indexOf("isLegacyWeChatHtmlImport(note.content, note.contentFormat)");
  const readRepair = getSource.indexOf("readAuthoritativeNoteContent(db, id, note.content)");
  assert.ok(legacyCheck >= 0 && legacyCheck < readRepair);
  assert.match(getSource, /UPDATE notes SET contentFormat = 'html'/);
});
