import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Hono } from "hono";

import { getDb } from "../src/db/schema.ts";
import {
  buildMarkdownSplitDirectory,
  planMarkdownNoteSplit,
  validateMarkdownSplitPlan,
} from "../src/lib/noteSplit.ts";
import { installNoteSplitRoutes } from "../src/runtime/note-split.ts";

function stripRuntimeBlockIds(markdown: string): string {
  return markdown
    .replace(/\s+\^blk_[A-Za-z0-9_-]{6,}\s*$/gm, "")
    .replace(/^\^blk_[A-Za-z0-9_-]{6,}\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

test("splits exact H1 boundaries and preserves the preamble", () => {
  const source = [
    "Intro paragraph.",
    "",
    "# Alpha",
    "Alpha body",
    "## Nested",
    "nested body",
    "# Beta",
    "Beta body",
  ].join("\n");
  const plan = planMarkdownNoteSplit(source, 1);
  assert.equal(plan.preamble, "Intro paragraph.");
  assert.deepEqual(plan.sections.map((section) => section.title), ["Alpha", "Beta"]);
  assert.match(plan.sections[0].content, /## Nested/);
  assert.equal(validateMarkdownSplitPlan(plan), null);
});

test("ignores heading-shaped lines inside fenced code blocks", () => {
  const source = [
    "# One",
    "```md",
    "# not a section",
    "```",
    "# Two",
  ].join("\n");
  const plan = planMarkdownNoteSplit(source, 1);
  assert.deepEqual(plan.sections.map((section) => section.title), ["One", "Two"]);
  assert.match(plan.sections[0].content, /# not a section/);
});

test("uses exact H2 boundaries instead of flattening H1 headings", () => {
  const source = [
    "# Book",
    "intro",
    "## Chapter A",
    "A",
    "## Chapter B",
    "B",
  ].join("\n");
  const plan = planMarkdownNoteSplit(source, 2);
  assert.equal(plan.preamble, "# Book\nintro");
  assert.deepEqual(plan.sections.map((section) => section.title), ["Chapter A", "Chapter B"]);
});

test("builds a directory with stable note ids and escaped aliases", () => {
  const directory = buildMarkdownSplitDirectory({
    sourceTitle: "Book",
    operationId: "op-1",
    headingLevel: 1,
    preamble: "Intro",
    preservePreamble: true,
    sections: [
      { id: "note-a", title: "Alpha | A" },
      { id: "note-b", title: "Beta ] B" },
    ],
  });
  assert.match(directory, /Intro/);
  assert.match(directory, /nowen-note-split:op-1/);
  assert.match(directory, /\[\[note-a\|Alpha ｜ A\]\]/);
  assert.match(directory, /\[\[note-b\|Beta ］ B\]\]/);
});

test("requires at least two sections", () => {
  const plan = planMarkdownNoteSplit("# Only\nbody", 1);
  assert.equal(validateMarkdownSplitPlan(plan), "至少需要两个同级标题才能拆分");
});

test("transactionally splits, shares attachment bytes, inherits tags and restores on undo", async () => {
  const db = getDb();
  const userId = crypto.randomUUID();
  const notebookId = crypto.randomUUID();
  const noteId = crypto.randomUUID();
  const tagId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const source = [
    "Preface",
    "",
    "# Alpha",
    `![shared](/api/attachments/${attachmentId})`,
    "Alpha body",
    "# Beta",
    `![shared again](/api/attachments/${attachmentId})`,
    "Beta body",
  ].join("\n");

  db.prepare("INSERT INTO users (id, username, passwordHash) VALUES (?, ?, ?)")
    .run(userId, `split-${userId}`, "test");
  db.prepare("INSERT INTO notebooks (id, userId, name) VALUES (?, ?, ?)")
    .run(notebookId, userId, "Split Test");
  db.prepare(`
    INSERT INTO notes (id, userId, notebookId, title, content, contentText, contentFormat)
    VALUES (?, ?, ?, ?, ?, ?, 'markdown')
  `).run(noteId, userId, notebookId, "Book", source, source);
  db.prepare("INSERT INTO tags (id, userId, name) VALUES (?, ?, ?)")
    .run(tagId, userId, `tag-${tagId}`);
  db.prepare("INSERT INTO note_tags (noteId, tagId) VALUES (?, ?)").run(noteId, tagId);
  db.prepare(`
    INSERT INTO attachments (id, noteId, userId, filename, mimeType, size, path)
    VALUES (?, ?, ?, 'shared.png', 'image/png', 12, 'shared-test.png')
  `).run(attachmentId, noteId, userId);

  const app = new Hono();
  installNoteSplitRoutes(app);
  const splitResponse = await app.request(`/${noteId}/split`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-User-Id": userId,
    },
    body: JSON.stringify({ version: 1, headingLevel: 1, preservePreamble: true }),
  });
  assert.equal(splitResponse.status, 201);
  const splitResult = await splitResponse.json() as {
    operationId: string;
    sourceNote: { content: string; version: number };
    createdNotes: Array<{ id: string; title: string; content: string }>;
  };
  assert.equal(splitResult.createdNotes.length, 2);
  assert.equal(splitResult.sourceNote.version, 2);
  assert.match(splitResult.sourceNote.content, /## 目录/);
  assert.match(splitResult.sourceNote.content, /Preface/);

  const childIds = splitResult.createdNotes.map((note) => note.id);
  const childTags = db.prepare(
    `SELECT noteId, tagId FROM note_tags WHERE noteId IN (?, ?) ORDER BY noteId`,
  ).all(...childIds) as Array<{ noteId: string; tagId: string }>;
  assert.equal(childTags.length, 2);
  assert.ok(childTags.every((row) => row.tagId === tagId));

  const attachmentRows = db.prepare(`
    SELECT id, noteId, path FROM attachments
    WHERE noteId IN (?, ?)
    ORDER BY id
  `).all(...childIds) as Array<{ id: string; noteId: string; path: string }>;
  assert.equal(attachmentRows.length, 2);
  assert.ok(attachmentRows.some((row) => row.id === attachmentId));
  assert.ok(attachmentRows.every((row) => row.path === "shared-test.png"));
  assert.notEqual(splitResult.createdNotes[0].content, splitResult.createdNotes[1].content);

  const undoResponse = await app.request(
    `/${noteId}/split/${splitResult.operationId}/undo`,
    { method: "POST", headers: { "X-User-Id": userId } },
  );
  assert.equal(undoResponse.status, 200);
  const undoResult = await undoResponse.json() as {
    sourceNote: { content: string; version: number };
    removedNoteIds: string[];
  };
  assert.equal(stripRuntimeBlockIds(undoResult.sourceNote.content), source);
  assert.equal(undoResult.sourceNote.version, 3);
  assert.deepEqual(new Set(undoResult.removedNoteIds), new Set(childIds));

  const remainingChildren = db.prepare(
    "SELECT COUNT(*) AS count FROM notes WHERE id IN (?, ?)",
  ).get(...childIds) as { count: number };
  assert.equal(remainingChildren.count, 0);
  const restoredAttachment = db.prepare(
    "SELECT id, noteId, path FROM attachments WHERE id = ?",
  ).get(attachmentId) as { id: string; noteId: string; path: string };
  assert.equal(restoredAttachment.noteId, noteId);
  assert.equal(restoredAttachment.path, "shared-test.png");
  const attachmentCount = db.prepare(
    "SELECT COUNT(*) AS count FROM attachments WHERE path = 'shared-test.png'",
  ).get() as { count: number };
  assert.equal(attachmentCount.count, 1);
});
