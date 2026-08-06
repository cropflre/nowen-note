import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  extractSearchableText,
  getSearchIndexRebuiltAt,
  inspectSearchContentText,
  markSearchIndexRebuilt,
  repairLegacyMarkdownBlockMetadata,
  repairSearchContentText,
} from "../src/lib/searchIndex";

const LEGACY_BLOCK_ID = "blk4e38ed87e6734393a537ba817a91e00f";

test("extractSearchableText handles Markdown, Tiptap JSON and HTML on the server", () => {
  assert.match(
    extractSearchableText("# 标题\n\n正文唯一词", "markdown"),
    /正文唯一词/,
  );

  const tiptap = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "callout",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "自定义节点唯一词" }] },
        ],
      },
    ],
  });
  assert.match(extractSearchableText(tiptap, "tiptap-json"), /自定义节点唯一词/);

  assert.equal(
    extractSearchableText("<style>.x{}</style><h1>HTML 标题</h1><p>HTML 正文</p>", "html"),
    "HTML 标题 HTML 正文",
  );
});

test("extractSearchableText strips legacy compact block metadata", () => {
  const extracted = extractSearchableText([
    "# 活性碳酸钙",
    `^${LEGACY_BLOCK_ID}`,
    "前置说明",
  ].join("\n"), "markdown");

  assert.match(extracted, /活性碳酸钙/);
  assert.match(extracted, /前置说明/);
  assert.doesNotMatch(extracted, /blk4e38/);
});

test("extractSearchableText does not duplicate nested table and list text", () => {
  const tiptap = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "table",
        content: [{
          type: "tableRow",
          content: [{
            type: "tableCell",
            content: [{ type: "paragraph", content: [{ type: "text", text: "租赁合同" }] }],
          }],
        }],
      },
      {
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "合同期限" }] }],
        }],
      },
    ],
  });

  assert.equal(
    extractSearchableText(tiptap, "tiptap-json"),
    "租赁合同\n\n合同期限",
  );
});

test("repairLegacyMarkdownBlockMetadata upgrades historical Markdown and block index", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      content TEXT,
      contentText TEXT,
      contentFormat TEXT
    );
  `);
  db.prepare(
    "INSERT INTO notes (id, content, contentText, contentFormat) VALUES (?, ?, ?, ?)",
  ).run(
    "legacy",
    ["# 标题", `^${LEGACY_BLOCK_ID}`, "前置说明"].join("\n"),
    `标题 ${LEGACY_BLOCK_ID} 前置说明`,
    "markdown",
  );

  assert.equal(repairLegacyMarkdownBlockMetadata(db), 1);
  assert.equal(repairLegacyMarkdownBlockMetadata(db), 0);

  const row = db.prepare("SELECT content, contentText FROM notes WHERE id = 'legacy'").get() as {
    content: string;
    contentText: string;
  };
  assert.doesNotMatch(row.content, /blk4e38/);
  assert.match(row.content, /\^blk_[0-9a-f-]+/i);
  assert.doesNotMatch(row.contentText, /blk4e38/);
  assert.match(row.contentText, /前置说明/);

  const blocks = db.prepare(
    "SELECT plainText FROM note_blocks_index WHERE noteId = 'legacy' ORDER BY blockOrder",
  ).all() as Array<{ plainText: string }>;
  assert.equal(blocks.some((block) => block.plainText.includes("blk4e38")), false);
  db.close();
});

test("repairSearchContentText fixes empty and stale historical rows without touching valid rows", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      content TEXT,
      contentText TEXT,
      contentFormat TEXT
    );
    CREATE TABLE system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const insert = db.prepare(
    "INSERT INTO notes (id, content, contentText, contentFormat) VALUES (?, ?, ?, ?)",
  );
  insert.run("empty", "# 历史笔记\n\n空索引唯一词", "", "markdown");
  insert.run("stale", "<p>新正文唯一词</p>", "旧正文", "html");
  insert.run("valid", "# 正常\n\n保持不变", "正常\n\n保持不变", "markdown");

  const before = inspectSearchContentText(db);
  assert.equal(before.noteCount, 3);
  assert.equal(before.emptyContentTextCount, 1);
  assert.equal(before.staleContentTextCount, 2);

  const repaired = repairSearchContentText(db);
  assert.equal(repaired.repairedCount, 2);
  assert.equal(repaired.staleContentTextCount, 0);

  const rows = db.prepare("SELECT id, contentText FROM notes ORDER BY id").all() as Array<{
    id: string;
    contentText: string;
  }>;
  assert.match(rows.find((row) => row.id === "empty")?.contentText || "", /空索引唯一词/);
  assert.equal(rows.find((row) => row.id === "stale")?.contentText, "新正文唯一词");
  assert.equal(rows.find((row) => row.id === "valid")?.contentText, "正常\n\n保持不变");

  const rebuiltAt = "2026-07-20T12:00:00.000Z";
  markSearchIndexRebuilt(db, rebuiltAt);
  assert.equal(getSearchIndexRebuiltAt(db), rebuiltAt);
  db.close();
});
