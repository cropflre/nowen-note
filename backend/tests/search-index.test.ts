import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  extractSearchableText,
  getSearchIndexRebuiltAt,
  inspectSearchContentText,
  markSearchIndexRebuilt,
  repairSearchContentText,
} from "../src/lib/searchIndex";

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
