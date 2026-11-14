import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type Database from "better-sqlite3";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nowen-md-structures-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");
process.env.ELECTRON_USER_DATA = tmpDir;

let db: Database.Database;
let closeDb: () => void;
let noteBlocks: typeof import("../src/lib/noteBlocks");
let blockPatch: typeof import("../src/lib/markdownBlockPatch");
let noteLinks: typeof import("../src/lib/noteLinks");

test.before(async () => {
  const [schema, blocks, patch, links] = await Promise.all([
    import("../src/db/schema"), import("../src/lib/noteBlocks"), import("../src/lib/markdownBlockPatch"), import("../src/lib/noteLinks"),
  ]);
  db = schema.getDb(); closeDb = schema.closeDb; noteBlocks = blocks; blockPatch = patch; noteLinks = links;
  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES ('md-user', 'md-user', 'hash')").run();
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES ('md-book', 'md-user', 'Structures')").run();
});

test.after(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Saves a Markdown note through the block model, the same path every note save takes. */
function save(content: string) {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat, version) VALUES (?, 'md-user', 'md-book', 'T', ?, '', 'markdown', 1)").run(id, content);
  const first = noteBlocks.syncNoteBlocks(db, id, content, "markdown");
  const stored = (db.prepare("SELECT content FROM notes WHERE id = ?").get(id) as { content: string }).content;
  assert.equal(stored, first.content);
  // Saving the result again must not move or add markers.
  assert.equal(noteBlocks.syncNoteBlocks(db, id, first.content, "markdown").content, first.content);
  return first;
}

test("GFM tables are one block whose ID ends the last row", () => {
  const result = save("Intro\n\n| H1 | H2 |\n| --- | --- |\n| a \\| b | `x` |\n\nOutro");
  const table = result.blocks.find((block) => block.blockType === "table");
  assert.ok(table);
  // GFM ignores the extra cell the marker forms, the same form the editor writes when converting to Markdown
  assert.equal(result.content, `Intro ^${result.blocks[0].blockId}\n\n| H1 | H2 |\n| --- | --- |\n| a \\| b | \`x\` | ^${table.blockId}\n\nOutro ^${result.blocks[2].blockId}`);
  assert.equal(table.plainText, "H1 H2 a | b `x`");
  const parsed = blockPatch.parseMarkdownPatchDocument(result.content);
  assert.equal(parsed.blocks.find((block) => block.blockId === table.blockId)?.content, "| H1 | H2 |\n| --- | --- |\n| a \\| b | `x` |");
});

test("existing table IDs are kept as written", () => {
  const content = "| H1 | H2 |\n| --- | --- |\n| a | b | ^blk_tableown01";
  const result = save(content);
  assert.equal(result.content, content);
  assert.deepEqual(result.blocks.map((block) => [block.blockType, block.blockId, block.plainText]), [["table", "blk_tableown01", "H1 H2 a b"]]);
});

test("a header-only table gets no marker, since its delimiter row cannot carry one", () => {
  const result = save("| H1 | H2 |\n| --- | --- |\n\nAfter");
  const [table, after] = result.blocks;
  assert.deepEqual(result.blocks.map((block) => [block.blockType, block.plainText]), [["table", "H1 H2"], ["paragraph", "After"]]);
  assert.equal(result.content, `| H1 | H2 |\n| --- | --- |\n\nAfter ^${after.blockId}`);
  // Without a marker the ID is kept by content, like any block whose marker is missing
  assert.equal(noteBlocks.syncNoteBlocks(db, table.noteId, result.content, "markdown").blocks[0].blockId, table.blockId);
  // A block patch reads it as part of the next marked block, and fails closed when nothing follows
  assert.equal(blockPatch.parseMarkdownPatchDocument(result.content).blocks[0].content, "| H1 | H2 |\n| --- | --- |\n\nAfter");
  assert.throws(() => blockPatch.parseMarkdownPatchDocument(`After ^${after.blockId}\n\n| H1 | H2 |\n| --- | --- |`), { code: "INVALID_MARKDOWN_DOCUMENT" });
});

test("thematic breaks get no marker and setext headings keep their underline", () => {
  const breaks = save("First\n\n---\n\nSecond\n\n***\n\n- - -\n\nThird");
  const [first, second, third] = breaks.blocks.map((block) => block.blockId);
  assert.equal(breaks.blocks.length, 3);
  assert.equal(breaks.content, `First ^${first}\n\n---\n\nSecond ^${second}\n\n***\n\n- - -\n\nThird ^${third}`);
  const headings = save("Title\n===\n\nSub\n---\n\nBody");
  assert.deepEqual(headings.blocks.map((block) => [block.blockType, block.plainText]), [["heading", "Title"], ["heading", "Sub"], ["paragraph", "Body"]]);
  const [title, sub, body] = headings.blocks.map((block) => block.blockId);
  assert.equal(headings.content, `Title ^${title}\n===\n\nSub ^${sub}\n---\n\nBody ^${body}`);
});

test("multi-line HTML blocks stay whole and never receive markers inside", () => {
  const code = '<pre data-title="demo.js"><code class="language-js">const a = 1;\n\nconst b = 2;</code></pre>';
  const result = save(`${code}\n\nAfter`);
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].blockType, "codeBlock");
  // The ID goes on its own line after the closing tag: block patches treat the closing line as inside the HTML.
  assert.equal(result.content, `${code}\n^${result.blocks[0].blockId}\n\nAfter ^${result.blocks[1].blockId}`);
  assert.equal(blockPatch.parseMarkdownPatchDocument(result.content).blocks[0].content, code);
});

test("HTML blocks reuse the ID carried in their data-block-id attribute", () => {
  const aligned = '<p style="text-align:center" data-block-id="blk_center001">Body</p>';
  const titled = '<pre data-title="t" data-block-id="blk_code00001"><code>x</code></pre>';
  const table = '<table data-block-id="blk_table0002"><tbody><tr><td><p>x</p></td></tr></tbody></table>';
  const result = save([aligned, titled, table].join("\n\n"));
  assert.equal(result.content, `${aligned} ^blk_center001\n\n${titled} ^blk_code00001\n\n${table} ^blk_table0002`);
  assert.deepEqual(result.blocks.map((block) => [block.blockType, block.blockId]), [["paragraph", "blk_center001"], ["codeBlock", "blk_code00001"], ["table", "blk_table0002"]]);
});

test("a multi-line HTML block keeps its ID when its content changes", () => {
  for (const block of ["<details>\n<summary>More</summary>\nold\n</details>", '<pre data-title="t"><code>old\n\nline</code></pre>']) {
    const before = save(`${block}\n\nAfter`);
    const [html] = before.blocks;
    assert.ok(before.content.startsWith(`${block}\n^${html.blockId}\n\n`));
    const edited = before.content.replace("old", "new");
    const after = noteBlocks.syncNoteBlocks(db, html.noteId, edited, "markdown");
    assert.equal(after.content, edited);
    assert.equal(after.blocks[0].blockId, html.blockId);
  }
});

test("ordered list items with a ) delimiter are list items", () => {
  // The editor alternates . and ) so that adjacent ordered lists stay apart
  const result = save("1. one\n2. two\n\n1) again");
  assert.deepEqual(result.blocks.map((block) => [block.blockType, block.plainText]), [["listItem", "one"], ["listItem", "two"], ["listItem", "again"]]);
  const [one, two, again] = result.blocks.map((block) => block.blockId);
  assert.equal(result.content, `1. one ^${one}\n2. two ^${two}\n\n1) again ^${again}`);
  // Links are attributed to the item they appear in, as with "." items
  const first = "11111111-2222-4333-8444-555555555555", second = "99999999-2222-4333-8444-555555555555";
  const links = noteLinks.extractNoteLinksFromContent(`1) see [[note:${first}]] ^blk_olsrc0001\n2) and [[note:${second}]] ^blk_olsrc0002`);
  assert.deepEqual(links.map((link) => [link.targetNoteId, link.sourceBlockId]), [[first, "blk_olsrc0001"], [second, "blk_olsrc0002"]]);
});
